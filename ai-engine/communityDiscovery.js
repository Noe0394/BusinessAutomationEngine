// DÉCOUVERTE DE COMMUNAUTÉS THÉMATIQUES — ai-engine/communityDiscovery.js
// ---------------------------------------------------------------------------
// Trouve des groupes/canaux PUBLICS correspondant à des mots-clés sectoriels, et les synchronise dans la base CRM locale (doc.communities).
//   • Telegram : recherche GLOBALE officielle (API contacts.Search) — seuls les canaux/groupes publics (avec @username, donc lien officiel
//     https://t.me/<username>) sont retenus, avec titre, type et nombre de membres quand Telegram le fournit.
//   • WhatsApp : WhatsApp n'offre AUCUNE API de recherche de groupes publics. La découverte passe par les ANNUAIRES PUBLICS du web : une
//     recherche web de liens d'invitation officiels (chat.whatsapp.com/<code>) pour les mots-clés, puis chaque code est VÉRIFIÉ auprès de
//     WhatsApp (nom, taille, description réels, sans rejoindre le groupe). Un lien non vérifiable est marqué « non vérifié », jamais présenté
//     comme confirmé. La qualité dépend des annuaires publics disponibles (fournisseur configurable : WHATSAPP_DIRECTORY_SEARCH_URL).
// Aucun envoi, aucune adhésion automatique : ce module ne fait que LISTER et enregistrer.
const axios = require('axios');
const contactCrm = require('./contactCrm');
const { jidToE164 } = require('../lib/whatsappRecipients');

const MAX_KEYWORDS = 5;
const cleanKeywords = (k) => [...new Set((Array.isArray(k) ? k : String(k || '').split(/[,;\n]/)).map((s) => String(s).trim().toLowerCase().replace(/[\u0000-\u001f]/g, ' ')).filter((s) => s.length >= 2 && s.length <= 60))].slice(0, MAX_KEYWORDS);

let sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

// locationSuffix (voir buildLocationSuffix) : Telegram n'a aucun filtre géographique natif dans contacts.Search —
// la localisation est donc simplement ajoutée au texte du mot-clé (ex: "immobilier Dakar"), comme le ferait une
// recherche humaine ; ne change rien quand locationSuffix est vide.
async function searchTelegram(tenant, keywords, limit, locationSuffix) {
  const session = require('../adapters/telegramManager').getOrCreate(tenant).session;
  if (!session || typeof session.isConnected !== 'function' || !session.isConnected()) { const e = new Error('Telegram n\'est pas connecté.'); e.code = 'TELEGRAM_NOT_CONNECTED'; throw e; }
  const out = [];
  for (const kw of keywords) {
    let found = [];
    try { found = await session.searchPublicCommunities(`${kw}${locationSuffix || ''}`, limit); } catch (err) { if (/FLOOD/i.test(String(err && (err.errorMessage || err.message)))) break; continue; }
    for (const c of found) out.push({ channel: 'TELEGRAM', ref: `@${c.username}`, name: c.title, link: `https://t.me/${c.username}`, kind: c.isChannel ? 'channel' : 'group', members: c.participants, description: '', verified: true, keyword: kw });
    await sleepFn(800);
  }
  return out;
}

const WA_LINK_RE = /chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{16,24})/g;
function extractInviteCodes(html) {
  const codes = new Set(); let m;
  const txt = String(html || '').replace(/&amp;/g, '&');
  WA_LINK_RE.lastIndex = 0;
  while ((m = WA_LINK_RE.exec(txt))) codes.add(m[1]);
  return [...codes];
}

// Annuaire public : ni Google ni Facebook n'offrent d'API de recherche gratuite pour cet usage (Google bloque le
// scraping automatisé par CAPTCHA ; Facebook a fermé la recherche de groupes par API depuis 2018) — ces moteurs
// indexent déjà les pages PUBLIQUES (Facebook, forums, annuaires...) qui mentionnent un lien d'invitation
// WhatsApp, ce qui couvre "tout internet" sans dépendre d'une clé payante. Interrogés EN PARALLÈLE (Promise.
// allSettled, quelques secondes au total, jamais en série) : un moteur qui échoue ou bloque ne retarde ni ne casse
// les autres, il contribue juste zéro résultat. Fournisseur personnalisé (WHATSAPP_DIRECTORY_SEARCH_URL) toujours
// prioritaire s'il est défini, pour compatibilité ascendante et pour permettre de brancher un annuaire dédié.
const SEARCH_ENGINES = [
  { name: 'duckduckgo', urlTpl: 'https://html.duckduckgo.com/html/?q={q}' },
  { name: 'bing', urlTpl: 'https://www.bing.com/search?q={q}&count=30' },
  { name: 'startpage', urlTpl: 'https://www.startpage.com/sp/search?query={q}' },
];

