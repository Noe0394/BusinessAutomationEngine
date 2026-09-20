const llmFallbackEngine = require('../lib/ai/llmFallbackEngine');
const { createHumanContextEngine } = require('../lib/intelligence/human-context-engine');
const personaManager = require('./personaManager');
const offerClarifier = require('./offerClarifier');
const storageAdapter = require('./storageAdapter');
const platformOrchestrator = require('./platformOrchestrator');
const contactCrm = require('./contactCrm');
const conversationEngine = require('./jarvis/conversationEngine');

// MOTEUR DE CLOSING HUMANISÉ ET ÉMOTIONNEL — ai-engine/emotionalCloser.js
// ---------------------------------------------------------------------------
// Répond aux messages entrants d'un PROSPECT/CLIENT final (WhatsApp/Telegram,
// jamais l'admin/vendeur — voir ai-engine/personaManager.js pour la voix
// côté vendeur) avec la posture d'un conseiller-vendeur empathique.
//
// NE RÉINVENTE PAS l'analyse émotionnelle : lib/intelligence/human-context-engine.js
// a déjà un moteur complet (analyzeMessage : sentiment/intention/objection/
// hésitation/urgence/confiance ; selectStrategy : registre d'objections
// PRICE/TRUST/TIME + BUY/DECLINE/frustration, avec angle et objectif par
// stratégie). Ce module réutilise CES DEUX fonctions telles quelles, mais
// n'utilise PAS generateFollowUp()/decide() pour composer la réponse finale :
// leurs templates (`{valeur1}`, `{avantage1}`...) ne sont jamais remplis par
// des faits réels dans ce moteur — ici, la RÉDACTION finale passe par un
// appel LLM guidé par l'angle/objectif de la stratégie ET par les VRAIS
// faits business (offre, prix, plafond de remise, paiement) plutôt que par
// un gabarit à trous.
const humanContext = createHumanContextEngine();

const NAMESPACE = 'closer_sessions';

function sanitize(id) {
  return String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'unknown';
}
function sessionDocId(tenantId, channel, from) {
  return `${sanitize(tenantId)}__${sanitize(channel)}__${sanitize(from)}`;
}

async function getSession(tenantId, channel, from) {
  return storageAdapter.get(NAMESPACE, sessionDocId(tenantId, channel, from), {
    tenantId, channel, from, history: [], escalated: false, awaitingFeedback: false, updatedAt: null,
  });
}
function saveSession(tenantId, channel, from, session) {
  session.updatedAt = new Date().toISOString();
  return storageAdapter.set(NAMESPACE, sessionDocId(tenantId, channel, from), session);
}

// §2 "Alertes de Relais" — signal explicite (B2B, gros volume, demande sur
// mesure) OU signal faible détecté par human-context-engine.detectIntuition
// (intérêt élevé + forte hésitation persistante — voir INTEREST_HESITATION_GAP).
// Volontairement une LISTE COURTE et précise plutôt qu'un lexique large : une
// escalade ratée à tort (main reprise par le vendeur alors que pas
// nécessaire) coûte peu ; une escalade manquée (agent qui continue à
// négocier seul un gros client) coûte beaucoup plus.
const HIGH_VALUE_RE = /(gros\s+client|entreprise|soci[ée]t[ée]|\bb2b\b|en\s+gros|grande\s+quantit[ée]|sur\s+mesure|personnalis[ée]e?|cas\s+particulier|budget\s+cons[ée]quent|plusieurs\s+(millions|centaines\s+de\s+mille))/i;

function shouldEscalate(text, analysis, session) {
  if (HIGH_VALUE_RE.test(String(text || ''))) return 'HIGH_VALUE_SIGNAL';
  const intuition = humanContext.detectIntuition({ analysis, history: session.history || [] });
  if (intuition.intuition === 'CAUTION' && intuition.clues.includes('INTEREST_HESITATION_GAP')) return 'PERSISTENT_HESITATION';
  return null;
}

