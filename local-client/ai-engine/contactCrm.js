const storageAdapter = require('./storageAdapter');

// CRM DE CONTACTS — ai-engine/contactCrm.js
// ---------------------------------------------------------------------------
// Registre par tenant des personnes qui écrivent au vendeur : étiquettes
// (tags), étape du tunnel (stage), historique d'achats, première/dernière vue.
// Sert le cahier des charges "engager les prospects, les étiqueter pour
// relancer plus tard, étiqueter les acheteurs pour leur proposer d'autres
// offres" — sans jamais envoyer de message ici (ce module ne fait que MÉMOIRE
// + classification ; l'envoi reste au moteur de campagne / closing, sous les
// mêmes garde-fous d'opt-in que le reste).
//
// Persistance : un document JSON par tenant (storageAdapter, miroir GitHub),
// map `contacts` clée par `${channel}:${from}`. Le contexte par conversation
// (fil émotionnel, closing) vit ailleurs (ai-engine/emotionalCloser.js, une
// session par contact) — ce CRM en est la vue transversale (qui, quel tag,
// quelle étape), pas un doublon.

const NAMESPACE = 'crm_contacts';

// Étiquettes standard (l'agent/vendeur peut en ajouter de libres en plus).
const TAG_NEW = 'nouveau_contact';
const TAG_PROSPECT = 'prospect';
const TAG_CLIENT = 'client';

function sanitize(id) {
  return String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'unknown';
}
function contactKey(channel, from) {
  return `${sanitize(channel)}:${sanitize(from)}`;
}

async function load(tenantId) {
  return storageAdapter.get(NAMESPACE, sanitize(tenantId), { tenantId: sanitize(tenantId), contacts: {} });
}
function save(tenantId, doc) {
  doc.updatedAt = new Date().toISOString();
  return storageAdapter.set(NAMESPACE, sanitize(tenantId), doc);
}

function ensureContact(doc, channel, from) {
  const key = contactKey(channel, from);
  if (!doc.contacts[key]) {
    doc.contacts[key] = {
      key, channel: String(channel || '').toUpperCase(), from: String(from || ''),
      name: null, tags: [], stage: 'new', purchases: [],
      firstSeen: new Date().toISOString(), lastSeen: null, messageCount: 0,
    };
  }
  return doc.contacts[key];
}

function addTagsTo(contact, tags) {
  const set = new Set(contact.tags || []);
  (Array.isArray(tags) ? tags : [tags]).filter(Boolean).forEach((t) => set.add(String(t).trim().toLowerCase()));
  contact.tags = Array.from(set);
}

// Upsert à chaque message entrant d'un contact. Retourne { isNew, contact }.
// Un nouveau contact est automatiquement étiqueté `nouveau_contact` + `prospect`
// (point d'entrée du tunnel) — jamais `client` tant qu'aucun achat n'est
// confirmé (voir markPurchase).
async function recordSeen(tenantId, { channel, from, name }) {
  if (!from) return { isNew: false, contact: null };
  const doc = await load(tenantId);
  const key = contactKey(channel, from);
  const isNew = !doc.contacts[key];
  const contact = ensureContact(doc, channel, from);
  if (name && !contact.name) contact.name = String(name).slice(0, 120);
  if (isNew) addTagsTo(contact, [TAG_NEW, TAG_PROSPECT]);
  contact.lastSeen = new Date().toISOString();
  contact.messageCount = (contact.messageCount || 0) + 1;
  save(tenantId, doc);
  return { isNew, contact };
}

async function addTags(tenantId, channel, from, tags) {
  const doc = await load(tenantId);
  const contact = ensureContact(doc, channel, from);
  addTagsTo(contact, tags);
  save(tenantId, doc);
  return contact;
}

async function setStage(tenantId, channel, from, stage) {
  const doc = await load(tenantId);
  const contact = ensureContact(doc, channel, from);
  contact.stage = String(stage || 'new');
  save(tenantId, doc);
  return contact;
}

// Achat confirmé (voir ai-engine/manualPaymentValidator.js) : étiquette `client`,
// retire `nouveau_contact`, passe l'étape à `client`, garde l'historique
// d'achats pour proposer d'autres offres plus tard.
async function markPurchase(tenantId, channel, from, purchase) {
  const doc = await load(tenantId);
  const contact = ensureContact(doc, channel, from);
  addTagsTo(contact, [TAG_CLIENT]);
  // Passage prospect -> client : on retire les étiquettes d'entrée de tunnel
  // (le contact n'est plus un simple prospect une fois qu'il a acheté).
  contact.tags = (contact.tags || []).filter((t) => t !== TAG_NEW && t !== TAG_PROSPECT);
  contact.stage = 'client';
  contact.purchases = Array.isArray(contact.purchases) ? contact.purchases : [];
  contact.purchases.push(Object.assign({ at: new Date().toISOString() }, purchase || {}));
  save(tenantId, doc);
  return contact;
}