async function fetchEngineHtml(urlTpl, query) {
  const url = urlTpl.replace('{q}', encodeURIComponent(query));
  const res = await axios.get(url, { timeout: 12000, responseType: 'text', headers: { 'user-agent': 'Mozilla/5.0 (compatible; CyrusDirectory/1.0)' }, validateStatus: (s) => s >= 200 && s < 400 });
  return typeof res.data === 'string' ? res.data : '';
}

// location : chaîne libre déjà composée (voir buildLocationSuffix) — ajoutée au texte de recherche pour préciser
// par pays/ville/département, jamais un filtre appliqué après coup (les moteurs de recherche web font déjà ce
// travail mieux qu'un filtrage local).
async function webDirectorySearch(keyword, location) {
  const query = `"chat.whatsapp.com" ${keyword}${location || ''} groupe whatsapp`;
  const custom = process.env.WHATSAPP_DIRECTORY_SEARCH_URL;
  const engines = custom ? [{ name: 'custom', urlTpl: custom }] : SEARCH_ENGINES;
  const settled = await Promise.allSettled(engines.map((e) => fetchEngineHtml(e.urlTpl, query)));
  const codes = new Set();
  for (const r of settled) {
    if (r.status !== 'fulfilled') continue;
    extractInviteCodes(r.value).forEach((c) => codes.add(c));
  }
  return [...codes];
}

// { country?, city?, department? } -> " Ville Département Pays" (chaîne prête à concaténer à un mot-clé), ou ''
// si rien n'est renseigné — la recherche par thématique seule reste inchangée sans localisation.
function buildLocationSuffix(location) {
  const l = location || {};
  const parts = [l.city, l.department, l.country].map((s) => String(s || '').trim()).filter(Boolean);
  return parts.length ? ` ${parts.join(' ')}` : '';
}

async function searchWhatsApp(tenant, keywords, limit, deps, locationSuffix) {
  const search = (deps && deps.directorySearch) || ((kw) => webDirectorySearch(kw, locationSuffix));
  let session = null;
  try { session = require('../adapters/whatsappManager').getOrCreate(tenant).session; } catch (e) { session = null; }
  const canVerify = !!session && (typeof session.isConnected !== 'function' || session.isConnected()) && typeof session.getInviteInfo === 'function';
  const out = []; const seen = new Set();
  for (const kw of keywords) {
    let codes = [];
    try { codes = await search(kw); } catch (err) { continue; }
    for (const code of codes.slice(0, limit)) {
      if (seen.has(code)) continue; seen.add(code);
      const base = { channel: 'WHATSAPP', ref: code, link: `https://chat.whatsapp.com/${code}`, kind: 'group', keyword: kw };
      if (canVerify) {
        try {
          const info = await session.getInviteInfo(code);
          out.push(Object.assign(base, { name: info.subject || 'Groupe WhatsApp', members: info.size, description: info.description || '', verified: true }));
        } catch (err) { /* lien expiré/révoqué : écarté (jamais présenté comme valide) */ }
        await sleepFn(1200);
      } else out.push(Object.assign(base, { name: 'Groupe WhatsApp (non vérifié)', members: null, description: '', verified: false }));
    }
  }
  return out;
}

