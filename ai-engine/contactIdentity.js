// CONTACT IDENTITY RESOLVER — ai-engine/contactIdentity.js
// ---------------------------------------------------------------------------
// Couche CENTRALE qui transforme les identifiants techniques (JID, LID, id Telegram…) en identité exploitable par
// l'utilisateur. Toutes les interfaces (notifications, Chat Intelligent, rapports, mémoire, campagnes, paiements) doivent
// passer par ici pour nommer un contact.
//
// RÈGLES STRICTES
//   - Un LID (…@lid), un id de groupe, un participant technique, un id Telegram ou un id interne N'EST PAS un numéro de
//     téléphone. On ne le transforme jamais en numéro, on ne lui ajoute jamais d'indicatif pays.
//   - Seul un JID téléphonique WhatsApp (<chiffres E.164>@s.whatsapp.net / @c.us) porte un vrai numéro : c'est WhatsApp
//     lui-même qui l'indique. Le vrai numéro d'un LID n'est connu que si WhatsApp le fournit (senderPn, participantPn,
//     remoteJidAlt, événement de contact .jid). Sinon : « numéro non disponible » — jamais inventé.
//   - Ordre d'affichage : nom du contact -> numéro réel -> « Contact WhatsApp non identifié ». L'identifiant technique
//     reste dans les données techniques (jid/lid), jamais dans le texte destiné à l'utilisateur.

const storageAdapter = require('./storageAdapter');

const NAMESPACE = 'contact_identity';
const MAX_CONTACTS = 5000;

const PN_JID_RE = /^(\d{6,15})(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/i;
const LID_RE = /^(\d+)(?::\d+)?@lid$/i;
const GROUP_RE = /^[\w.-]+@g\.us$/i;
const BROADCAST_RE = /@broadcast$/i;
const UNIDENTIFIED = { WHATSAPP: 'Contact WhatsApp non identifié', TELEGRAM: 'Contact Telegram non identifié' };

// Analyse un identifiant technique. `phone` n'est renseigné QUE pour un vrai JID téléphonique.
function parseJid(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s) return { kind: 'unknown', raw: s };
  let m = s.match(PN_JID_RE);
  if (m) return { kind: 'pn', raw: s, user: m[1], phone: m[1] };
  m = s.match(LID_RE);
  if (m) return { kind: 'lid', raw: s, user: m[1], phone: null };
  if (GROUP_RE.test(s)) return { kind: 'group', raw: s, user: s.split('@')[0], phone: null };
  if (BROADCAST_RE.test(s)) return { kind: 'broadcast', raw: s, user: s.split('@')[0], phone: null };
  return { kind: 'unknown', raw: s, user: s.split('@')[0], phone: null };
}

// Texte qui ressemble à un identifiant technique (et donc inutilisable comme nom affiché).
function looksLikeTechnicalId(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return false;
  if (/@(?:lid|s\.whatsapp\.net|c\.us|g\.us|broadcast)\b/i.test(s)) return true;
  if (/^\+?[\d\s().-]+$/.test(s) && s.replace(/\D/g, '').length >= 11) return true; // suite de chiffres = pas un nom
  if (/^[0-9a-f-]{24,}$/i.test(s)) return true;
  return false;
}

// Un nom utilisable : non vide, pas un identifiant, pas juste des chiffres.
function cleanName(value) {
  const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  if (!s || s.length > 80) return null;
  if (looksLikeTechnicalId(s)) return null;
  if (/^[\d\s+().-]+$/.test(s)) return null;
  return s;
}

// Longueur de l'indicatif pays (affichage uniquement, pas de validation) : heuristique sur le plan E.164.
function ccLength(d) {
  const a = d[0];
  if (a === '1' || a === '7') return 1;
  if (a === '2') return 3; // Afrique : 2xx
  if (a === '3') return /^3(5|7|8)/.test(d) ? 3 : 2;
  if (a === '4') return /^42/.test(d) ? 3 : 2;
  if (a === '5') return /^50|^59/.test(d) ? 3 : 2;
  if (a === '6') return /^6(7|8|9)/.test(d) ? 3 : 2;
  if (a === '8') return /^8(0|5|7)/.test(d) ? 3 : 2;
  if (a === '9') return /^9(6|7|9)/.test(d) ? 3 : 2;
  return 2;
}

// « 22670123456 » -> « +226 70 12 34 56 ». Affichage seulement ; n'ajoute jamais d'indicatif.
function formatPhoneDisplay(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  if (d.length < 8 || d.length > 15) return null;
  const cc = ccLength(d);
  const rest = d.slice(cc);
  const groups = rest.match(/.{1,2}/g) || [];
  return `+${d.slice(0, cc)} ${groups.join(' ')}`.trim();
}

function isValidPhoneDigits(digits) {
  const d = String(digits || '').replace(/\D/g, '');
  return d.length >= 8 && d.length <= 15;
}

