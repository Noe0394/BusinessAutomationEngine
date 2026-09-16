// AUTO-RESPONDER — ai-engine/autoResponder.js
// ---------------------------------------------------------------------------
// AUTONOMIE CONVERSATIONNELLE (priorité absolue du cahier des charges) : quand
// elle est activée pour un compte, CYRUS tient la conversation TOUT SEUL à
// chaque message entrant, sans que l'admin rouvre le Chat Intelligent.
//
// Chaîne réelle par message entrant :
//   idempotence (messageId) -> mémoire (historique du contact) -> IA (persona
//   + contexte métier RÉEL) -> envoi VÉRIFIÉ (runtime.sendMessageVerified,
//   identifiant réel) -> sauvegarde -> attente du prochain message.
//
// Sûreté : l'auto-réponse est CONVERSATIONNELLE/INFORMATIVE (répondre, informer,
// engager, citer les vrais prix). Elle ne DÉCLENCHE JAMAIS d'action à risque
// (paiement, déblocage d'accès) automatiquement — ces actions restent sous
// confirmation de l'admin. Désactivée par défaut (opt-in par compte + canal).

const llmFallbackEngine = require('../lib/ai/llmFallbackEngine');
const personaManager = require('./personaManager');
const businessServices = require('./businessServices');
const messageHistory = require('./messageHistory');
const storageAdapter = require('./storageAdapter');

const SETTINGS_NS = 'auto_settings';

// Déduplication en mémoire par tenant (Baileys/Telegram peuvent redélivrer le
// même message ; on ne répond qu'UNE fois). Borné pour ne pas fuir en mémoire.
const processed = new Map(); // tenant -> Set(messageId)
function markProcessed(tenant, id) {
  if (!id) return false; // sans id, on ne peut pas dédupliquer — on laisse passer
  let set = processed.get(tenant);
  if (!set) { set = new Set(); processed.set(tenant, set); }
  if (set.has(id)) return true; // déjà traité
  set.add(id);
  if (set.size > 3000) { const first = set.values().next().value; set.delete(first); }
  return false;
}

function sanitizeTenant(t) { return String(t || '').trim().replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown'; }

async function getSettings(tenant) {
  return storageAdapter.get(SETTINGS_NS, sanitizeTenant(tenant), { tenant: sanitizeTenant(tenant), whatsapp: false, telegram: false });
}
async function setSettings(tenant, patch) {
  const cur = await getSettings(tenant);
  const next = Object.assign({}, cur, patch || {}, { tenant: sanitizeTenant(tenant), updatedAt: new Date().toISOString() });
  storageAdapter.set(SETTINGS_NS, sanitizeTenant(tenant), next);
  return next;
}
function isEnabled(settings, channel) {
  return String(channel).toUpperCase() === 'TELEGRAM' ? !!(settings && settings.telegram) : !!(settings && settings.whatsapp);
}

// Rédige la réponse au client, EN S'APPUYANT sur le contexte métier réel
// (produits/prix/règles des Services Métiers) et l'historique de la conversation.
async function composeReply({ tenant, channel, from, name, text, llm }) {
  // Appel IA tagué (AI Cost Guard) : purpose 'client_conversation' + tenant,
  // pour la ventilation des coûts IA par fonctionnalité et par compte.
  const gen = typeof llm === 'function' ? llm : (p) => llmFallbackEngine.generateAIResponse(p, [], null, undefined, null, { purpose: 'client_conversation', tenant }).then((r) => r.text);
  const bizCtx = await businessServices.getEngineContextText(tenant).catch(() => '');
  let history = '';
  try {
    const conv = await messageHistory.getConversation(tenant, channel, from, 12);
    if (conv && conv.length) history = conv.map((m) => `${m.direction === 'in' ? 'Client' : 'Moi'}: ${m.text}`).join('\n');
  } catch (e) { history = ''; }
  const prompt = [
    personaManager.personaSystemPrompt('default'),
    'Tu réponds DIRECTEMENT à un client/prospect qui vient d\'écrire au vendeur — tu réponds EN SON NOM, comme le vendeur lui-même. Sois chaleureux, humain et utile.',
    bizCtx
      ? `Informations RÉELLES de l'activité (produits, prix, règles — SEULE source autorisée, n'invente jamais au-delà de ceci) :\n${bizCtx}`
      : 'AUCUNE offre n\'est configurée pour ce vendeur. Tu ne connais donc PAS ses produits, services, prix ni domaine d\'activité.',
    history ? `Historique récent avec ce client :\n${history}` : '',
    `Nouveau message du client ${name ? '(' + name + ')' : ''} : "${text}"`,
    // Garde-fou anti-invention RENFORCÉ (un vrai client est en face) :
    'RÈGLE ABSOLUE : n\'invente JAMAIS un produit, un service, une formation, un domaine d\'activité, un prix ou une promesse. Ne cite QUE ce qui figure explicitement dans les informations ci-dessus.',
    bizCtx
      ? 'Rédige la réponse en t\'appuyant uniquement sur ces informations réelles.'
      : 'Comme aucune offre n\'est renseignée, NE CITE AUCUN produit/service/domaine : réponds chaleureusement et demande simplement au client ce qu\'il recherche (ou dis que le vendeur va lui préciser) — sans jamais deviner ce qui est vendu.',
    'Rédige UNIQUEMENT le message à lui envoyer (1 à 4 phrases naturelles, parlées), sans préambule ni guillemets. Ne présente JAMAIS une action (paiement reçu, accès débloqué) comme déjà faite — propose-la.',
  ].filter(Boolean).join('\n');
  const raw = await gen(prompt);
  return String(raw || '').trim().replace(/^["'«»\s]+|["'«»\s]+$/g, '').slice(0, 1500);
}

// Point d'entrée : traite un message entrant de bout en bout. Retourne un objet
// d'état honnête (jamais un faux succès) : { sent, status, confirmationId } ou
// { skipped: 'DISABLED' | 'DUPLICATE' | 'NO_RUNTIME' | 'EMPTY_REPLY' }.
async function handleIncoming({ tenantId, channel, from, name, text, messageId }, deps) {
  const d = deps || {};
  const settings = d.settings || await getSettings(tenantId);
  if (!isEnabled(settings, channel)) return { skipped: 'DISABLED' };
  if (!from || !text) return { skipped: 'EMPTY_REPLY' };
  if (markProcessed(tenantId, messageId)) return { skipped: 'DUPLICATE' };
  if (!d.runtime || typeof d.runtime.sendMessageVerified !== 'function') return { skipped: 'NO_RUNTIME' };

  const reply = await composeReply({ tenant: tenantId, channel, from, name, text, llm: d.llm });
  if (!reply) return { skipped: 'EMPTY_REPLY' };

  const out = await d.runtime.sendMessageVerified({ channel, to: from, text: reply, tenantId });
  // sendMessageVerified enregistre déjà le message sortant dans l'historique.
  return {
    sent: out.status === 'SUCCESS',
    status: out.status,
    confirmationId: out.confirmationId || null,
    error: out.error || null,
    reply,
  };
}

module.exports = { handleIncoming, composeReply, getSettings, setSettings, isEnabled, markProcessed, SETTINGS_NS };