// input : { channel, keywords, limit?, sync?, location?:{country?,city?,department?} } -> { channel, keywords, results:[...], synced }
async function discover(tenant, input, deps) {
  const channel = String(input.channel || 'TELEGRAM').toUpperCase();
  if (!['WHATSAPP', 'TELEGRAM'].includes(channel)) { const e = new Error('Canal inconnu (WHATSAPP ou TELEGRAM).'); e.code = 'INVALID_CHANNEL'; throw e; }
  const keywords = cleanKeywords(input.keywords);
  if (!keywords.length) { const e = new Error('Indiquez au moins un mot-clé (2 caractères minimum).'); e.code = 'KEYWORDS_REQUIRED'; throw e; }
  const limit = Math.min(30, Math.max(1, Number(input.limit) || 15));
  const locationSuffix = buildLocationSuffix(input.location);
  const raw = channel === 'TELEGRAM' ? await searchTelegram(tenant, keywords, limit, locationSuffix) : await searchWhatsApp(tenant, keywords, limit, deps, locationSuffix);
  const byRef = new Map();
  for (const r of raw) { const k = `${r.channel}:${r.ref}`; const prev = byRef.get(k); if (prev) prev.keywords = [...new Set(prev.keywords.concat(r.keyword))]; else byRef.set(k, Object.assign({}, r, { keywords: [r.keyword], location: locationSuffix.trim() || null })); }
  const results = [...byRef.values()].map(({ keyword, ...rest }) => rest);
  const out = { channel, keywords, results, synced: 0 };
  if (input.sync) out.synced = (await syncToCrm(tenant, results)).count;
  return out;
}

// Synchronisation vers la base CRM locale (communautés, séparées des contacts-personnes).
async function syncToCrm(tenant, communities) {
  let created = 0; let updated = 0;
  for (const c of communities || []) {
    if (!c || !c.ref || !c.channel) continue;
    const r = await contactCrm.upsertCommunity(tenant, { channel: c.channel, ref: c.ref, name: c.name, link: c.link, kind: c.kind, members: c.members, description: c.description, keywords: c.keywords, verified: c.verified, location: c.location || null });
    if (r.created) created += 1; else updated += 1;
  }
  return { count: created + updated, created, updated };
}

// ---------------------------------------------------------------------------
// RECHERCHE DE PERSONNES PAR THÉMATIQUE — Telegram uniquement : contrairement
// aux groupes/canaux (titre + description en clair, donc réellement liés à un
// thème), un profil personne n'expose que son nom/pseudo — Telegram et
// WhatsApp n'exposent aucun "centre d'intérêt" public. Une recherche par
// mot-clé sur des PERSONNES reste donc une correspondance de TEXTE sur le
// nom/pseudo (ex: chercher "immobilier" trouve un compte nommé
// "ImmobilierParis"), jamais un vrai ciblage par intérêt réel de la personne —
// annoncé explicitement à l'appelant via `approximate: true` plutôt que
// présenté comme une correspondance thématique fiable.
// WhatsApp n'a par ailleurs AUCUN annuaire public de personnes (contrairement
// aux groupes, dont les liens d'invitation finissent indexés sur le web) :
// aucune recherche de personnes n'y est possible par des moyens légitimes.
// locationSuffix : bien moins efficace ici que pour les groupes (le pseudo/nom d'une personne contient rarement
// une ville), mais ajouté par cohérence avec discover() — sans effet quand vide.
async function searchPeopleTelegram(tenant, keywords, limit, locationSuffix) {
  const session = require('../adapters/telegramManager').getOrCreate(tenant).session;
  if (!session || typeof session.isConnected !== 'function' || !session.isConnected()) { const e = new Error('Telegram n\'est pas connecté.'); e.code = 'TELEGRAM_NOT_CONNECTED'; throw e; }
  const out = [];
  for (const kw of keywords) {
    let found = [];
    try { found = await session.searchPublicPeople(`${kw}${locationSuffix || ''}`, limit); } catch (err) { if (/FLOOD/i.test(String(err && (err.errorMessage || err.message)))) break; continue; }
    for (const u of found) out.push({ channel: 'TELEGRAM', ref: u.id, name: u.name, username: u.username, link: `https://t.me/${u.username}`, keyword: kw });
    await sleepFn(800);
  }
  return out;
}

