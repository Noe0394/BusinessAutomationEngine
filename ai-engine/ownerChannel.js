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
const authz = require('./authz');
const aiErrors = require('../lib/ai/aiErrors');
const scrubOutbound = aiErrors.scrubOutbound;

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
  const m = unwrapWa(msg);
  return String(m.conversation || (m.extendedTextMessage && m.extendedTextMessage.text) || (m.imageMessage && m.imageMessage.caption) || (m.videoMessage && m.videoMessage.caption) || (m.documentMessage && m.documentMessage.caption) || '').trim();
}
function quotedId(msg) {
  const m = (msg && msg.message) || {};
  const ci = (m.extendedTextMessage && m.extendedTextMessage.contextInfo) || null;
  return ci && ci.stanzaId ? String(ci.stanzaId) : null;
}
function sentId(result) { return result && result.key && result.key.id ? String(result.key.id) : null; }

// Réglage : le canal propriétaire est actif quand l'assistant WhatsApp l'est (ou explicitement via ownerChannel:true/false).
// Le self-chat du propriétaire est une interface de PILOTAGE (comme le Chat intelligent du site) : il fonctionne toujours, même si le répondeur
// automatique des CLIENTS est coupé. Seul un réglage explicite `ownerChannel: false` le désactive. (Sécurité inchangée : seul le self-chat du compte
// connecté ou un numéro propriétaire configuré est reconnu — voir adapter.isOwnerContext.)
function isEnabled(settings, channel) {
  void channel;
  return !(settings && settings.ownerChannel === false);
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

async function sendToSelfTelegram(tenantId, session, text) {
  if (!session || typeof session.getSelfId !== 'function' || typeof session.sendMessage !== 'function') return { ok: false, error: 'SELF_ID_UNKNOWN' };
  const dest = await session.getSelfId();
  if (!dest) return { ok: false, error: 'SELF_ID_UNKNOWN' };
  const out = String(text).slice(0, 3800) + MARK;
  rememberSent(sanitize(tenantId), out);
  const res = await session.sendMessage(String(dest), out);
  return { ok: true, messageId: res && res.id != null ? String(res.id) : null, to: String(dest) };
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

// --- Adaptateurs de canal -------------------------------------------------------------------------------------------
// Le Chat intelligent est UN SEUL moteur ; WhatsApp et Telegram ne sont que des adaptateurs d'entrée/sortie : chacun sait
// (1) reconnaître un message du propriétaire, (2) en extraire le texte, (3) décrire un éventuel média joint, (4) le télécharger
// RÉELLEMENT, (5) répondre dans la même conversation. Tout le reste (média → normalisation → Chat intelligent → outils →
// vérification → réponse) est commun et vit dans handleOwnerMessage ci-dessous.
function unwrapWa(msg) {
  let m = (msg && msg.message) || {};
  for (let i = 0; i < 4; i += 1) {
    const inner = (m.ephemeralMessage && m.ephemeralMessage.message) || (m.viewOnceMessage && m.viewOnceMessage.message)
      || (m.viewOnceMessageV2 && m.viewOnceMessageV2.message) || (m.documentWithCaptionMessage && m.documentWithCaptionMessage.message);
    if (!inner) break;
    m = inner;
  }
  return m;
}

const WHATSAPP = {
  channel: 'WHATSAPP',
  isOwnerContext: (session, msg, input) => (typeof session.isSelfChatJid === 'function' && session.isSelfChatJid(msg.key.remoteJid)) || !!input.configuredOwner,
  messageId: (msg) => (msg.key && msg.key.id ? String(msg.key.id) : null),
  destination: (msg) => msg.key.remoteJid,
  text: (msg) => extractText(msg),
  // Média joint : { kind, mimetype, filename, caption, voice } ou null. « voice » = vraie note vocale (Push-To-Talk) : c'est la
  // PAROLE du propriétaire (une consigne), pas un document à analyser.
  media(msg) {
    const m = unwrapWa(msg);
    if (m.imageMessage) return { kind: 'image', mimetype: m.imageMessage.mimetype || 'image/jpeg', filename: 'image', caption: m.imageMessage.caption || '' };
    if (m.videoMessage) return { kind: 'video', mimetype: m.videoMessage.mimetype || 'video/mp4', filename: 'video', caption: m.videoMessage.caption || '' };
    if (m.ptvMessage) return { kind: 'video', mimetype: m.ptvMessage.mimetype || 'video/mp4', filename: 'video', caption: '' };
    if (m.audioMessage) return { kind: 'audio', mimetype: m.audioMessage.mimetype || 'audio/ogg', filename: m.audioMessage.ptt ? 'vocal' : 'audio', caption: '', voice: !!m.audioMessage.ptt };
    if (m.documentMessage) return { kind: 'document', mimetype: m.documentMessage.mimetype || 'application/octet-stream', filename: m.documentMessage.fileName || 'document', caption: m.documentMessage.caption || '' };
    return null;
  },
  download: (session, msg) => session.downloadIncomingMedia(msg),
  reply: (tenantId, session, msg, text) => sendToSelf(tenantId, session, text, msg.key.remoteJid),
  quotedId,
};

// Telegram (GramJS) : le « self-chat » est la conversation « Messages sauvegardés » du compte connecté.
const TELEGRAM = {
  channel: 'TELEGRAM',
  isOwnerContext: (session, msg) => typeof session.isSavedMessages === 'function' && session.isSavedMessages(msg),
  messageId: (msg) => (msg && msg.id != null ? String(msg.id) : null),
  destination: (msg) => msg.chatId,
  text: (msg) => String((msg && msg.message) || '').trim(),
  media(msg) {
    if (msg.voice) return { kind: 'audio', mimetype: 'audio/ogg', filename: 'vocal', caption: '', voice: true };
    if (msg.photo) return { kind: 'image', mimetype: 'image/jpeg', filename: 'image', caption: '' };
    const doc = msg.document || msg.video || msg.audio;
    if (doc) {
      const attrs = doc.attributes || [];
      const fn = attrs.find((a) => a && a.fileName);
      return { kind: 'document', mimetype: doc.mimeType || 'application/octet-stream', filename: (fn && fn.fileName) || 'fichier', caption: '' };
    }
    return null;
  },
  download: (session, msg) => msg.downloadMedia(),
  reply: async (tenantId, session, msg, text) => {
    const out = String(text).slice(0, 3800) + MARK;
    rememberSent(sanitize(tenantId), out);
    const res = await session.sendMessage(msg.chatId, out);
    return { ok: true, messageId: res && res.id != null ? String(res.id) : null };
  },
  quotedId: (msg) => (msg && msg.replyTo && msg.replyTo.replyToMsgId != null ? String(msg.replyTo.replyToMsgId) : null),
};
const ADAPTERS = { WHATSAPP, TELEGRAM };

// Description courte du fichier pour l'historique (le contenu extrait reste rattaché au fichier par son identifiant).
const shortRef = (it) => `[Pièce jointe : ${it.name} (${it.kind}) [id: ${it.fileId || '-'}]${it.ok ? '' : ' — non traitée'}]`;

// --- Point d'entrée -----------------------------------------------------------------------------------------------
//   input : { tenantId, session, msg, channel?: 'WHATSAPP'|'TELEGRAM', configuredOwner? }
//   deps  : { getSettings, chat({text, tenantId, history, session, principal, tainted}) -> {text}|null, chatFallback(text, history) -> string,
//             paymentDeps(tenantId) -> {deliverToClient, executeOptions}, history: { load(tenantId), append(tenantId, user, assistant) },
//             transcribe?(session,msg) (rétrocompatibilité), media?: { ingest(input), buildTurn(input) } }
async function handleOwnerMessage(input, deps) {
  const { tenantId, session, msg } = input;
  const adapter = ADAPTERS[String(input.channel || 'WHATSAPP').toUpperCase()] || WHATSAPP;
  const tenant = sanitize(tenantId);
  const run = async () => {
    const d = deps || {};
    if (!msg || !session) return { ignored: 'NO_MESSAGE' };
    if (adapter === WHATSAPP && !msg.key) return { ignored: 'NO_MESSAGE' };
    // Isolation : uniquement la conversation « à soi-même » du compte connecté, ou un numéro propriétaire configuré.
    // (Le principal OWNER n'est émis qu'ICI, après cette vérification faite côté serveur — jamais à partir d'un texte.)
    if (!adapter.isOwnerContext(session, msg, input)) return { ignored: 'NOT_OWNER' };
    const settings = d.getSettings ? await d.getSettings(tenantId) : null;
    if (!isEnabled(settings, adapter.channel)) return { ignored: 'OWNER_CHANNEL_DISABLED' };
    const principal = authz.issuePrincipal({ tenant: tenantId, role: authz.ROLES.OWNER, userId: tenantId, channel: adapter.channel, via: input.configuredOwner ? 'configured_owner' : 'self_chat' });

    let text = adapter.text(msg);
    const mediaInfo = adapter.media(msg);
    if (text && text.includes(MARK)) return { ignored: 'CYRUS_GENERATED' };          // anti-boucle : message produit par Cyrus
    if (!text && !mediaInfo) return { ignored: 'EMPTY' };
    if (text && wasJustSent(tenant, text)) return { ignored: 'ECHO_OF_CYRUS' };
    if (markSeen(tenant, adapter.messageId(msg))) return { ignored: 'DUPLICATE' };
    const reply = async (t) => adapter.reply(tenantId, session, msg, scrubOutbound(t));
    if (overRate(tenant, Date.now())) {
      return { ignored: 'RATE_LIMITED' }; // silence : ne jamais alimenter une boucle
    }

    // 0) MÉDIA / FICHIER joint : récupération RÉELLE du binaire, extraction réelle, puis normalisation avec l'instruction du
    //    MÊME message. Aucune étape simulée : si le fichier n'a pas pu être récupéré ou lu, on le dit simplement.
    let tainted = false; let userTextForHistory = null;
    if (mediaInfo && mediaInfo.voice && !text && typeof d.transcribe === 'function') {
      // Chemin historique (transcripteur injecté) : la note vocale devient directement le texte du propriétaire.
      try { text = String((await d.transcribe(session, msg)) || '').trim(); } catch (e) { text = ''; }
      if (!text) return { ignored: 'EMPTY' };
    } else if (mediaInfo) {
      const media = d.media || require('./mediaPipeline');
      let buffer = null;
      try { buffer = await adapter.download(session, msg); } catch (err) { console.warn(`ownerChannel — téléchargement du média impossible (tenant "${tenant}", ${adapter.channel}) : ${aiErrors.redact(err && err.message)}`); }
      if (!Buffer.isBuffer(buffer) || !buffer.length) {
        await reply(aiErrors.FILE_FAILED_USER_MESSAGE);
        return { handled: 'MEDIA_DOWNLOAD_FAILED' };
      }
      const item = await media.ingest({ tenantId, buffer, mimetype: mediaInfo.mimetype, filename: mediaInfo.filename, source: adapter.channel });
      if (mediaInfo.voice) {
        // Note vocale du propriétaire = sa consigne parlée : la transcription devient son message (non teinté).
        if (!item.ok) { await reply(aiErrors.FILE_FAILED_USER_MESSAGE); return { handled: 'VOICE_FAILED' }; }
        text = item.text.split('\n(Original :')[0].trim();
        userTextForHistory = text;
      } else {
        const turn = media.buildTurn({ instruction: text || mediaInfo.caption, items: [item] });
        userTextForHistory = `${text || mediaInfo.caption || ''}\n${shortRef(item)}`.trim();
        if (!item.ok) { await reply(item.userMessage || aiErrors.FILE_FAILED_USER_MESSAGE); return { handled: 'MEDIA_UNREADABLE', fileId: item.fileId || null }; }
        text = turn.text; tainted = turn.tainted;
      }
    } else if (!text && d.transcribe) {
      try { text = String((await d.transcribe(session, msg)) || '').trim(); } catch (e) { text = ''; }
      if (!text) return { ignored: 'EMPTY' };
    }
    if (!text) return { ignored: 'EMPTY' };

    // 1) OUI / NON sur une action précise
    const dec = (require('./manualPaymentValidator')).parseOwnerDecision(text);
    const open = await pendingActions.listOpen(tenantId);
    const targeted = !!dec.pendingActionId;
    if (!mediaInfo && dec.decision && (open.length || targeted)) {
      const pd = d.paymentDeps ? d.paymentDeps(tenantId, session) : {};
      const out = await require('./manualPaymentValidator').resolveOwnerDecision(tenantId, {
        decision: dec.decision, pendingActionId: dec.pendingActionId, quotedMessageId: adapter.quotedId(msg), courseHint: dec.courseHint,
      }, pd);
      await reply(out.text);
      return { handled: 'DECISION', kind: out.kind, pendingActionId: out.pendingActionId || null };
    }
    if (!mediaInfo && dec.ambiguous && open.length) {
      // « ok », « attends », « peut-être »… : jamais une opération sensible. On le dit clairement.
      await reply(`Je n'ai rien exécuté. ${open.length > 1 ? `${open.length} actions attendent` : 'Une action attend'} ta décision : réponds « OUI » ou « NON »${open.length > 1 ? ' suivi de la référence (ex : « OUI ' + open[0].pendingActionId + ' »)' : ''}.`);
      return { handled: 'AMBIGUOUS_DECISION' };
    }

    // 2) reprise / prise en main d'une conversation
    const ctl = mediaInfo ? null : await handleControlCommand(tenantId, text);
    if (ctl) { await reply(ctl.text); return { handled: 'CONTROL' }; }

    // 3) Chat Intelligent (même cerveau que le tableau de bord)
    const history = d.history ? await d.history.load(tenantId) : [];
    // L'accusé « Je m'en occupe » n'est JAMAIS déclenché par un simple délai d'horloge (un fournisseur IA lent ferait alors
    // envoyer ce message même pour « Bonjour »). Il n'est armé QUE pour une demande qui n'est PAS une conversation courante
    // (même classification que le chemin rapide du Chat intelligent, voir chatOrchestrator.isQuickChat) — un ordre, une
    // création, une recherche, un import… peuvent légitimement prendre du temps ; une salutation ou une question simple, non.
    const isLongTaskCandidate = !require('./chatOrchestrator').isQuickChat(text);
    const ackMs = parseInt(process.env.OWNER_ACK_MS, 10) || 6000;
    let ackSent = false;
    const ackTimer = isLongTaskCandidate ? setTimeout(() => { ackSent = true; reply("⏳ Je m'en occupe — cela prend un peu plus de temps, je reviens dès que c'est fait.").catch(() => {}); }, ackMs) : null;
    let answer = null; let turnOut = null;
    try { const out = d.chat ? await d.chat({ text, tenantId, history, session, principal, tainted, channel: adapter.channel }) : null; turnOut = out; answer = out && out.text ? out.text : null; }
    catch (err) { console.warn(`ownerChannel — Chat Intelligent en échec (tenant "${tenant}") : ${aiErrors.redact(err && (err.internalDetail || err.message))}`); answer = aiErrors.safeUserMessage(err); }
    if (!answer && d.chatFallback) {
      try { answer = await d.chatFallback(text, history, tenantId); }
      catch (err) { console.warn(`ownerChannel — repli conversationnel en échec (tenant "${tenant}") : ${aiErrors.redact(err && (err.internalDetail || err.message))}`); answer = aiErrors.safeUserMessage(err); }
    }
    if (ackTimer) clearTimeout(ackTimer); void ackSent;
    if (!answer) answer = "Je n'ai pas de réponse pour cette demande pour le moment.";
    // JAMAIS « fait » sans preuve : une affirmation d'accomplissement sans action réellement exécutée et vérifiée dans ce tour est remplacée par un message honnête.
    answer = require('./claimGuard').guard(answer, turnOut, { request: text }).text;
    answer = contactIdentity.scrubTechnicalIds(answer);
    await reply(answer);
    if (d.history) { try { await d.history.append(tenantId, userTextForHistory || text, answer); } catch (e) { /* non bloquant */ } }
    return { handled: 'CHAT', media: !!mediaInfo };
  };
  const prev = chains.get(tenant) || Promise.resolve();
  const next = prev.catch(() => {}).then(run);
  chains.set(tenant, next);
  next.finally(() => { if (chains.get(tenant) === next) chains.delete(tenant); }).catch(() => {});
  return next;
}

module.exports = { MARK, SESSION_TITLE, handleOwnerMessage, whatsappDeliverer, studioChatDeliverer, isEnabled, isConfiguredOwner, sendToSelf, sendToSelfTelegram, extractText, quotedId, ADAPTERS, _test: { seen, rate, lastSent } };
