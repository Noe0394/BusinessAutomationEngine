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

const MAX_KEYWORDS = 5;
const cleanKeywords = (k) => [...new Set((Array.isArray(k) ? k : String(k || '').split(/[,;\n]/)).map((s) => String(s).trim().toLowerCase().replace(/[\u0000-\u001f]/g, ' ')).filter((s) => s.length >= 2 && s.length <= 60))].slice(0, MAX_KEYWORDS);

let sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

async function searchTelegram(tenant, keywords, limit) {
  const session = require('../adapters/telegramManager').getOrCreate(tenant).session;
  if (!session || typeof session.isConnected !== 'function' || !session.isConnected()) { const e = new Error('Telegram n\'est pas connecté.'); e.code = 'TELEGRAM_NOT_CONNECTED'; throw e; }
  const out = [];
  for (const kw of keywords) {
    let found = [];
    try { found = await session.searchPublicCommunities(kw, limit); } catch (err) { if (/FLOOD/i.test(String(err && (err.errorMessage || err.message)))) break; continue; }
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

// Annuaire public : par défaut une recherche web ciblée sur les liens d'invitation officiels. Fournisseur remplaçable.
async function webDirectorySearch(keyword) {
  const tpl = process.env.WHATSAPP_DIRECTORY_SEARCH_URL || 'https://html.duckduckgo.com/html/?q={q}';
  const url = tpl.replace('{q}', encodeURIComponent(`"chat.whatsapp.com" ${keyword} groupe whatsapp`));
  const res = await axios.get(url, { timeout: 15000, responseType: 'text', headers: { 'user-agent': 'Mozilla/5.0 (compatible; CyrusDirectory/1.0)' }, validateStatus: (s) => s >= 200 && s < 400 });
  return extractInviteCodes(typeof res.data === 'string' ? res.data : '');
}

async function searchWhatsApp(tenant, keywords, limit, deps) {
  const search = (deps && deps.directorySearch) || webDirectorySearch;
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

// input : { channel, keywords, limit?, sync? } -> { channel, keywords, results:[...], synced }
async function discover(tenant, input, deps) {
  const channel = String(input.channel || 'TELEGRAM').toUpperCase();
  if (!['WHATSAPP', 'TELEGRAM'].includes(channel)) { const e = new Error('Canal inconnu (WHATSAPP ou TELEGRAM).'); e.code = 'INVALID_CHANNEL'; throw e; }
  const keywords = cleanKeywords(input.keywords);
  if (!keywords.length) { const e = new Error('Indiquez au moins un mot-clé (2 caractères minimum).'); e.code = 'KEYWORDS_REQUIRED'; throw e; }
  const limit = Math.min(30, Math.max(1, Number(input.limit) || 15));
  const raw = channel === 'TELEGRAM' ? await searchTelegram(tenant, keywords, limit) : await searchWhatsApp(tenant, keywords, limit, deps);
  const byRef = new Map();
  for (const r of raw) { const k = `${r.channel}:${r.ref}`; const prev = byRef.get(k); if (prev) prev.keywords = [...new Set(prev.keywords.concat(r.keyword))]; else byRef.set(k, Object.assign({}, r, { keywords: [r.keyword] })); }
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
    const r = await contactCrm.upsertCommunity(tenant, { channel: c.channel, ref: c.ref, name: c.name, link: c.link, kind: c.kind, members: c.members, description: c.description, keywords: c.keywords, verified: c.verified });
    if (r.created) created += 1; else updated += 1;
  }
  return { count: created + updated, created, updated };
}

module.exports = { discover, syncToCrm, extractInviteCodes, cleanKeywords, webDirectorySearch, _setSleep: (fn) => { sleepFn = fn; } };