// input : { channel, keywords, limit?, sync?, location? } -> { channel, keywords, results:[...], approximate, synced }
async function discoverPeople(tenant, input) {
  const channel = String(input.channel || 'TELEGRAM').toUpperCase();
  if (channel === 'WHATSAPP') { const e = new Error('WhatsApp ne fournit aucun annuaire public de personnes : aucune recherche de personnes n\'y est possible.'); e.code = 'NO_PUBLIC_PEOPLE_DIRECTORY'; throw e; }
  if (channel !== 'TELEGRAM') { const e = new Error('Canal inconnu (TELEGRAM uniquement pour la recherche de personnes).'); e.code = 'INVALID_CHANNEL'; throw e; }
  const keywords = cleanKeywords(input.keywords);
  if (!keywords.length) { const e = new Error('Indiquez au moins un mot-clé (2 caractères minimum).'); e.code = 'KEYWORDS_REQUIRED'; throw e; }
  const limit = Math.min(30, Math.max(1, Number(input.limit) || 15));
  const raw = await searchPeopleTelegram(tenant, keywords, limit, buildLocationSuffix(input.location));
  const byRef = new Map();
  for (const r of raw) { const k = `${r.channel}:${r.ref}`; const prev = byRef.get(k); if (prev) prev.keywords = [...new Set(prev.keywords.concat(r.keyword))]; else byRef.set(k, Object.assign({}, r, { keywords: [r.keyword] })); }
  const results = [...byRef.values()].map(({ keyword, ...rest }) => rest);
  const out = { channel, keywords, results, approximate: true, synced: 0 };
  if (input.sync) out.synced = (await syncPeopleToCrm(tenant, results)).count;
  return out;
}

// Synchronise des PERSONNES découvertes (recherche directe ou extraction de
// membres, voir extractMembers ci-dessous) vers le CRM comme PROSPECTS à
// valider — jamais contactées automatiquement (voir
// ai-engine/contactCrm.js#recordSeen, qui étiquette tout nouveau contact
// `prospect`, et ai-engine/clientLimitGuard.js/campaignEngine.js, qui restent
// les SEULS chemins d'envoi réel, jamais déclenchés ici). Le(s) mot-clé(s) de
// découverte sont ajoutés comme étiquettes pour retrouver ce lot plus tard.
async function syncPeopleToCrm(tenant, people) {
  const rows = [];
  const tagTargets = [];
  const batchId = require('node:crypto').randomUUID();
  for (const p of people || []) {
    if (!p || !p.ref || !p.channel) continue;
    const channel = String(p.channel).toUpperCase();
    const identity = require('./contactIdentity').resolveIdentity({
      channel,
      jid: channel === 'WHATSAPP' || !String(p.ref).startsWith('@') ? p.ref : undefined,
      username: channel === 'TELEGRAM' && String(p.ref).startsWith('@') ? String(p.ref).slice(1) : undefined,
      phone: /^\+|^00/.test(String(p.ref)) ? p.ref : undefined,
      knownName: p.name || null,
    });
    const source = p.groupId ? 'group_extraction' : 'contact_discovery';
    rows.push({ channel, from: identity.phoneNumber || p.ref, name: p.name, identity, source,
      eventId: `${batchId}:${channel}:${p.ref}`,
      context: { groupId: p.groupId, groupName: p.groupName, interests: p.keywords || [] },
    });
    tagTargets.push({ channel, ref: p.ref, keywords: p.keywords || [] });
  }
  const report = await contactCrm.recordBatch(tenant, rows, { source: 'contact_discovery', batchId });
  for (const target of tagTargets) await contactCrm.addTags(tenant, target.channel, target.ref, ['decouverte'].concat(target.keywords));
  return { count: report.total, created: report.created, updated: report.updated };
}

// ---------------------------------------------------------------------------
// EXTRACTION DE MEMBRES D'UNE COMMUNAUTÉ DÉCOUVERTE — deuxième voie
// (indirecte) pour trouver des personnes par thème : une fois un groupe
// public lié à un thème découvert (voir discover), on en extrait les membres
// comme « personnes intéressées par ce thème ».
//   • Telegram : lit le groupe public directement — AUCUNE adhésion requise
//     (voir adapters/telegram.js#getGroupMembers, qui résout désormais un
//     @username public sans avoir besoin d'un id numérique déjà connu).
//   • WhatsApp : Baileys ne peut lire les participants que des groupes dont ce
//     compte est RÉELLEMENT membre (aucune API de prévisualisation) — voir
//     joinCommunity ci-dessous, une adhésion EXPLICITE et VOLONTAIRE, jamais
//     déclenchée automatiquement par cette fonction.
async function extractMembersTelegram(tenant, community) {
  const session = require('../adapters/telegramManager').getOrCreate(tenant).session;
  if (!session || typeof session.isConnected !== 'function' || !session.isConnected()) { const e = new Error('Telegram n\'est pas connecté.'); e.code = 'TELEGRAM_NOT_CONNECTED'; throw e; }
  const members = await session.getGroupMembers(community.ref, { limit: 200 });
  return members.map((m) => ({ channel: 'TELEGRAM', ref: m.id, name: m.name }));
}