// Faits réels injectés dans le prompt de closing — jamais inventés (même
// philosophie que ai-engine/offerClarifier.js). `product` (facultatif,
// deviné depuis le fil) permet de cibler l'offre la plus pertinente parmi
// plusieurs déjà clarifiées ; sans correspondance, on fournit la plus
// récente à titre de contexte général.
function buildBusinessFacts(businessProfile) {
  const offers = businessProfile.offers || [];
  if (!offers.length) return { facts: 'Aucune offre précise n\'est encore configurée côté vendeur — reste généraliste, ne mentionne AUCUN prix ni AUCUNE caractéristique inventée.', offer: null };
  const offer = offers[offers.length - 1];
  const parts = [`Offre : ${offer.name || offer.category}.`];
  if (offer.description) parts.push(`Description : ${offer.description}.`);
  if (offer.price) parts.push(`Prix : ${offer.price}.`);
  if (offer.options) parts.push(`Options : ${offer.options}.`);
  if (offer.delivery) parts.push(`Livraison : ${offer.delivery}.`);
  if (offer.duration) parts.push(`Durée : ${offer.duration}.`);
  if (offer.learningOutcome) parts.push(`Ce que l'élève apprend : ${offer.learningOutcome}.`);
  if (offer.format) parts.push(`Format de délivrance : ${offer.format}.`);
  const maxDiscount = parseFloat(process.env.MAX_DISCOUNT_PERCENT) || 15;
  parts.push(`Remise maximale autorisée par le vendeur : ${maxDiscount}% (ne jamais promettre plus).`);
  const paymentConfigured = ['MOBILE_MONEY_ORANGE', 'MOBILE_MONEY_MTN', 'MOBILE_MONEY_MOOV', 'MOBILE_MONEY_WAVE'].some((k) => !!process.env[k]);
  parts.push(paymentConfigured ? 'Un moyen de paiement Mobile Money est disponible pour finaliser.' : 'Aucun moyen de paiement n\'est encore configuré — ne promets pas de lien de paiement immédiat.');
  return { facts: parts.join(' '), offer };
}

async function composeClosingReply({ text, history, analysis, strategy, facts, domain, directives }) {
  const prompt = [
    personaManager.personaSystemPrompt(domain),
    'Tu es EN CONVERSATION DIRECTE avec un PROSPECT/CLIENT final sur WhatsApp/Telegram (pas le vendeur) — posture de Conseiller-Vendeur empathique et persuasif (Closer), jamais un bot de support froid ni scolaire.',
    `Message du client : "${text}"`,
    `Profil émotionnel détecté : intention=${analysis.intent}, sentiment=${analysis.sentiment}, intérêt=${analysis.interest}, objection probable=${analysis.objection_primary}, hésitation=${analysis.hesitation}/1, confiance=${analysis.trust}/1, émotion dominante=${analysis.dominant_emotion}.`,
    `Axe de réponse recommandé (guide, pas un texte à recopier) : ${strategy.goal}`,
    `Faits réels sur l'offre (n'invente RIEN au-delà) : ${facts}`,
    'Écoute active : reformule brièvement ce que tu comprends de sa situation/douleur AVANT de répondre à l\'objection ou de relancer.',
    'Termine par un appel à l\'action doux mais assertif qui fait avancer vers l\'étape suivante — jamais "voulez-vous acheter ?", plutôt un choix concret (ex: "on valide maintenant ou tu as une dernière question ?").',
    directives && directives.length ? `CONSIGNES DE CONVERSATION (OBLIGATOIRES, prioritaires sur l'appel à l'action ci-dessus) :\n- ${directives.join('\n- ')}` : '',
  ].filter(Boolean).join('\n');
  const { text: reply } = await llmFallbackEngine.generateAIResponse(prompt, history);
  return reply.trim();
}

// §2 — collecte de feedback quand un prospect décline définitivement. La
// question elle-même est composée via personaManager (chaleureuse, jamais
// insistante) ; la RÉPONSE du client au tour suivant est capturée telle
// quelle (pas d'extraction/résumé supplémentaire — fidèle au mot du client)
// et ajoutée au profil business pour remontée au vendeur.
async function recordFeedback(tenantId, feedbackText) {
  const profile = await offerClarifier.getBusinessProfile(tenantId);
  profile.feedback = Array.isArray(profile.feedback) ? profile.feedback : [];
  profile.feedback.push({ text: String(feedbackText).trim().slice(0, 500), at: new Date().toISOString() });
  profile.feedback = profile.feedback.slice(-50); // garde-fou anti-croissance illimitée
  storageAdapter.set('business_profiles', tenantId, profile);
  return profile.feedback.length;
}