// Normalise un numéro vers son identité CANONIQUE : chiffres seuls (le « + »
// est retiré — il ferait diverger la clé de contact, car sanitize() convertit
// « + » en « _ », d'où deux clés distinctes pour le même numéro). Renvoie null
// si invalide (< 8 chiffres) — ces lignes sont rejetées à l'import.
function normalizePhone(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 8) return null;
  return digits;
}

// Import RÉEL de contacts (depuis un fichier Excel/CSV déjà parsé et mappé côté
// client). Chaque entrée : { phone, name?, fields? }. Déduplication par
// (canal, numéro normalisé) — au sein du lot ET contre l'existant. Les lignes
// sans numéro valide sont rejetées (comptées). Retourne un RAPPORT réel.
async function importContacts(tenantId, contacts, opts) {
  const o = opts || {};
  const channel = String(o.channel || 'WHATSAPP').toUpperCase();
  const source = o.source || 'import';
  const doc = await load(tenantId);
  const seenInBatch = new Set();
  let imported = 0; let updated = 0; let duplicates = 0; let invalid = 0;
  for (const entry of (Array.isArray(contacts) ? contacts : [])) {
    const phone = normalizePhone(entry && (entry.phone || entry.number || entry.telephone));
    if (!phone) { invalid += 1; continue; }
    const key = contactKey(channel, phone);
    if (seenInBatch.has(key)) { duplicates += 1; continue; }
    seenInBatch.add(key);
    const existed = !!doc.contacts[key];
    const contact = ensureContact(doc, channel, phone);
    if (entry.name && !contact.name) contact.name = String(entry.name).slice(0, 120);
    contact.source = contact.source || source;
    if (entry.fields && typeof entry.fields === 'object') {
      contact.fields = Object.assign({}, contact.fields || {}, entry.fields);
    }
    addTagsTo(contact, ['importé', TAG_PROSPECT]);
    if (existed) { updated += 1; } else { imported += 1; }
  }
  save(tenantId, doc);
  return { total: (Array.isArray(contacts) ? contacts.length : 0), imported, updated, duplicates, invalid, source, channel };
}

// Liste des contacts (filtrable par tag et/ou canal), du plus récemment vu au
// plus ancien.
async function list(tenantId, opts) {
  const o = opts || {};
  const doc = await load(tenantId);
  let items = Object.values(doc.contacts || {});
  if (o.tag) {
    const tag = String(o.tag).trim().toLowerCase();
    items = items.filter((c) => (c.tags || []).includes(tag));
  }
  if (o.channel) {
    const ch = String(o.channel).toUpperCase();
    items = items.filter((c) => c.channel === ch);
  }
  items.sort((a, b) => String(b.lastSeen || b.firstSeen).localeCompare(String(a.lastSeen || a.firstSeen)));
  return items;
}

// Compte par tag (pour un aperçu rapide "X prospects, Y clients").
async function counts(tenantId) {
  const doc = await load(tenantId);
  const byTag = {};
  for (const c of Object.values(doc.contacts || {})) {
    for (const t of (c.tags || [])) byTag[t] = (byTag[t] || 0) + 1;
  }
  return { total: Object.keys(doc.contacts || {}).length, byTag };
}

// Registre de refus : un contact qui a refusé/demandé l'arrêt ne doit plus être
// sollicité (campagnes, relances, envois autonomes) tant qu'il ne revient pas.
const TAG_OPTOUT = 'ne_pas_contacter';
function identityOf(from) {
  const raw = String(from == null ? '' : from).split('@')[0];
  return normalizePhone(raw) || raw;
}

async function markOptOut(tenantId, channel, from, reason) {
  const doc = await load(tenantId);
  const contact = ensureContact(doc, channel, identityOf(from));
  contact.optOut = { at: new Date().toISOString(), reason: String(reason || 'REFUSAL') };
  addTagsTo(contact, [TAG_OPTOUT]);
  contact.stage = 'refused';
  save(tenantId, doc);
  return contact;
}

async function clearOptOut(tenantId, channel, from) {
  const doc = await load(tenantId);
  const key = contactKey(channel, identityOf(from));
  const contact = doc.contacts[key];
  if (!contact || !contact.optOut) return false;
  contact.optOut = null;
  contact.tags = (contact.tags || []).filter((t) => t !== TAG_OPTOUT);
  contact.stage = 'new';
  save(tenantId, doc);
  return true;
}

async function isOptedOut(tenantId, channel, from) {
  const doc = await load(tenantId);
  const c = doc.contacts[contactKey(channel, identityOf(from))];
  return !!(c && c.optOut);
}

// Ensemble des identités refusantes d'un canal (pour filtrer un lot d'envoi)
async function optedOutSet(tenantId, channel) {
  const doc = await load(tenantId);
  const ch = String(channel || '').toUpperCase();
  const out = new Set();
  for (const c of Object.values(doc.contacts || {})) {
    if (c.optOut && (!ch || c.channel === ch)) out.add(identityOf(c.from));
  }
  return out;
}