async function extractMembersWhatsApp(tenant, community) {
  if (!community.joinedGroupId) { const e = new Error('Ce groupe WhatsApp n\'a pas encore été rejoint — utilisez joinCommunity avant d\'extraire ses membres.'); e.code = 'NOT_JOINED'; throw e; }
  const session = require('../adapters/whatsappManager').getOrCreate(tenant).session;
  const participants = await session.getGroupParticipants(community.joinedGroupId);
  const out = [];
  for (const p of (participants || [])) {
    // Même règle que /api/groups/export-members (index.js) : .jid porte le
    // vrai numéro, .id peut être un @lid (identité anonyme) sans rapport avec
    // le numéro réel — un membre indérivable est omis plutôt que d'y laisser
    // un numéro faux.
    const phoneJid = p.jid && !p.jid.endsWith('@lid') ? p.jid : (p.id && !p.id.endsWith('@lid') ? p.id : null);
    const e164 = phoneJid ? jidToE164(phoneJid) : '';
    if (!phoneJid || !e164) continue;
    out.push({ channel: 'WHATSAPP', ref: phoneJid, name: (typeof session.getContactName === 'function' && session.getContactName(phoneJid)) || '' });
  }
  return out;
}

// input : { channel, ref } -> { channel, ref, found, synced }
async function extractMembers(tenant, input) {
  const channel = String((input && input.channel) || '').toUpperCase();
  const ref = input && input.ref;
  if (!ref) { const e = new Error('Indiquez la communauté (ref) dont extraire les membres.'); e.code = 'REF_REQUIRED'; throw e; }
  const community = await contactCrm.getCommunity(tenant, channel, ref);
  if (!community) { const e = new Error('Communauté inconnue — lancez d\'abord une découverte (discover) puis synchronisez-la.'); e.code = 'COMMUNITY_NOT_FOUND'; throw e; }
  const people = channel === 'TELEGRAM' ? await extractMembersTelegram(tenant, community) : await extractMembersWhatsApp(tenant, community);
  const withKeywords = people.map((p) => Object.assign({ keywords: community.keywords, groupId: community.ref, groupName: community.name }, p));
  const { count } = await syncPeopleToCrm(tenant, withKeywords);
  return { channel, ref, found: people.length, synced: count };
}

// Adhésion WhatsApp EXPLICITE à un groupe déjà découvert — un clic = un
// groupe, jamais en masse (voir la justification complète dans
// adapters/whatsappEngineBaileys.js#joinGroupByInvite : imiter une adhésion
// en rafale a déjà provoqué des révocations WhatsApp par le passé).
async function joinCommunity(tenant, input) {
  const channel = String((input && input.channel) || '').toUpperCase();
  const ref = input && input.ref;
  if (channel !== 'WHATSAPP') { const e = new Error('L\'adhésion explicite n\'est utile que pour WhatsApp (Telegram se lit sans adhésion).'); e.code = 'INVALID_CHANNEL'; throw e; }
  if (!ref) { const e = new Error('Indiquez la communauté (ref) à rejoindre.'); e.code = 'REF_REQUIRED'; throw e; }
  const community = await contactCrm.getCommunity(tenant, channel, ref);
  if (!community) { const e = new Error('Communauté inconnue — lancez d\'abord une découverte (discover) puis synchronisez-la.'); e.code = 'COMMUNITY_NOT_FOUND'; throw e; }
  const session = require('../adapters/whatsappManager').getOrCreate(tenant).session;
  const { id } = await session.joinGroupByInvite(ref);
  return contactCrm.markCommunityJoined(tenant, channel, ref, id);
}

module.exports = {
  discover, syncToCrm, extractInviteCodes, cleanKeywords, webDirectorySearch,
  discoverPeople, extractMembers, joinCommunity, syncPeopleToCrm,
  _setSleep: (fn) => { sleepFn = fn; },
};
