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
const modelRouter = require('./modelRouter');
const contactCrm = require('./contactCrm');
const conversationEngine = require('./jarvis/conversationEngine');
const { shared: conversationQueue } = require('./jarvis/conversationQueue');
const alwaysOn = require('./alwaysOn');

const DEFAULT_DEBOUNCE_MS = Math.max(0, parseInt(process.env.AUTO_REPLY_DEBOUNCE_MS, 10) || 1500);

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

// Politique de réglage : un compte « toujours actif » (alwaysOn) répond en permanence sur WhatsApp ET Telegram, sauf pause
// explicite (paused). AUTO_REPLY_DEFAULT_ON=true active aussi le répondeur par défaut des comptes sans réglage.
const defaultOn = () => process.env.AUTO_REPLY_DEFAULT_ON === 'true';
function applyPolicy(doc, tenant) {
  const d = Object.assign({}, doc);
  if (d.alwaysOn === true || alwaysOn.isAlwaysOn(tenant)) {
    d.alwaysOn = true;
    if (d.paused !== true) { d.whatsapp = true; d.telegram = true; }
  }
  return d;
}
async function getSettings(tenant) {
  const t = sanitizeTenant(tenant);
  const doc = await storageAdapter.get(SETTINGS_NS, t, { tenant: t, whatsapp: defaultOn(), telegram: defaultOn() });
  return applyPolicy(doc, t);
}
async function setSettings(tenant, patch) {
  const t = sanitizeTenant(tenant);
  const cur = await storageAdapter.get(SETTINGS_NS, t, { tenant: t, whatsapp: defaultOn(), telegram: defaultOn() });
  const next = Object.assign({}, cur, patch || {}, { tenant: t, updatedAt: new Date().toISOString() });
  if (typeof next.alwaysOn === 'boolean') alwaysOn.mark(t, next.alwaysOn);
  storageAdapter.set(SETTINGS_NS, t, next);
  return applyPolicy(next, t);
}
function isEnabled(settings, channel) {
  return String(channel).toUpperCase() === 'TELEGRAM' ? !!(settings && settings.telegram) : !!(settings && settings.whatsapp);
}