// ---------------------------------------------------------------------------
// Point d'entrée — appelé par index.js#handleIncomingCustomerMessage pour
// tout message classé 'business' par lib/intelligence/message-triage.js,
// UNIQUEMENT si AUTO_CLOSE_PROSPECTS=true (jamais par défaut — même prudence
// que AUTO_ANSWER_STUDENT_QUERIES, voir index.js). Retourne `null` si rien
// ne doit être envoyé (prospect déjà escaladé à un humain).
// ---------------------------------------------------------------------------
async function handleCustomerMessage({ tenantId, channel, from, text }) {
  const session = await getSession(tenantId, channel, from);

  // Prospect déjà remonté au vendeur (§2 Alertes de Relais) : l'agent ne
  // reprend JAMAIS la main tout seul — seule une action manuelle du vendeur
  // (hors scope de ce module) devrait un jour permettre de désescalader.
  if (session.escalated) return null;

  const businessProfile = await offerClarifier.getBusinessProfile(tenantId);
  const domain = personaManager.inferDomain(businessProfile);

  // Le client répond à la question de feedback posée au tour précédent
  // (voir plus bas, intent DECLINE) — capturé tel quel, puis remonté.
  if (session.awaitingFeedback) {
    session.awaitingFeedback = false;
    await saveSession(tenantId, channel, from, session);
    const count = await recordFeedback(tenantId, text);
    platformOrchestrator.notifyTenantChat(
      tenantId,
      `💡 Un prospect a partagé un axe d'amélioration : "${text}"`,
      [{ icon: '💡', label: `Feedback #${count} enregistré`, status: 'done' }],
    ).catch((err) => console.error('emotionalCloser — échec de remontée du feedback :', err.message));
    const thanks = await personaManager.rephrase({
      kind: 'declined', rawText: 'Remercie sincèrement le client pour son retour honnête, sans relancer la vente.', domain,
    });
    return thanks;
  }

  const analysis = humanContext.analyzeMessage(text, { context: {} });
  if (analysis.error) return null; // texte vide/illisible : rien à répondre.

  session.history = Array.isArray(session.history) ? session.history : [];
  session.history.push(humanContext.snapshot(analysis));
  session.history = session.history.slice(-20); // garde-fou anti-croissance illimitée

  const escalationReason = shouldEscalate(text, analysis, session);
  if (escalationReason) {
    session.escalated = true;
    await saveSession(tenantId, channel, from, session);
    const label = channel === 'TELEGRAM' ? 'Telegram' : 'WhatsApp';
    platformOrchestrator.notifyTenantChat(
      tenantId,
      `🔥 Prospect chaud à haute valeur sur ${label} (${from}) — ${escalationReason === 'HIGH_VALUE_SIGNAL' ? 'signal d\'un besoin sur mesure/volume important' : 'hésitation persistante malgré un intérêt élevé'}. Tu veux reprendre la main ?`,
      [{ icon: '🔥', label: `Escalade prospect ${from}`, status: 'warning' }],
    ).catch((err) => console.error('emotionalCloser — échec de notification d\'escalade :', err.message));
    return 'Je transmets votre demande directement à notre équipe pour un suivi personnalisé — on revient vers vous très vite !';
  }

  await saveSession(tenantId, channel, from, session);

  // Refus, répétition, NO_ACTION, montants : décidés par le moteur Jarvis
  // (même logique que l'auto-réponse), l'IA ne fait que rédiger.
  const strategy = humanContext.selectStrategy(analysis);
  const { facts } = buildBusinessFacts(businessProfile);
  const out = await conversationEngine.handleBatch({ tenantId, channel, from, items: [{ text }] }, {
    crm: contactCrm,
    knownText: facts,
    compose: (directives, ctx) => composeClosingReply({ text: ctx.text, history: [], analysis, strategy, facts, domain, directives }),
    send: async () => ({ status: 'SUCCESS' }), // l'envoi réel est fait par l'appelant (index.js)
    notify: (msg) => platformOrchestrator.notifyTenantChat(tenantId, `⚠️ ${msg}`, [{ icon: '⚠️', label: 'Conversation à traiter', status: 'warning' }]),
  }).catch((err) => {
    console.warn('emotionalCloser — moteur Jarvis indisponible, repli sur le gabarit de stratégie :', err.message);
    return { action: 'REPLY', text: humanContext.generateFollowUp(analysis, strategy, { first_name: '' }) || 'Merci pour votre message, je reviens vers vous très vite !' };
  });
  return out.action === 'REPLY' ? out.text : null;
}

module.exports = { handleCustomerMessage, shouldEscalate, buildBusinessFacts };
