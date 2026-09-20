const storageAdapter = require('./storageAdapter');

// HISTORIQUE DE MESSAGES PERSISTANT — fenêtre glissante STRICTE de 7 jours
// ---------------------------------------------------------------------------
// Mémoire opérationnelle réelle du contexte récent : chaque message entrant ET
// sortant (WhatsApp/Telegram) est enregistré de façon PERSISTANTE (survit à un
// redémarrage), par tenant + canal. Permet à l'agent de : retrouver le dernier
// message réel + son expéditeur, reconstituer une conversation (grande personne
// OU groupe), exploiter le contexte des 7 derniers jours, et comprendre le
// style de l'utilisateur.
//
// FENÊTRE GLISSANTE 7 JOURS (règle du cahier des charges) :
//   NOW - 7 jours -> TOUTES les conversations de la fenêtre sont exploitables ;
//   les données qui SORTENT de la fenêtre deviennent éligibles au nettoyage
//   (prune à l'écriture + job périodique idempotent, voir startMaintenance).
//   Une donnée encore dans la fenêtre n'est JAMAIS supprimée.
//
// Un document par (tenant, canal) :
//   - namespaces "message_history" : les messages bruts (source de vérité) ;
//   - namespace "conversation_index" : un INDEX conversationnel par (tenant,
//     canal) agrégé à chaque enregistrement (contact, groupe, compteurs,
//     premier/dernier message) — sert la recherche DÉTERMINISTE, jamais l'IA.
//
// Bornes : on garde AU MOINS RETENTION_DAYS (7) jours ET AU PLUS MAX_MESSAGES
// entrées (le plus permissif des deux, pour ne jamais perdre le contexte de la
// fenêtre tout en bornant la taille en cas de très fort volume).

const NAMESPACE = 'message_history';
const INDEX_NAMESPACE = 'conversation_index';
const RETENTION_DAYS = 7; // fenêtre glissante STRICTE du cahier des charges
const MAX_MESSAGES = 200000; // garde-fou global de la vue « document » (le stockage est journalier)
const CLEANUP_BATCH = 200; // lots pour le nettoyage périodique
const DEFAULT_MAINTENANCE_MINUTES = 60;

const CHANNELS = ['WHATSAPP', 'TELEGRAM'];