// Rédige la réponse au client, EN S'APPUYANT sur le contexte métier réel
// (produits/prix/règles des Services Métiers) et l'historique de la conversation.
async function composeReply({ tenant, channel, from, name, text, llm, directives }) {
  // Model router (§6) : complexité du message -> taille de contexte + plafond
  // de tokens de sortie (économie réelle sur les messages simples).
  const route = modelRouter.classify(text);
  // Appel IA tagué (AI Cost Guard) : purpose 'client_conversation' + tenant +
  // maxTokens (routeur) + taskId (protection anti-boucle par conversation).
  const meta = { purpose: 'client_conversation', tenant, maxTokens: route.maxTokens, taskId: `autoreply:${tenant}:${from}`, tier: route.tier === 'complex' ? 'reasoning' : 'standard' };
  const gen = typeof llm === 'function' ? llm : (p) => llmFallbackEngine.generateAIResponse(p, [], null, undefined, null, meta).then((r) => r.text);
  const bizCtx = await businessServices.getEngineContextText(tenant).catch(() => '');
  let history = '';
  try {
    const conv = await messageHistory.getConversation(tenant, channel, from, route.maxContextMessages);
    if (conv && conv.length) history = conv.map((m) => `${m.direction === 'in' ? 'Client' : 'Moi'}: ${m.text}`).join('\n');
  } catch (e) { history = ''; }
  // Contact issu d'une campagne Facebook Ads : le message d'accueil exact est déjà parti ; on continue à partir de là.
  let adCtx = '';
  try { adCtx = await require('./adCampaigns').continuationContext(tenant, channel, from); } catch (e) { adCtx = ''; }
  try { const gctx = await require('./groupCampaigns').continuationContext(tenant, channel, from); if (gctx) adCtx = [adCtx, gctx].filter(Boolean).join('\n'); } catch (e) { /* facultatif */ }
  const prompt = [
    personaManager.personaSystemPrompt('default'),
    adCtx,
    'Tu réponds DIRECTEMENT à un client/prospect qui vient d\'écrire au vendeur — tu réponds EN SON NOM, comme le vendeur lui-même. Sois chaleureux, humain et utile.',
    bizCtx
      ? `Informations RÉELLES de l'activité (produits, prix, règles — SEULE source autorisée, n'invente jamais au-delà de ceci) :\n${bizCtx}`
      : 'AUCUNE offre n\'est configurée pour ce vendeur. Tu ne connais donc PAS ses produits, services, prix ni domaine d\'activité.',
    history ? `Historique récent avec ce client :\n${history}` : '',
    directives && directives.length ? `CONSIGNES DE CONVERSATION (OBLIGATOIRES, prioritaires sur tout style commercial) :\n- ${directives.join('\n- ')}` : '',
    `Nouveau message du client ${name ? '(' + name + ')' : ''} : "${text}"`,
    // Garde-fou anti-invention RENFORCÉ (un vrai client est en face) :
    'RÈGLE ABSOLUE : n\'invente JAMAIS un produit, un service, une formation, un domaine d\'activité, un prix ou une promesse. Ne cite QUE ce qui figure explicitement dans les informations ci-dessus.',
    bizCtx
      ? 'Rédige la réponse en t\'appuyant uniquement sur ces informations réelles.'
      : 'Comme aucune offre n\'est renseignée, NE CITE AUCUN produit/service/domaine : réponds chaleureusement et demande simplement au client ce qu\'il recherche (ou dis que le vendeur va lui préciser) — sans jamais deviner ce qui est vendu.',
    // Conduite de la conversation commerciale (défauts constatés en test réel : moyens de paiement inventés, salutation répétée).
    'PAIEMENT : quand le client veut payer ou demande comment payer, donne EXACTEMENT les instructions de paiement configurées (numéro/moyen tels quels), puis demande la capture de la preuve de paiement avec son email. N\'invente JAMAIS un lien de paiement, un moyen (virement, carte…) ou un numéro absent des informations ci-dessus ; s\'ils ne sont pas configurés, dis que tu fais confirmer la procédure par le vendeur.',
    'INTÉRÊT : si le client manifeste son intérêt, réponds concrètement avec ce que tu sais RÉELLEMENT de l\'offre (ce que c\'est, le prix), puis propose la suite (comment payer) — pas une simple question.',
    history ? 'Ne dis « Bonjour »/« Salut » que dans le TOUT PREMIER message d\'une conversation : ici l\'échange est déjà commencé, va droit au but.' : '',
    'INFORMATION ABSENTE : si la question porte sur un fait absent des informations (livraison, zone, délai…), ne promets pas de « vérifier et revenir » ; dis simplement que tu transmets la question au vendeur qui confirmera.',
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

  try { require('./activityStore').record({ type: 'message_in', action: 'Message client reçu', status: 'ok', channel, tenant: tenantId, target: from, detail: `${text.length} caractères` }); } catch (e) { /* non bloquant */ }

  if (settings.jarvis === false) return legacyReply({ tenantId, channel, from, name, text }, d);

  const debounceMs = d.debounceMs != null ? d.debounceMs : (settings.debounceMs != null ? settings.debounceMs : DEFAULT_DEBOUNCE_MS);
  return conversationQueue.submit(
    `${sanitizeTenant(tenantId)}:${channel}:${from}`,
    { text, messageId },
    (items) => processBatch({ tenantId, channel, from, name, items, settings }, d),
    { debounceMs },
  );
}

async function sendAndLog({ tenantId, channel, from, reply }, d) {
  const out = await d.runtime.sendMessageVerified({ channel, to: from, text: reply, tenantId });
  const sent = out.status === 'SUCCESS';
  try {
    require('./activityStore').record({
      type: 'auto_reply', action: 'Réponse automatique', channel, tenant: tenantId, target: from,
      status: sent ? 'ok' : (out.status === 'PENDING' ? 'pending' : 'error'),
      detail: sent ? `envoyée (réf. ${out.confirmationId || '?'})` : (out.error || out.status),
    });
  } catch (e) { /* non bloquant */ }
  return out;
}

function isGroupChat(channel, from) {
  const id = String(from || '');
  return String(channel).toUpperCase() === 'TELEGRAM' ? /^-\d+$/.test(id) : /@(?:g\.us|broadcast)$/i.test(id);
}

// L'utilisateur écrit lui-même depuis son téléphone : Cyrus se tait sur cette conversation (settings.humanPauseMinutes, 0 = désactivé).
async function handleHumanActivity({ tenantId, channel, from }) {
  const settings = await getSettings(tenantId);
  if (!isEnabled(settings, channel) || settings.humanPauseMinutes === 0 || !from) return null;
  return conversationEngine.noteHumanActivity(tenantId, channel, from, settings.humanPauseMinutes);
}

// Le client est informé qu'une réponse viendra du vendeur / qu'on vérifie : dans ce cas le propriétaire DOIT être prévenu (promesse tenue).
const PROMISE_TO_OWNER_RE = /(?:je\s+(?:vais\s+)?(?:v[ée]rifie\w*|me\s+renseigne\w*|regarde\w*)[^.!?]{0,80}(?:reviens|reviendrai|revenir|reviendra|reponds|répondrai)|je\s+(?:te|vous)\s+(?:reviens|recontacte\w*|tiens\s+au\s+courant)|transmet\w*\s+(?:ta|votre|la|cette|tes|vos)\s+(?:question|demande|message)s?|(?:fais|faire|fera)\s+confirmer|(?:le\s+)?vendeur\s+(?:te|vous)?\s*(?:qui\s+)?(?:te\s+|vous\s+)?(?:confirmera|reviendra|revient|répondra|contactera)|(?:il|elle)\s+(?:te|vous)\s+(?:revient|répondra|confirmera|recontactera))/i;

// Consignes de personnalisation de l'accueil : contact enregistré -> on l'appelle par son nom ; inconnu -> on demande poliment
// son nom/l'objet de sa demande (sans insister s'il ne répond pas).
function identityDirectives(identity, name) {
  if (identity && identity.isSavedContact && identity.contactName) return [`Ce contact est enregistré dans le répertoire du propriétaire sous le nom « ${identity.contactName} » : appelle-le par ce nom, sans le lui redemander.`];
  if (name) return [`Le contact se fait appeler « ${name} » (nom public, non vérifié) : tu peux l'utiliser naturellement.`];
  return ["Tu ne connais ni le nom ni l'objet de la demande de ce contact : demande-lui poliment, une seule fois, son nom et ce qu'il souhaite ; n'insiste pas s'il ne répond pas."];
}

async function processBatch({ tenantId, channel, from, name, items, settings }, d) {
  const knownText = await businessServices.getEngineContextText(tenantId).catch(() => '');
  let history = [];
  try { history = await messageHistory.getConversation(tenantId, channel, from, 8); } catch (e) { history = []; }
  let lastOut = null;
  let productNames = [];
  try {
    const ctxData = await businessServices.getEngineContext(tenantId);
    for (const svc of ctxData || []) {
      if (svc.name) productNames.push(svc.name);
      for (const p of (svc.products || [])) if (p && (p.name || typeof p === 'string')) productNames.push(p.name || String(p));
    }
  } catch (e) { productNames = []; }
  // Arbitrage des intentions AMBIGUËES (refus vs intérêt, hésitation vs paiement…) : décision critique -> niveau raisonnement.
  const arbitrationLlm = d.llm || ((p) => llmFallbackEngine.generateAIResponse(p, [], null, undefined, null, { purpose: 'intent_arbitration', tenant: tenantId, tier: 'reasoning', maxTokens: 300 }).then((r) => r.text));
  const result = await conversationEngine.handleBatch({ tenantId, channel, from, name, items }, {
    isGroup: isGroupChat(channel, from),
    groupReplies: settings.groupReplies === true,
    productNames,
    llm: arbitrationLlm,
    crm: d.crm || contactCrm,
    knownText,
    history,
    settings,
    compose: async (directives, ctx) => {
      const reply = await composeReply({ tenant: tenantId, channel, from, name, text: ctx.text, llm: d.llm, directives: (directives || []).concat(identityDirectives(d.identity, name)) });
      // Le client attend une confirmation du vendeur (fait absent du Service métier) : la promesse est TENUE — le propriétaire est prévenu.
      if (PROMISE_TO_OWNER_RE.test(reply)) {
        require('./alertCenter').triggerAdminNotification(tenantId, {
          reason: `Question sans réponse dans le Service métier : le client attend une confirmation.`, contact: d.identity || null, text: ctx.text,
          key: `esc:${tenantId}:${channel}:${from}:${Math.floor(Date.now() / 600000)}`, // même clé que l'escalade du moteur : une seule alerte par événement
        }).catch(() => {});
      }
      return reply;
    },
    send: async (reply) => { lastOut = await sendAndLog({ tenantId, channel, from, reply }, d); return lastOut; },
    // Demande hors périmètre / escalade : triggerAdminNotification (alerte persistante, WhatsApp du propriétaire + tableau de bord).
    notify: d.notify || ((msg) => require('./alertCenter').triggerAdminNotification(tenantId, { reason: msg, contact: d.identity || null, key: `esc:${tenantId}:${channel}:${from}:${Math.floor(Date.now() / 600000)}` })),
  });
  if (result.action === 'NO_ACTION') {
    try { require('./activityStore').record({ type: 'no_action', action: 'Aucune réponse nécessaire', channel, tenant: tenantId, target: from, status: 'ok', detail: `${result.intent || '-'} / ${result.reason}` }); } catch (e) { /* non bloquant */ }
    return { skipped: 'NO_ACTION', reason: result.reason, intent: result.intent };
  }
  const out = lastOut || {};
  const sent = out.status === 'SUCCESS';
  return { sent, status: out.status, confirmationId: out.confirmationId || null, error: out.error || null, reply: result.text, intent: result.intent, state: result.state, kind: result.kind };
}

// Ancien comportement (settings.jarvis === false) : une réponse par message.
async function legacyReply({ tenantId, channel, from, name, text }, d) {
  const reply = await composeReply({ tenant: tenantId, channel, from, name, text, llm: d.llm });
  if (!reply) return { skipped: 'EMPTY_REPLY' };
  const out = await sendAndLog({ tenantId, channel, from, reply }, d);
  const sent = out.status === 'SUCCESS';
  return { sent, status: out.status, confirmationId: out.confirmationId || null, error: out.error || null, reply };
}

module.exports = { handleHumanActivity, isGroupChat, handleIncoming, composeReply, getSettings, setSettings, isEnabled, markProcessed, SETTINGS_NS };
