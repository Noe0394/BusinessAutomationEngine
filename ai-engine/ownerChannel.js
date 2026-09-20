// OWNER CHANNEL — ai-engine/ownerChannel.js
// ---------------------------------------------------------------------------
// Le WhatsApp du propriétaire est une INTERFACE supplémentaire vers le Chat Intelligent EXISTANT (pas un second
// chatbot) : le message écrit dans sa propre conversation (self-chat) est identifié comme venant du propriétaire, puis :
//   1. décision OUI / NON sur une action en attente (reliée à un pendingActionId précis) ;
//   2. commande de reprise/arrêt de l'automatisation d'une conversation ;
//   3. sinon -> Chat Intelligent (chatOrchestrator : outils, mémoire 7×24 h, campagnes, rapports…) ;
//   -> la réponse est renvoyée dans la MÊME conversation.
// Le même module livre les alertes générales (alertCenter) dans ce self-chat.
//
// SÉCURITÉ / ISOLATION : seul le self-chat du compte connecté (ou un numéro explicitement configuré dans
// `settings.ownerNumbers`) est propriétaire. Un client, un contact ou un groupe n'atteint JAMAIS ce module.
// ANTI-BOUCLE : (1) l'écho d'un message envoyé par Cyrus est ignoré par le moteur (identifiants d'envoi) ;
// (2) chaque message généré par Cyrus porte un marqueur invisible (survit aux redémarrages) ; (3) idempotence par id de
// message ; (4) plafond de messages/minute ; (5) refus de retraiter un texte identique à celui que Cyrus vient d'envoyer.

const pendingActions = require('./pendingActions');
const conversationRouter = require('./conversationRouter');
const contactIdentity = require('./contactIdentity');

const MARK = '⁣'; // séparateur invisible : signature technique des messages générés par Cyrus
const MAX_PER_MINUTE = 20;
const SESSION_TITLE = 'WhatsApp propriétaire';