function sanitize(id) { return String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default'; }
function docId(tenantId, channel) { return `${sanitize(tenantId)}__${sanitize(String(channel || 'WHATSAPP').toUpperCase())}`; }
function windowCutoffMs(days) { return Date.now() - (days || RETENTION_DAYS) * 24 * 3600 * 1000; }

// Normalisation de recherche : minuscules, sans accents, sans ponctuation —
// même souci que lib/messageHistory.js#normalizeContactKey côté campagnes.
function normalizeSearch(s) {
  return String(s == null ? '' : s)
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase().replace(/[@+\s()\-.#']/g, '');
}

// Type de discussion dérivé de l'identifiant : WhatsApp groupe = suffixe @g.us
// (ou @broadcast) ; Telegram = identifiant de chat négatif (groupes, supergroupes,
// canaux). Un drapeau isGroup explicite pris en premier (fiabilité plateforme).
function deriveConversationType(chatId, meta) {
  if (meta && meta.isGroup === true) return 'GROUP';
  const s = String(chatId || '');
  if (/@g\.us$/i.test(s) || /@broadcast$/i.test(s)) return 'GROUP';
  if (/^-\d+$/.test(s)) return 'GROUP'; // Telegram group/channel
  return 'INDIVIDUAL';
}

// Construit une entrée de message NORMALISÉE (stable, compatible ascendant) :
// tous les champs du cahier des charges 7 jours quand ils sont disponibles.
function normalizeMessage(tenantId, channel, m) {
  const ch = String(channel || 'WHATSAPP').toUpperCase();
  // Auto-détection seconds vs milliseconds : les handlers WhatsApp transmettent
  // des secondes (Baileys messageTimestamp), les handlers Telegram transmettent
  // des millisecondes (GramJS Date object). Seuil 1e12 ≈ 2001 en secondes
  // (première valeur au-dessus de laquelle la valeur est certainement en ms).
  const rawTs = Number(m.ts);
  const nowSec = Math.floor(Date.now() / 1000);
  const tsRaw = rawTs > 1e12 ? Math.floor(rawTs / 1000) : (rawTs > 0 ? rawTs : nowSec);
  const tsSec = Math.min(tsRaw, nowSec); // un horodatage futur (horloge décalée) est ramené à maintenant
  const party = String(m.party || '');
  const isGroup = deriveConversationType(m.chatId || party, m) === 'GROUP';
  const phoneOf = (id) => String(id || '').split('@')[0];
  const entry = {
    channel: ch,
    direction: m.direction === 'out' ? 'out' : 'in',
    party,
    number: m.number != null ? String(m.number) : phoneOf(party),
    name: m.name || null,
    text: String(m.text || ''),
    hasMedia: !!m.hasMedia,
    chatId: m.chatId || party,
    ts: tsSec,
    tsMs: tsSec * 1000,
    at: new Date().toISOString(),
    // identifiants techniques réels
    messageId: m.messageId != null ? String(m.messageId) : null,
    confirmationId: m.confirmationId != null ? String(m.confirmationId) : null,
    // expéditeur réel (groupes) + forme humaine
    senderId: m.senderId != null ? String(m.senderId) : null,
    senderName: m.senderName || null,
    senderPhone: m.senderPhone != null ? String(m.senderPhone) : null,
    // groupe / individu
    isGroup,
    groupId: m.groupId ? String(m.groupId) : (isGroup ? (m.chatId || party) : null),
    groupName: m.groupName || null,
    participants: Array.isArray(m.participants) ? m.participants.slice(0, 500) : null,
    // média + statut
    messageType: m.messageType || (m.hasMedia ? 'media' : 'text'),
    mediaId: m.mediaId != null ? String(m.mediaId) : null,
    status: m.status != null ? String(m.status) : null,
  };
  if (entry.senderId && !entry.senderPhone) entry.senderPhone = phoneOf(entry.senderId);
  return entry;
}

// STOCKAGE JOURNALIER : un document par (tenant, canal, jour UTC). Écritures petites, purge exacte par jour, aucun
// plafond qui rogne la fenêtre 7 jours d'un compte actif. Toute écriture d'un même (tenant, canal) est SÉRIALISÉE
// (verrou) : deux messages simultanés ne s'écrasent plus.
const DAY_MS = 24 * 3600 * 1000;
const MAX_PER_DAY = 20000; // garde-fou d'un seul jour
const dayKey = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
const shardId = (tenantId, channel, day) => `${docId(tenantId, channel)}__${day}`;

const locks = new Map();
function withLock(key, fn) {
  const next = (locks.get(key) || Promise.resolve()).then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

function windowDays(now) {
  const t = now == null ? Date.now() : now;
  const out = [];
  for (let ms = windowCutoffMs(RETENTION_DAYS) - (Date.now() - t); ms <= t + DAY_MS; ms += DAY_MS) {
    const k = dayKey(Math.min(ms, t));
    if (!out.includes(k)) out.push(k);
  }
  const last = dayKey(t);
  if (!out.includes(last)) out.push(last);
  return out;
}

const migrated = new Set();
// Ancien format (un seul document par canal) : découpé en journées au premier accès, puis supprimé.
async function migrateLegacy(tenantId, channel) {
  const id = docId(tenantId, channel);
  if (migrated.has(id)) return 0;
  migrated.add(id);
  let legacy = null;
  try { legacy = await storageAdapter.get(NAMESPACE, id, null); } catch (e) { legacy = null; }
  if (!legacy || !Array.isArray(legacy.messages)) return 0;
  const now = Date.now();
  const kept = prune(legacy.messages, now);
  const dropped = legacy.messages.length - kept.length;
  const byDay = new Map();
  for (const m of kept) { const k = dayKey(m.tsMs); (byDay.get(k) || byDay.set(k, []).get(k)).push(m); }
  for (const [day, list] of byDay) {
    const sid = shardId(tenantId, channel, day);
    const cur = await storageAdapter.get(NAMESPACE, sid, null);
    const merged = (cur && cur.messages ? cur.messages : []).concat(list);
    merged.sort((x, y) => (x.tsMs || 0) - (y.tsMs || 0));
    storageAdapter.set(NAMESPACE, sid, { tenantId: sanitize(tenantId), channel: String(channel).toUpperCase(), day, messages: merged.slice(-MAX_PER_DAY), updatedAt: new Date().toISOString() });
  }
  storageAdapter.remove(NAMESPACE, id);
  return dropped;
}

// Vue « document » de la fenêtre glissante : messages des 7×24 h, chronologiques, jamais hors fenêtre.
async function load(tenantId, channel, now) {
  const t = now == null ? Date.now() : now;
  await withLock(docId(tenantId, channel), () => migrateLegacy(tenantId, channel));
  const cutoff = t - RETENTION_DAYS * DAY_MS;
  const docs = await Promise.all(windowDays(t).map((d) => storageAdapter.get(NAMESPACE, shardId(tenantId, channel, d), null)));
  const messages = [];
  for (const d of docs) if (d && Array.isArray(d.messages)) for (const m of d.messages) { const ts = (m && m.tsMs) || 0; if (ts >= cutoff && ts <= t) messages.push(m); }
  messages.sort((x, y) => (x.tsMs || 0) - (y.tsMs || 0));
  return { tenantId: sanitize(tenantId), channel: String(channel || 'WHATSAPP').toUpperCase(), messages };
}

async function loadIndex(tenantId, channel) {
  return storageAdapter.get(INDEX_NAMESPACE, docId(tenantId, channel), { tenantId: sanitize(tenantId), channel: String(channel || 'WHATSAPP').toUpperCase(), conversations: {}, updatedAt: null });
}

// Fenêtre glissante : retire tout ce qui est hors des 7 jours, puis borne la
// taille (jamais sous la fenêtre : si la rétention par date a tout coupé, on
// garde au moins les MAX_MESSAGES derniers, protection des horloges douteuses).
function prune(messages, now) {
  const t = now == null ? Date.now() : now;
  const cutoff = t - RETENTION_DAYS * 24 * 3600 * 1000;
  // Fenêtre stricte [now - 7×24h, now] : tout ce qui est hors fenêtre est détruit,
  // sans filet de sécurité (une donnée expirée ne survit jamais).
  let kept = (Array.isArray(messages) ? messages : []).filter((m) => { const ts = (m && (m.tsMs || 0)) || 0; return ts >= cutoff && ts <= t; });
  if (kept.length > MAX_MESSAGES) kept = kept.slice(-MAX_MESSAGES);
  return kept;
}
// Fusionne les participants de groupe connus (union, sans doublon, borné).
function mergeParticipants(a, b) {
  const set = new Set((Array.isArray(a) ? a : []).map(String));
  (Array.isArray(b) ? b : []).forEach((p) => set.add(String(p)));
  return Array.from(set).slice(0, 500);
}

// Met à jour l'INDEX conversationnel à partir d'une entrée de message réelle.
// Best-effort (une panne d'index n'empêche jamais l'enregistrement du message).
// Épuration de l'index : toute conversation dont le dernier message sort de la
// fenêtre 7 jours est retirée (elle redevient éligible au nettoyage).
async function updateConversationIndex(tenantId, channel, entry, accountId) {
  const ch = String(channel || 'WHATSAPP').toUpperCase();
  const id = docId(tenantId, ch);
  try {
    const doc = await loadIndex(tenantId, ch);
    const conv = doc.conversations || {};
    const chatId = entry.chatId || entry.party || 'unknown';
    const now = entry.tsMs || Date.now();
    const type = entry.isGroup ? 'GROUP' : 'INDIVIDUAL';
    const cur = conv[chatId] || {};
    const participants = type === 'GROUP' && entry.participants ? mergeParticipants(cur.participants, entry.participants) : (cur.participants || null);
    conv[chatId] = {
      chatId,
      type,
      platform: ch,
      accountId: accountId || sanitize(tenantId),
      contactId: type === 'INDIVIDUAL' ? entry.party : null,
      contactName: type === 'INDIVIDUAL' && entry.name ? entry.name : null,
      phoneNumber: type === 'INDIVIDUAL' ? entry.number : null,
      groupId: type === 'GROUP' ? (entry.groupId || entry.chatId) : null,
      groupName: type === 'GROUP' ? (entry.groupName || cur.groupName || null) : null,
      participants,
      firstMessageAt: Math.min(cur.firstMessageAt || now, now),
      lastMessageAt: Math.max(cur.lastMessageAt || now, now),
      messageCount: (cur.messageCount || 0) + 1,
      lastMessage: entry.text || (entry.hasMedia ? '[média]' : ''),
      lastMessageDirection: entry.direction,
      lastMessageAtIso: entry.at,
      lastSenderId: entry.senderId || null,
      lastSenderName: entry.senderName || (entry.direction === 'in' ? entry.name : null) || null,
    };
    const cutoff = windowCutoffMs(RETENTION_DAYS);
    for (const k of Object.keys(conv)) {
      if ((conv[k].lastMessageAt || 0) < cutoff) delete conv[k];
    }
    doc.conversations = conv;
    doc.updatedAt = new Date().toISOString();
    return storageAdapter.set(INDEX_NAMESPACE, id, doc);
  } catch (e) {
    console.error(`conversation_index (tenant "${tenantId}", ${ch}) :`, e.message);
    return null;
  }
}

// Enregistre un message réel. direction 'in' (reçu) ou 'out' (envoyé par nous).
// `party` = l'autre partie (expéditeur si 'in', destinataire si 'out'). Pour un
// message de GROUPE, `party`/`chatId` = la discussion (groupe) et `senderId`/
// `senderName` portent l'expéditeur réel. Retourne l'entrée normalisée, ou null
// si invalide (jamais une exception).
function record(tenantId, opts) {
  if (!tenantId || !opts || !opts.party) return Promise.resolve(null);
  const ch = String(opts.channel || 'WHATSAPP').toUpperCase();
  const entry = normalizeMessage(tenantId, ch, opts);
  return withLock(docId(tenantId, ch), async () => {
    await migrateLegacy(tenantId, ch);
    const now = Date.now();
    if (entry.tsMs < now - RETENTION_DAYS * DAY_MS) return null; // hors fenêtre : jamais stocké
    const sid = shardId(tenantId, ch, dayKey(entry.tsMs));
    const doc = (await storageAdapter.get(NAMESPACE, sid, null)) || { tenantId: sanitize(tenantId), channel: ch, day: dayKey(entry.tsMs), messages: [] };
    doc.messages = Array.isArray(doc.messages) ? doc.messages : [];
    // Idempotence : un même message (id plateforme) n'est jamais enregistré deux fois (envoi Cyrus + écho, import d'historique...).
    const dup = entry.messageId
      ? doc.messages.find((m) => m.messageId === entry.messageId && m.direction === entry.direction)
      : doc.messages.find((m) => m.tsMs === entry.tsMs && m.direction === entry.direction && m.party === entry.party && m.text === entry.text);
    if (dup) {
      // Complète l'existant (ex. identifiant de confirmation connu seulement après l'envoi).
      if (entry.confirmationId && !dup.confirmationId) { dup.confirmationId = entry.confirmationId; storageAdapter.set(NAMESPACE, sid, doc); }
      return dup;
    }
    doc.messages.push(entry);
    if (doc.messages.length > 1 && doc.messages[doc.messages.length - 2].tsMs > entry.tsMs) doc.messages.sort((x, y) => (x.tsMs || 0) - (y.tsMs || 0));
    if (doc.messages.length > MAX_PER_DAY) doc.messages = doc.messages.slice(-MAX_PER_DAY);
    doc.updatedAt = new Date().toISOString();
    storageAdapter.set(NAMESPACE, sid, doc);
    await updateConversationIndex(tenantId, ch, entry, opts.accountId).catch(() => null);
    return entry;
  }).catch((err) => {
    console.error(`messageHistory.record (tenant "${tenantId}", ${ch}) :`, err.message);
    return null;
  });
}

// Derniers messages (tous sens), du plus récent au plus ancien.
async function getRecent(tenantId, channel, n) {
  const doc = await load(tenantId, channel);
  const list = (doc.messages || []).slice(-(Math.max(1, Math.min(200, n || 20))));
  return list.reverse();
}
// Dernier message REÇU (direction 'in') — l'expéditeur à qui "répondre".
async function getLastIncoming(tenantId, channel) {
  const doc = await load(tenantId, channel);
  for (let i = (doc.messages || []).length - 1; i >= 0; i -= 1) {
    if (doc.messages[i].direction === 'in') return doc.messages[i];
  }
  return null;
}
// Ensemble des messageId DEJA enregistrés (les deux directions) pour ce
// (tenant, canal) — sert l'idempotence d'un BACKFILL (voir
// adapters/telegram.js#backfillHistory) : un message historique déjà présent
// dans la mémoire 7 jours n'y est pas ré-inséré en double.
async function getMessageIds(tenantId, channel) {
  const doc = await load(tenantId, channel);
  const set = new Set();
  for (const m of (doc.messages || [])) {
    if (m && m.messageId) set.add(m.messageId);
  }
  return set;
}
// Messages échangés avec une partie précise (numéro/username) OU dans un chat
// précis (chatId = discussion individuelle OU groupe), chronologiques. Comportement
// compatible : le filtre historique (par numéro) reste valide ; le filtre par
// chatId est ajouté (groupes, discussion exacte).
async function getConversation(tenantId, channel, partyOrChat, n) {
  const doc = await load(tenantId, channel);
  const key = String(partyOrChat || '').split('@')[0].toLowerCase();
  const list = (doc.messages || []).filter((m) => String(m.number || '').toLowerCase() === key
    || String(m.party || '').toLowerCase().includes(key)
    || String(m.chatId || '').split('@')[0].toLowerCase() === key);
  return list.slice(-(Math.max(1, Math.min(500, n || 30))));
}
// Fenêtre glissante des N derniers jours (défaut 7) du contexte, un canal à la
// fois. Ne renvoie JAMAIS une donnée hors fenêtre.
async function getSince(tenantId, channel, days) {
  const doc = await load(tenantId, channel);
  const cutoff = windowCutoffMs(days || RETENTION_DAYS);
  return (doc.messages || []).filter((m) => (m.tsMs || 0) >= cutoff);
}
// TOUS les messages d'une discussion précise (chatId), dans l'ordre.
async function getConversationMessages(tenantId, channel, chatId, n) {
  const doc = await load(tenantId, channel);
  const key = String(chatId || '');
  const list = (doc.messages || []).filter((m) => String(m.chatId || '') === key || String(m.party || '') === key);
  return list.slice(-(Math.max(1, Math.min(500, n || 50))));
}
// Messages d'un GROUPE (par groupId), avec l'expéditeur de chacun.
async function getGroupMessages(tenantId, channel, groupId, n) {
  const doc = await load(tenantId, channel);
  const key = String(groupId || '');
  const list = (doc.messages || []).filter((m) => (m.isGroup && m.groupId === key) || (m.isGroup && String(m.chatId || '') === key));
  return list.slice(-(Math.max(1, Math.min(500, n || 50))));
}

// INDEX — liste des conversations de la fenêtre glissante (7 jours), la plus
// récente d'abord. Filtres DÉTERMINISTES : type (INDIVIDUAL/GROUP), canal,
// depuis N jours. Aucun appel IA ici.
async function listConversations(tenantId, channel, opts) {
  const o = opts || {};
  const requested = String(channel || '').toUpperCase();
  const channels = requested && CHANNELS.includes(requested) ? [requested] : CHANNELS;
  const cutoff = windowCutoffMs(o.sinceDays || RETENTION_DAYS);
  const out = [];
  for (const ch of channels) {
    const doc = await loadIndex(tenantId, ch);
    for (const c of Object.values(doc.conversations || {})) {
      if ((c.lastMessageAt || 0) < cutoff) continue;
      if (o.type && String(c.type).toUpperCase() !== String(o.type).toUpperCase()) continue;
      if (o.contactName && !normalizeSearch(c.contactName).includes(normalizeSearch(o.contactName))) continue;
      if (o.groupName && !normalizeSearch(c.groupName).includes(normalizeSearch(o.groupName))) continue;
      out.push(c);
    }
  }
  out.sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0));
  return out;
}

// Recherche DÉTERMINISTE par nom de contact, numéro, nom de groupe ou id :
// trouve la/l'éventuelle(s) conversation(s) candidate(s) SANS dérouler tous les
// messages. Retourne les conversations de l'index (source rapide).
async function findConversations(tenantId, opts) {
  const o = opts || {};
  const q = normalizeSearch(o.query);
  const rows = await listConversations(tenantId, o.channel, o);
  if (!q) return rows;
  return rows.filter((c) => {
    const hay = normalizeSearch([c.contactId, c.contactName, c.phoneNumber, c.groupId, c.groupName].filter(Boolean).join(' '));
    return hay.includes(q);
  });
}

// NETTOYAGE — fenêtre glissante : rend éligibles au nettoyage les données dont
// le LAST message sort des 7 jours (messages ET index), par petits lots,
// idempotent, sans bloquer les nouveaux messages (écriture locale synchrone +
// miroir fire-and-forget, jamais une grosse purge).
async function cleanupExpired(tenantId) {
  const cut = windowCutoffMs(RETENTION_DAYS);
  const report = { removedMessages: 0, removedConversations: 0, keptConversations: 0, error: null };
  try {
    for (const ch of CHANNELS) {
      const id = docId(tenantId, ch);
      report.removedMessages += await withLock(id, () => migrateLegacy(tenantId, ch));
      const cutDay = dayKey(cut);
      for (const sid of storageAdapter.listIds(NAMESPACE)) {
        const m = String(sid).match(/^(.+)__(\d{8})$/);
        if (!m || m[1] !== id) continue;
        const doc = await storageAdapter.get(NAMESPACE, sid, null);
        const count = doc && Array.isArray(doc.messages) ? doc.messages.length : 0;
        if (m[2] < cutDay) { storageAdapter.remove(NAMESPACE, sid); report.removedMessages += count; continue; }
        if (m[2] === cutDay && doc) {
          const kept = prune(doc.messages);
          if (kept.length !== count) { report.removedMessages += count - kept.length; doc.messages = kept; storageAdapter.set(NAMESPACE, sid, doc); }
        }
      }
      let idx;
      try { idx = await storageAdapter.get(INDEX_NAMESPACE, id, null); } catch (e) { idx = null; }
      if (idx && idx.conversations) {
        const before = Object.keys(idx.conversations).length;
        for (const k of Object.keys(idx.conversations)) {
          const last = idx.conversations[k] && idx.conversations[k].lastMessageAt;
          if (last == null || (Number(last) < cut)) delete idx.conversations[k];
        }
        const after = Object.keys(idx.conversations).length;
        report.removedConversations += before - after;
        report.keptConversations += after;
        if (after !== before) {
          idx.updatedAt = new Date().toISOString();
          storageAdapter.set(INDEX_NAMESPACE, id, idx);
        }
      }
    }
  } catch (e) {
    report.error = String((e && e.message) || e);
    console.error(`messageHistory.cleanupExpired (tenant "${tenantId}") :`, report.error);
  }
  return report;
}

// Balayage GLOBAL (multi-tenant) : parcourt les documents d'historique connus
// localement et nettoie chaque tenant. Idempotent, borné (CLEANUP_BATCH).
// Supprime les documents d'un namespace dont `updatedAt` (ISO ou ms) sort de la fenêtre.
async function purgeStaleDocs(namespace, now) {
  const t = now == null ? Date.now() : now;
  let removed = 0;
  for (const id of storageAdapter.listIds(namespace)) {
    const doc = await storageAdapter.get(namespace, id, null);
    const ts = doc && doc.updatedAt ? (typeof doc.updatedAt === 'number' ? doc.updatedAt : Date.parse(doc.updatedAt)) : 0;
    if (!ts || t - ts > RETENTION_DAYS * 24 * 3600 * 1000 || ts > t) { storageAdapter.remove(namespace, id); removed += 1; }
  }
  return removed;
}

async function sweepAllExpired(batch = CLEANUP_BATCH) {
  let total = { removedMessages: 0, removedConversations: 0, tenants: 0, error: null };
  try {
    const ids = storageAdapter.listIds(NAMESPACE) || [];
    const tenants = new Set();
    for (const id of ids) {
      const m = String(id).match(/^(.+?)__(WHATSAPP|TELEGRAM)(?:__\d{8})?$/i);
      if (m) tenants.add(m[1]);
    }
    const list = Array.from(tenants);
    let i = 0;
    while (i < list.length) {
      const done = i + batch;
      await Promise.all(list.slice(i, done).map((t) => cleanupExpired(t).then((r) => {
        total.removedMessages += r.removedMessages;
        total.removedConversations += r.removedConversations;
        total.tenants += 1;
      })));
      i = done;
    }
    // Autres couches contenant des données de conversation : mêmes 7×24 h.
    total.removedStates = await require('./jarvis/conversationState').purgeExpired();
    total.removedSessions = await purgeStaleDocs('closer_sessions');
  } catch (e) {
    total.error = String((e && e.message) || e);
    console.error('messageHistory.sweepAllExpired :', total.error);
  }
  return total;
}

// Job périodique LÉGER (idempotent, sans IA) : nettoie les données expirées.
// À lancer une seule fois par process (voir index.js). Fréquence par défaut :
// 60 min (économie sur une purge hebdomadaire lourde). Env: CLEANUP_MINUTES.
let _timer = null;
function startMaintenance(intervalMinutes) {
  if (_timer) return _timer;
  const mins = Number(intervalMinutes) > 0 ? Number(intervalMinutes)
    : (Number(process.env.MESSAGE_HISTORY_CLEANUP_MINUTES) > 0 ? Number(process.env.MESSAGE_HISTORY_CLEANUP_MINUTES) : DEFAULT_MAINTENANCE_MINUTES);
  const run = () => { sweepAllExpired().catch(() => {}); };
  run(); // première passe immédiate + intervalle
  _timer = setInterval(run, mins * 60 * 1000);
  _timer.unref && _timer.unref();
  return _timer;
}
function stopMaintenance() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

module.exports = {
  record, getRecent, getLastIncoming, getConversation, getSince,
  listConversations, findConversations, getConversationMessages, getGroupMessages,
  getMessageIds,
  cleanupExpired, sweepAllExpired, startMaintenance, stopMaintenance,
  updateConversationIndex, normalizeSearch, deriveConversationType, prune,
  NAMESPACE, INDEX_NAMESPACE, RETENTION_DAYS, MAX_MESSAGES, purgeStaleDocs,
};