function sanitizeTenant(t) { return String(t || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'unknown'; }

// ---------------------------------------------------------------------------
// Résolution PURE (sans stockage) — fonction déterministe.
//   input : {
//     channel, jid, altJids: [..] (senderPn, participantPn, remoteJidAlt, contact.jid, contact.lid…),
//     contactName (nom enregistré dans le répertoire du compte), pushName / verifiedName (nom public WhatsApp),
//     addressBookName, knownName (nom déjà connu de Cyrus : CRM/annuaire), phone (numéro fourni explicitement par la
//     plateforme, ex. Telegram), username
//   }
// ---------------------------------------------------------------------------
function resolveIdentity(input) {
  const i = input || {};
  const channel = String(i.channel || 'WHATSAPP').toUpperCase();
  const jids = [i.jid].concat(Array.isArray(i.altJids) ? i.altJids : []).filter(Boolean).map(String);
  let jid = null; let lid = null; let phone = null; let group = null;
  for (const raw of jids) {
    const p = parseJid(raw);
    if (p.kind === 'pn' && !phone) { phone = p.phone; if (!jid) jid = raw; else if (!/@s\.whatsapp\.net|@c\.us/.test(jid)) jid = raw; }
    else if (p.kind === 'lid' && !lid) lid = raw;
    else if (p.kind === 'group' && !group) group = raw;
    else if (!jid && p.kind !== 'pn') jid = jid || raw;
  }
  // Le numéro n'est JAMAIS déduit d'un LID/id : seulement d'un JID téléphonique ou d'un champ explicite de la plateforme.
  if (!phone && i.phone && isValidPhoneDigits(i.phone)) phone = String(i.phone).replace(/\D/g, '');
  const primary = jids[0] ? parseJid(jids[0]) : { kind: 'unknown' };
  const isGroup = primary.kind === 'group' || !!group;

  const candidates = [
    ['contact_name', i.contactName],
    ['whatsapp_pushname', i.pushName],
    ['whatsapp_pushname', i.verifiedName],
    ['address_book', i.addressBookName],
    ['cyrus_known', i.knownName],
    ['telegram_profile', i.telegramName],
  ];
  let displayName = null; let nameSource = null;
  for (const [src, val] of candidates) {
    const n = cleanName(val);
    if (n) { displayName = n; nameSource = src; break; }
  }
  const username = i.username ? String(i.username).replace(/^@/, '') : null;

  const phoneDisplay = phone ? formatPhoneDisplay(phone) : null;
  let identitySource; let label;
  if (displayName) { identitySource = nameSource; label = displayName; }
  else if (phoneDisplay) { identitySource = 'phone_number'; label = phoneDisplay; }
  else if (username && channel === 'TELEGRAM') { identitySource = 'telegram_username'; label = `@${username}`; }
  else { identitySource = 'unidentified'; label = isGroup ? 'Groupe WhatsApp' : (UNIDENTIFIED[channel] || UNIDENTIFIED.WHATSAPP); }

  const technicalId = jids[0] || lid || null;
  const conversationKey = technicalId || phone || null;
  return {
    channel,
    displayName,
    phoneNumber: phone,
    internationalPhoneNumber: phone ? `+${phone}` : null,
    phoneDisplay,
    jid: jid || (primary.kind === 'lid' ? null : technicalId),
    lid,
    username,
    isGroup,
    identitySource,
    isResolved: identitySource !== 'unidentified',
    label,
    // « Nom (+226 70 12 34 56) » quand les deux sont connus, sinon le meilleur des deux.
    labelWithPhone: displayName && phoneDisplay ? `${displayName} (${phoneDisplay})` : label,
    conversationId: conversationKey ? `${channel}:${conversationKey}` : null,
  };
}

// ---------------------------------------------------------------------------
// Annuaire persistant (local) : apprend les correspondances alias <-> contact et les noms, pour qu'un même contact
// vu tantôt par son LID, tantôt par son numéro, garde une seule identité. Jamais poussé vers GitHub (LOCAL_ONLY).
// ---------------------------------------------------------------------------
async function loadDir(tenantId) {
  return storageAdapter.get(NAMESPACE, sanitizeTenant(tenantId), { tenant: sanitizeTenant(tenantId), aliases: {}, contacts: {} });
}

function aliasKeys(id) {
  const keys = [];
  if (id.phoneNumber) keys.push(`${id.channel}:pn:${id.phoneNumber}`);
  if (id.lid) keys.push(`${id.channel}:lid:${parseJid(id.lid).user}`);
  if (id.jid) { const p = parseJid(id.jid); if (p.kind !== 'pn') keys.push(`${id.channel}:jid:${id.jid}`); }
  if (id.username) keys.push(`${id.channel}:user:${id.username.toLowerCase()}`);
  return keys;
}

function newContactId(id) {
  if (id.phoneNumber) return `${id.channel.toLowerCase()}_pn_${id.phoneNumber}`;
  if (id.lid) return `${id.channel.toLowerCase()}_lid_${parseJid(id.lid).user}`;
  return `${id.channel.toLowerCase()}_${String(id.jid || id.username || Math.random().toString(36).slice(2)).replace(/[^A-Za-z0-9]/g, '_')}`;
}

// Résout ET apprend. Retourne l'identité complète avec `contactId` stable.
async function resolveContact(tenantId, input) {
  const base = resolveIdentity(input);
  const dir = await loadDir(tenantId);
  const keys = aliasKeys(base);
  let contactId = null;
  for (const k of keys) { if (dir.aliases[k]) { contactId = dir.aliases[k]; break; } }
  const known = contactId ? dir.contacts[contactId] : null;

  // Complète avec ce que l'annuaire sait déjà (nom / numéro / lid appris auparavant), sans jamais rien fabriquer.
  const merged = resolveIdentity(Object.assign({}, input, {
    knownName: (input && input.knownName) || (known && known.displayName) || null,
    altJids: [].concat((input && input.altJids) || [], known && known.lid ? [known.lid] : [], known && known.phoneNumber ? [`${known.phoneNumber}@s.whatsapp.net`] : []),
  }));

  if (!contactId) contactId = newContactId(merged);
  const now = Date.now();
  const rec = known || { contactId, channel: merged.channel, createdAt: now };
  const before = JSON.stringify([rec.displayName, rec.phoneNumber, rec.lid, rec.jid, rec.username]);
  if (merged.displayName && (merged.identitySource !== 'cyrus_known')) rec.displayName = merged.displayName;
  else if (!rec.displayName && merged.displayName) rec.displayName = merged.displayName;
  if (merged.phoneNumber) rec.phoneNumber = merged.phoneNumber;
  if (merged.lid) rec.lid = merged.lid;
  if (merged.jid) rec.jid = merged.jid;
  if (merged.username) rec.username = merged.username;
  rec.updatedAt = now;
  dir.contacts[contactId] = rec;
  let changed = !known || before !== JSON.stringify([rec.displayName, rec.phoneNumber, rec.lid, rec.jid, rec.username]);
  for (const k of aliasKeys(merged)) { if (dir.aliases[k] !== contactId) { dir.aliases[k] = contactId; changed = true; } }
  if (changed) {
    const ids = Object.keys(dir.contacts);
    if (ids.length > MAX_CONTACTS) {
      ids.sort((a, b) => (dir.contacts[a].updatedAt || 0) - (dir.contacts[b].updatedAt || 0));
      for (const old of ids.slice(0, ids.length - MAX_CONTACTS)) delete dir.contacts[old];
      for (const [k, v] of Object.entries(dir.aliases)) if (!dir.contacts[v]) delete dir.aliases[k];
    }
    await storageAdapter.set(NAMESPACE, sanitizeTenant(tenantId), dir);
  }
  return Object.assign(merged, { contactId });
}

// Lecture seule : retrouve une identité déjà connue à partir d'un identifiant technique (sans rien apprendre).
async function lookup(tenantId, channel, technicalId) {
  const ch = String(channel || 'WHATSAPP').toUpperCase();
  const p = parseJid(technicalId);
  const dir = await loadDir(tenantId);
  const key = p.kind === 'pn' ? `${ch}:pn:${p.phone}` : (p.kind === 'lid' ? `${ch}:lid:${p.user}` : `${ch}:jid:${technicalId}`);
  const contactId = dir.aliases[key];
  const rec = contactId ? dir.contacts[contactId] : null;
  return resolveIdentity({
    channel: ch, jid: technicalId,
    altJids: rec ? [rec.lid, rec.phoneNumber ? `${rec.phoneNumber}@s.whatsapp.net` : null].filter(Boolean) : [],
    knownName: rec && rec.displayName, username: rec && rec.username,
  });
}

// Libellé prêt à afficher pour un identifiant technique (jamais un JID/LID brut).
async function labelFor(tenantId, channel, technicalId, extra) {
  const id = extra ? await resolveContact(tenantId, Object.assign({ channel, jid: technicalId }, extra)) : await lookup(tenantId, channel, technicalId);
  return id.label;
}

// Filet de sécurité : retire d'un texte destiné à l'utilisateur tout identifiant technique explicite.
function scrubTechnicalIds(text) {
  return String(text == null ? '' : text)
    .replace(/\b\d{5,}(?::\d+)?@(?:lid|s\.whatsapp\.net|c\.us|g\.us|broadcast)\b/gi, '[contact]')
    .replace(/\b\d{16,}\b/g, '[identifiant]');
}

module.exports = {
  NAMESPACE, UNIDENTIFIED, parseJid, looksLikeTechnicalId, cleanName, formatPhoneDisplay, isValidPhoneDigits,
  resolveIdentity, resolveContact, lookup, labelFor, scrubTechnicalIds,
};
