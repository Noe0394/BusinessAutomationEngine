const storageAdapter = require('./storageAdapter');

// HISTORIQUE DE MESSAGES PERSISTANT (>= 7 jours) — ai-engine/messageHistory.js
// ---------------------------------------------------------------------------
// Mémoire opérationnelle réelle du contexte récent : chaque message entrant ET
// sortant (WhatsApp/Telegram) est enregistré de façon PERSISTANTE (survit à un
// redémarrage), par tenant + canal. Permet à l'agent de : retrouver le dernier
// message réel + son expéditeur, reconstituer une conversation, exploiter le
// contexte des 7 derniers jours, et comprendre le style de l'utilisateur.
//
// Un document par (tenant, canal). Rétention : on garde au moins RETENTION_DAYS
// jours ET au plus MAX_MESSAGES entrées (le plus permissif des deux, pour ne
// jamais perdre le contexte récent tout en bornant la taille).

const NAMESPACE = 'message_history';
const RETENTION_DAYS = 30; // >= 7 exigés ; on garde plus si la taille le permet
const MAX_MESSAGES = 4000;

function sanitize(id) { return String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default'; }
function docId(tenantId, channel) { return `${sanitize(tenantId)}__${sanitize(String(channel || 'WHATSAPP').toUpperCase())}`; }

async function load(tenantId, channel) {
  return storageAdapter.get(NAMESPACE, docId(tenantId, channel), { tenantId: sanitize(tenantId), channel: String(channel || 'WHATSAPP').toUpperCase(), messages: [] });
}
function prune(messages) {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 3600 * 1000;
  let kept = messages.filter((m) => (m.tsMs || 0) >= cutoff);
  if (kept.length > MAX_MESSAGES) kept = kept.slice(-MAX_MESSAGES);
  // Si la rétention par date a tout coupé (horloges/ts douteux), garder au moins
  // les MAX_MESSAGES derniers bruts.
  if (!kept.length && messages.length) kept = messages.slice(-MAX_MESSAGES);
  return kept;
}
function save(tenantId, channel, doc) {
  doc.messages = prune(doc.messages || []);
  doc.updatedAt = new Date().toISOString();
  return storageAdapter.set(NAMESPACE, docId(tenantId, channel), doc);
}

// Enregistre un message. direction 'in' (reçu) ou 'out' (envoyé par nous).
// `party` = l'autre partie (expéditeur si 'in', destinataire si 'out').
function record(tenantId, { channel, direction, party, name, text, ts, chatId, hasMedia, confirmationId }) {
  if (!tenantId || !party) return null;
  const ch = String(channel || 'WHATSAPP').toUpperCase();
  // Chargement synchrone-ish : storageAdapter.get est async ; on encapsule.
  return load(tenantId, ch).then((doc) => {
    const tsSec = Number(ts) > 0 ? Number(ts) : Math.floor(Date.now() / 1000);
    const entry = {
      channel: ch,
      direction: direction === 'out' ? 'out' : 'in',
      party: String(party),
      number: String(party).split('@')[0],
      name: name || null,
      text: String(text || ''),
      hasMedia: !!hasMedia,
      chatId: chatId || String(party),
      ts: tsSec,
      tsMs: tsSec * 1000,
      confirmationId: confirmationId || null,
      at: new Date().toISOString(),
    };
    doc.messages = Array.isArray(doc.messages) ? doc.messages : [];
    doc.messages.push(entry);
    save(tenantId, ch, doc);
    return entry;
  }).catch(() => null);
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
// Messages échangés avec une partie précise (numéro/username), chronologiques.
async function getConversation(tenantId, channel, party, n) {
  const doc = await load(tenantId, channel);
  const key = String(party || '').split('@')[0].toLowerCase();
  const list = (doc.messages || []).filter((m) => String(m.number || '').toLowerCase() === key || String(m.party || '').toLowerCase().includes(key));
  return list.slice(-(Math.max(1, Math.min(200, n || 30))));
}
// Fenêtre glissante des N derniers jours (contexte 7 jours), tous canaux si
// channel omis n'est pas supporté ici — un canal à la fois.
async function getSince(tenantId, channel, days) {
  const doc = await load(tenantId, channel);
  const cutoff = Date.now() - (days || 7) * 24 * 3600 * 1000;
  return (doc.messages || []).filter((m) => (m.tsMs || 0) >= cutoff);
}

module.exports = { record, getRecent, getLastIncoming, getConversation, getSince, NAMESPACE, RETENTION_DAYS };