const seen = new Map();        // tenant -> Set(messageId)
const rate = new Map();        // tenant -> [timestamps]
const lastSent = new Map();    // tenant -> Map(hash -> ts)
const chains = new Map();      // tenant -> Promise (exécution en série par tenant)
const sanitize = (t) => String(t || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'unknown';
const hash = (s) => require('crypto').createHash('sha1').update(String(s)).digest('hex').slice(0, 16);

function markSeen(tenant, id) {
  if (!id) return false;
  let s = seen.get(tenant); if (!s) { s = new Set(); seen.set(tenant, s); }
  if (s.has(id)) return true;
  s.add(id); if (s.size > 1000) s.delete(s.values().next().value);
  return false;
}
function overRate(tenant, now) {
  const arr = (rate.get(tenant) || []).filter((t) => now - t < 60000);
  arr.push(now); rate.set(tenant, arr);
  return arr.length > MAX_PER_MINUTE;
}
function rememberSent(tenant, text) {
  let m = lastSent.get(tenant); if (!m) { m = new Map(); lastSent.set(tenant, m); }
  const now = Date.now();
  m.set(hash(text.replace(new RegExp(MARK, 'g'), '')), now);
  for (const [k, ts] of m) if (now - ts > 120000) m.delete(k);
}
function wasJustSent(tenant, text) {
  const m = lastSent.get(tenant); if (!m) return false;
  const ts = m.get(hash(String(text).replace(new RegExp(MARK, 'g'), '')));
  return !!ts && Date.now() - ts < 120000;
}

function extractText(msg) {
  const m = (msg && msg.message) || {};
  return String(m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || (m.imageMessage && m.imageMessage.caption) || (m.videoMessage && m.videoMessage.caption) || '').trim();
}
function quotedId(msg) {
  const m = (msg && msg.message) || {};
  const ci = (m.extendedTextMessage && m.extendedTextMessage.contextInfo) || null;
  return ci && ci.stanzaId ? String(ci.stanzaId) : null;
}
function sentId(result) { return result && result.key && result.key.id ? String(result.key.id) : null; }

// Réglage : le canal propriétaire est actif quand l'assistant WhatsApp l'est (ou explicitement via ownerChannel:true/false).
function isEnabled(settings) {
  if (!settings) return false;
  if (settings.ownerChannel === false) return false;
  return settings.ownerChannel === true || !!settings.whatsapp;
}
function isConfiguredOwner(settings, identity) {
  const list = (settings && Array.isArray(settings.ownerNumbers)) ? settings.ownerNumbers : [];
  if (!list.length || !identity || !identity.phoneNumber) return false; // jamais un numéro déduit d'un LID
  return list.map((n) => String(n).replace(/\D/g, '')).includes(String(identity.phoneNumber));
}

// Envoi d'un texte dans le self-chat (jamais retraité en entrée grâce au marqueur + identifiants d'envoi).
async function sendToSelf(tenantId, session, text, to) {
  const ids = session.getSelfIds ? session.getSelfIds() : {};
  const dest = to || ids.pn || ids.lid;
  if (!dest) return { ok: false, error: 'SELF_ID_UNKNOWN' };
  const out = String(text).slice(0, 3800) + MARK;
  rememberSent(sanitize(tenantId), out);
  const res = await session.sendMessage(dest, out);
  return { ok: true, messageId: sentId(res), to: dest };
}

// Livreur d'alertes pour alertCenter : WhatsApp du propriétaire, seulement si la session est réellement active.
function whatsappDeliverer({ peek, getSettings }) {
  return async (tenantId, text) => {
    const entry = peek(tenantId);
    const session = entry && entry.session;
    if (!session || typeof session.sendMessage !== 'function') return { ok: false, channel: 'owner_whatsapp', error: 'SESSION_INACTIVE' };
    if (typeof session.isConnected === 'function' && !session.isConnected()) return { ok: false, channel: 'owner_whatsapp', error: 'NOT_CONNECTED' };
    let settings = null;
    try { settings = await getSettings(tenantId); } catch (e) { settings = null; }
    if (!isEnabled(settings)) return { ok: false, channel: 'owner_whatsapp', error: 'OWNER_CHANNEL_DISABLED' };
    try {
      const r = await sendToSelf(tenantId, session, text);
      return { ok: r.ok, channel: 'owner_whatsapp', messageId: r.messageId, error: r.error };
    } catch (err) { return { ok: false, channel: 'owner_whatsapp', error: err.message }; }
  };
}

// Livreur de repli : tchat du tableau de bord (historique du Chat Intelligent).
function studioChatDeliverer(notifyTenantChat) {
  return async (tenantId, text) => {
    await notifyTenantChat(tenantId, text, null);
    return { ok: true, channel: 'studio_chat' };
  };
}

// --- Commandes de reprise/arrêt de l'automatisation -------------------------------------------------------------
const RESUME_RE = /^(?:reprends?|reprenez|reactive|réactive|remets?|rends?)\b.*?\b(?:conversation|automatisation|auto|main|cyrus|assistant)\b.*?\b(?:avec|pour|de)\s+(.{2,60})$/i;
const TAKEOVER_RE = /^(?:je\s+(?:prends?|reprends?)|laisse[- ]moi|stop\s+auto|arr[eê]te\s+l['’]auto\w*)\b.*?\b(?:conversation|main|discussion|auto\w*)\b.*?\b(?:avec|de|pour)\s+(.{2,60})$/i;

async function findAwaiting(tenantId, query) {
  const q = String(query || '').toLowerCase().replace(/[.!?]+$/, '').trim();
  const list = await conversationRouter.listAwaitingOwner(tenantId, ['HUMAN_REQUIRED', 'HUMAN_ACTIVE']);
  return list.filter((c) => c.contactLabel && c.contactLabel.toLowerCase().includes(q));
}

async function handleControlCommand(tenantId, text) {
  const resume = text.match(RESUME_RE);
  const take = !resume && text.match(TAKEOVER_RE);
  if (!resume && !take) return null;
  const q = (resume || take)[1];
  const found = await findAwaiting(tenantId, q);
  if (!found.length) {
    return { text: `Je ne trouve aucune conversation en attente avec « ${q.trim()} ». Demande-moi « quelles conversations attendent mon intervention ? » pour voir la liste.` };
  }
  if (found.length > 1) return { text: `Plusieurs conversations correspondent à « ${q.trim()} » :\n${found.map((c) => `• ${c.contactLabel}`).join('\n')}\nPrécise le nom complet.` };
  const c = found[0];
  if (resume) {
    await conversationRouter.resumeAutomation(tenantId, c.channel, c.chatId);
    return { text: `C'est fait : je reprends la conversation avec ${c.contactLabel} (automatisation réactivée). Je ne parlerai plus à ta place tant que tu n'écris pas dans cette conversation.` };
  }
  await conversationRouter.noteOwnerTookOver(tenantId, c.channel, c.chatId, 240);
  return { text: `Compris : tu gères la conversation avec ${c.contactLabel}. Je ne réponds plus à sa place pendant 4 h ; dis « reprends la conversation avec ${c.contactLabel} » pour me la rendre.` };
}

// --- Point d'entrée -----------------------------------------------------------------------------------------------
//   input : { tenantId, session, msg }
//   deps  : { getSettings, chat({text, tenantId, history}) -> {text}|null, chatFallback(text, history) -> string,
//             paymentDeps(tenantId) -> {deliverToClient, executeOptions}, history: { load(tenantId), append(tenantId, user, assistant) },
//             resolveDecision? (tests) }
async function handleOwnerMessage(input, deps) {
  const { tenantId, session, msg } = input;
  const tenant = sanitize(tenantId);
  const run = async () => {
    const d = deps || {};
    if (!msg || !msg.key || !session) return { ignored: 'NO_MESSAGE' };
    // Isolation : uniquement la conversation « à soi-même » du compte connecté, ou un numéro propriétaire configuré.
    const selfChat = typeof session.isSelfChatJid === 'function' && session.isSelfChatJid(msg.key.remoteJid);
    if (!selfChat && !input.configuredOwner) return { ignored: 'NOT_OWNER' };
    const settings = d.getSettings ? await d.getSettings(tenantId) : null;
    if (!isEnabled(settings)) return { ignored: 'OWNER_CHANNEL_DISABLED' };

    let text = extractText(msg);
    if (!text && d.transcribe) { try { text = String((await d.transcribe(session, msg)) || '').trim(); } catch (e) { text = ''; } }
    if (!text) return { ignored: 'EMPTY' };
    if (text.includes(MARK)) return { ignored: 'CYRUS_GENERATED' };          // anti-boucle : message produit par Cyrus
    if (wasJustSent(tenant, text)) return { ignored: 'ECHO_OF_CYRUS' };
    if (markSeen(tenant, msg.key.id)) return { ignored: 'DUPLICATE' };
    const dest = msg.key.remoteJid;
    const reply = async (t) => { const r = await sendToSelf(tenantId, session, t, dest); return r; };
    if (overRate(tenant, Date.now())) {
      return { ignored: 'RATE_LIMITED' }; // silence : ne jamais alimenter une boucle
    }

    // 1) OUI / NON sur une action précise
    const dec = (require('./manualPaymentValidator')).parseOwnerDecision(text);
    const open = await pendingActions.listOpen(tenantId);
    const targeted = !!dec.pendingActionId;
    if (dec.decision && (open.length || targeted)) {
      const pd = d.paymentDeps ? d.paymentDeps(tenantId, session) : {};
      const out = await require('./manualPaymentValidator').resolveOwnerDecision(tenantId, {
        decision: dec.decision, pendingActionId: dec.pendingActionId, quotedMessageId: quotedId(msg), courseHint: dec.courseHint,
      }, pd);
      await reply(out.text);
      return { handled: 'DECISION', kind: out.kind, pendingActionId: out.pendingActionId || null };
    }
    if (dec.ambiguous && open.length) {
      // « ok », « attends », « peut-être »… : jamais une opération sensible. On le dit clairement.
      await reply(`Je n'ai rien exécuté. ${open.length > 1 ? `${open.length} actions attendent` : 'Une action attend'} ta décision : réponds « OUI » ou « NON »${open.length > 1 ? ' suivi de la référence (ex : « OUI ' + open[0].pendingActionId + ' »)' : ''}.`);
      return { handled: 'AMBIGUOUS_DECISION' };
    }

    // 2) reprise / prise en main d'une conversation
    const ctl = await handleControlCommand(tenantId, text);
    if (ctl) { await reply(ctl.text); return { handled: 'CONTROL' }; }

    // 3) Chat Intelligent (même cerveau que le tableau de bord)
    const history = d.history ? await d.history.load(tenantId) : [];
    let answer = null;
    try { const out = d.chat ? await d.chat({ text, tenantId, history, session }) : null; answer = out && out.text ? out.text : null; } catch (err) { answer = `Je n'ai pas pu traiter ta demande (${err.message}).`; }
    if (!answer && d.chatFallback) { try { answer = await d.chatFallback(text, history); } catch (err) { answer = `Je n'arrive pas à répondre pour le moment (${err.message}).`; } }
    if (!answer) answer = "Je n'ai pas de réponse pour cette demande pour le moment.";
    answer = contactIdentity.scrubTechnicalIds(answer);
    await reply(answer);
    if (d.history) { try { await d.history.append(tenantId, text, answer); } catch (e) { /* non bloquant */ } }
    return { handled: 'CHAT' };
  };
  const prev = chains.get(tenant) || Promise.resolve();
  const next = prev.catch(() => {}).then(run);
  chains.set(tenant, next);
  next.finally(() => { if (chains.get(tenant) === next) chains.delete(tenant); }).catch(() => {});
  return next;
}

module.exports = { MARK, SESSION_TITLE, handleOwnerMessage, whatsappDeliverer, studioChatDeliverer, isEnabled, isConfiguredOwner, sendToSelf, extractText, quotedId, _test: { seen, rate, lastSent } };