async function getContact(tenantId, channel, from) {
  const doc = await load(tenantId);
  return doc.contacts[contactKey(channel, identityOf(from))] || null;
}
async function updateContact(tenantId, channel, from, patch) {
  const doc = await load(tenantId);
  const contact = ensureContact(doc, channel, identityOf(from));
  const allowed = ['name', 'stage', 'notes', 'fields'];
  for (const k of allowed) if (patch && patch[k] !== undefined) contact[k] = k === 'fields' ? Object.assign({}, contact.fields || {}, patch[k]) : patch[k];
  save(tenantId, doc);
  return contact;
}
async function removeContact(tenantId, channel, from) {
  const doc = await load(tenantId);
  const key = contactKey(channel, identityOf(from));
  const existed = !!doc.contacts[key];
  delete doc.contacts[key];
  if (existed) save(tenantId, doc);
  return existed;
}

// ---- COMMUNAUTÉS DÉCOUVERTES (groupes/canaux publics) : dans la MÊME base CRM (doc.communities), volontairement SÉPARÉES des contacts-personnes
// (doc.contacts) : une communauté n'est jamais une cible de campagne « personne ». Clé = canal + identifiant public (@username / code d'invitation).
async function upsertCommunity(tenantId, c) {
  const doc = await load(tenantId);
  doc.communities = doc.communities || {};
  const key = contactKey(c.channel, c.ref);
  const before = doc.communities[key] || null;
  const now = new Date().toISOString();
  const keywords = Array.from(new Set([].concat((before && before.keywords) || [], c.keywords || []).map((k) => String(k).toLowerCase()).filter(Boolean)));
  doc.communities[key] = {
    key, channel: String(c.channel).toUpperCase(), ref: String(c.ref), name: String(c.name || '').slice(0, 160), link: c.link || null,
    kind: c.kind || 'group', members: c.members != null ? Number(c.members) : (before && before.members) || null, description: String(c.description || (before && before.description) || '').slice(0, 400),
    keywords, verified: !!c.verified, tags: Array.from(new Set(['communauté', 'découverte'].concat((before && before.tags) || []))),
    location: c.location || (before && before.location) || null,
    // Préservés depuis `before` : une resynchronisation (voir communityDiscovery.js#syncToCrm, rappelée avant
    // chaque adhésion/extraction côté dashboard) ne doit JAMAIS effacer l'adhésion WhatsApp déjà enregistrée par
    // markCommunityJoined — sinon extractMembers échouerait à tort avec NOT_JOINED juste après un "Rejoindre" réussi.
    joinedGroupId: (before && before.joinedGroupId) || null, joinedAt: (before && before.joinedAt) || null,
    firstSyncedAt: (before && before.firstSyncedAt) || now, syncedAt: now,
  };
  await save(tenantId, doc);
  return { created: !before, community: doc.communities[key] };
}
async function listCommunities(tenantId, opts) {
  const doc = await load(tenantId);
  let items = Object.values(doc.communities || {});
  const o = opts || {};
  if (o.channel) items = items.filter((c) => c.channel === String(o.channel).toUpperCase());
  if (o.keyword) { const k = String(o.keyword).toLowerCase(); items = items.filter((c) => (c.keywords || []).includes(k) || String(c.name).toLowerCase().includes(k)); }
  return items.sort((a, b) => String(b.syncedAt).localeCompare(String(a.syncedAt)));
}
async function getCommunity(tenantId, channel, ref) {
  const doc = await load(tenantId);
  return (doc.communities || {})[contactKey(channel, ref)] || null;
}
// Adhésion WhatsApp EXPLICITE à un groupe déjà découvert (voir
// adapters/whatsappEngineBaileys.js#joinGroupByInvite) : mémorise le JID réel
// du groupe rejoint (distinct de `ref`, le code d'invitation) pour que
// communityDiscovery#extractMembers sache ensuite quel groupe lire sans
// dépendre d'un second appel de résolution.
async function markCommunityJoined(tenantId, channel, ref, joinedGroupId) {
  const doc = await load(tenantId);
  const key = contactKey(channel, ref);
  const community = doc.communities && doc.communities[key];
  if (!community) return null;
  community.joinedGroupId = String(joinedGroupId || '');
  community.joinedAt = new Date().toISOString();
  await save(tenantId, doc);
  return community;
}

module.exports = {
  upsertCommunity, listCommunities, getCommunity, markCommunityJoined,
  getContact, updateContact, removeContact,
  markOptOut, clearOptOut, isOptedOut, optedOutSet, identityOf, TAG_OPTOUT,
  recordSeen, addTags, setStage, markPurchase, list, counts,
  importContacts, normalizePhone,
  TAG_NEW, TAG_PROSPECT, TAG_CLIENT, NAMESPACE,
};
