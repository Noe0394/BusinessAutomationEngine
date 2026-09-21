// BASE DE CONNAISSANCES PÉDAGOGIQUE — ai-engine/courseKnowledge.js
// ---------------------------------------------------------------------------
// Structure : FORMATION → MODULE → CHAPITRE → LEÇON → CONTENU (+ métadonnées et SOURCES). Chaque morceau de contenu (« chunk ») porte son
// chemin pédagogique, sa catégorie, sa source (fichier/nom) et son ordre. Quatre catégories, JAMAIS mélangées :
//   official      : contenu officiel de la formation (seule source pour « dans le cours … »)
//   complementary : connaissances complémentaires ajoutées par le propriétaire (signalées comme telles)
//   faq           : questions fréquentes VALIDÉES par le propriétaire
//   internal      : notes internes — JAMAIS restituées à un apprenant
// Recherche CIBLÉE (BM25 en mémoire, sans dépendance) : seuls les extraits pertinents sont renvoyés — jamais toutes les formations dans le
// contexte du modèle. Isolation stricte par compte (tenant). Le contenu officiel ne change QUE par une ingestion explicite du propriétaire
// (outils du Tool Registry, soumis aux rôles/permissions) : l'apprentissage continu n'alimente que des CANDIDATES de FAQ, séparées.
const crypto = require('crypto');
const storageAdapter = require('./storageAdapter');

const NS = 'course_kb';
const sanitize = (id) => String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';
const uid = (p) => `${p}_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}`;
const CATEGORIES = ['official', 'complementary', 'faq', 'internal'];
const LEARNER_CATEGORIES = ['official', 'complementary', 'faq']; // internal : jamais côté apprenant
const MAX_CHUNK = 1000;

// ---------------------------------------------------------------------------- texte
const STOP = new Set('le la les un une des du de d l et ou a au aux en dans sur pour par avec sans que qui quoi est sont ce cet cette ces mon ma mes ton ta tes son sa ses notre votre leur je tu il elle nous vous ils elles me te se ne pas plus tres the of to and for with is are it this that comment quel quelle quels quelles combien pourquoi quand faut dois doit peut peux puis fait faire etre avoir cest jai mais donc alors aussi si recette chapitre lecon module cours formation etape exercice partie section apprendre'.split(' '));
function norm(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[’']/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim(); }
function stem(w) { let t = w; if (t.length > 4 && t.endsWith('s')) t = t.slice(0, -1); if (t.length > 4 && t.endsWith('x')) t = t.slice(0, -1); return t.length > 6 ? t.slice(0, 6) : t; }
function tokens(s) { return norm(s).split(' ').filter((w) => w.length > 1 && !STOP.has(w)).map(stem); }

// ---------------------------------------------------------------------------- structure d'un document
const HEAD_RE = /^\s*(?:(#{1,4})\s+(.+)|((?:module|chapitre|chapter|partie|part|unit[ée]|le[cç]on|lesson|recette|recipe|s[ée]ance|section|exercice|exercise|atelier)\b)\s*(\d+)?\s*[:.\-–—)]?\s*(.*))$/i;
const LEVEL = { module: 1, unite: 1, unit: 1, partie: 2, part: 2, chapitre: 2, chapter: 2, lecon: 3, lesson: 3, recette: 3, recipe: 3, seance: 3, section: 3, exercice: 3, exercise: 3, atelier: 3 };
const KIND = { recette: 'recipe', recipe: 'recipe', exercice: 'exercise', exercise: 'exercise', lecon: 'lesson', lesson: 'lesson', atelier: 'lesson' };

// Découpe un texte en chunks hiérarchisés. Retourne [{ path:{module,chapter,lesson}, title, kind, text }]
function parseText(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const cur = { module: null, chapter: null, lesson: null };
  let kind = 'lesson'; let buf = []; const out = [];
  const flush = () => {
    const body = buf.join('\n').trim(); buf = [];
    if (!body) return;
    const title = cur.lesson || cur.chapter || cur.module || 'Introduction';
    // Paragraphes regroupés en chunks ≤ MAX_CHUNK ; un paragraphe trop long est coupé aux phrases.
    const paras = body.split(/\n{2,}/).flatMap((p) => (p.length > MAX_CHUNK ? p.match(/[^.!?\n]+[.!?]?\s*/g) || [p] : [p]));
    let acc = '';
    const push = () => { const t = acc.trim(); if (t) out.push({ path: { module: cur.module, chapter: cur.chapter, lesson: cur.lesson }, title, kind, text: t }); acc = ''; };
    for (const p of paras) { if ((acc + '\n' + p).length > MAX_CHUNK && acc) push(); acc += (acc ? '\n' : '') + p; }
    push();
  };
  for (const raw of lines) {
    const m = raw.match(HEAD_RE);
    const isHead = m && (m[1] ? true : (raw.trim().length <= 120));
    if (isHead) {
      let level; let title; let k = 'lesson';
      if (m[1]) { level = Math.min(3, m[1].length); title = m[2].trim(); }
      else { const word = norm(m[3]); level = LEVEL[word] || 3; k = KIND[word] || 'lesson'; title = `${m[3][0].toUpperCase()}${m[3].slice(1).toLowerCase()}${m[4] ? ' ' + m[4] : ''}${m[5] ? ' — ' + m[5].trim() : ''}`.trim(); }
      flush();
      if (level === 1) { cur.module = title; cur.chapter = null; cur.lesson = null; }
      else if (level === 2) { cur.chapter = title; cur.lesson = null; }
      else { cur.lesson = title; }
      kind = k;
    } else buf.push(raw);
  }
  flush();
  return out;
}
// Structure JSON : { modules:[{ title, chapters:[{ title, lessons:[{ title, content, kind }] }] }] } (ou lessons à plat).
function parseStructure(s) {
  const out = [];
  const lesson = (mod, chap, l) => { if (l && l.content) for (const c of parseText(`${String(l.content)}`)) out.push({ path: { module: mod, chapter: chap, lesson: l.title || null }, title: l.title || chap || mod || 'Contenu', kind: l.kind || 'lesson', text: c.text }); };
  for (const m of (s && s.modules) || []) { for (const ch of m.chapters || []) for (const l of ch.lessons || []) lesson(m.title || null, ch.title || null, l); for (const l of m.lessons || []) lesson(m.title || null, null, l); }
  for (const l of (s && s.lessons) || []) lesson(null, null, l);
  return out;
}

// ---------------------------------------------------------------------------- persistance + index
const docs = new Map(); // tenant -> doc (cache)
const indexes = new Map(); // tenant -> { stamp, ... }
async function load(tenant) {
  const t = sanitize(tenant);
  if (!docs.has(t)) docs.set(t, await storageAdapter.get(NS, t, { tenant: t, courses: {}, chunks: {}, faqCandidates: {}, updatedAt: null }));
  return docs.get(t);
}
async function save(tenant, doc) { doc.updatedAt = new Date().toISOString(); indexes.delete(sanitize(tenant)); docs.set(sanitize(tenant), doc); await storageAdapter.set(NS, sanitize(tenant), doc); }

function buildIndex(doc) {
  const ids = Object.keys(doc.chunks);
  const tf = new Map(); const df = new Map(); let total = 0;
  for (const id of ids) {
    const c = doc.chunks[id]; const toks = tokens(`${c.title} ${c.pathText} ${c.text}`); const m = new Map();
    toks.forEach((t) => m.set(t, (m.get(t) || 0) + 1)); tf.set(id, { m, len: toks.length }); total += toks.length;
    for (const t of m.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  return { ids, tf, df, avg: ids.length ? total / ids.length : 1, n: ids.length };
}
async function indexOf(tenant) {
  const doc = await load(tenant); const t = sanitize(tenant);
  let ix = indexes.get(t); if (!ix) { ix = buildIndex(doc); indexes.set(t, ix); }
  return { doc, ix };
}

const pathText = (p) => [p.module, p.chapter, p.lesson].filter(Boolean).join(' › ');

// ---------------------------------------------------------------------------- formations
async function createCourse(tenant, { name, serviceId, description, objectives }) {
  const doc = await load(tenant);
  const key = norm(name);
  if (!key) { const e = new Error('Nom de formation requis.'); e.code = 'NAME_REQUIRED'; throw e; }
  let course = Object.values(doc.courses).find((c) => norm(c.name) === key);
  if (!course) { course = { id: uid('crs'), name: String(name).slice(0, 120), createdAt: new Date().toISOString(), groups: [], serviceId: null, description: '', objectives: '' }; doc.courses[course.id] = course; }
  if (serviceId) course.serviceId = String(serviceId);
  if (description != null) course.description = String(description).slice(0, 1000);
  if (objectives != null) course.objectives = String(objectives).slice(0, 1000);
  await save(tenant, doc);
  return course;
}
async function findCourse(tenant, ref) {
  const doc = await load(tenant); const r = String(ref || '').trim();
  if (!r) return null;
  return doc.courses[r] || Object.values(doc.courses).find((c) => norm(c.name) === norm(r)) || Object.values(doc.courses).find((c) => norm(c.name).includes(norm(r)) && norm(r).length >= 3) || null;
}

// source : { text? , structure? } ; opts : { category, sourceName, replace }
async function ingest(tenant, courseRef, source, opts) {
  const o = opts || {};
  const category = CATEGORIES.includes(o.category) ? o.category : 'official';
  let course = await findCourse(tenant, courseRef);
  if (!course) course = await createCourse(tenant, { name: String(courseRef) });
  const parsed = source.structure ? parseStructure(source.structure) : parseText(source.text);
  if (!parsed.length) { const e = new Error('Aucun contenu exploitable dans cette source.'); e.code = 'EMPTY_SOURCE'; throw e; }
  const doc = await load(tenant);
  const sourceName = String(o.sourceName || 'saisie').slice(0, 160);
  if (o.replace !== false) for (const id of Object.keys(doc.chunks)) { const c = doc.chunks[id]; if (c.courseId === course.id && c.source.name === sourceName && c.category === category) delete doc.chunks[id]; }
  const base = Object.keys(doc.chunks).filter((id) => doc.chunks[id].courseId === course.id).length;
  parsed.forEach((p, i) => {
    const id = uid('chk');
    doc.chunks[id] = { id, courseId: course.id, category, kind: p.kind || 'lesson', title: p.title, path: p.path, pathText: pathText(p.path), text: p.text, ordinal: base + i, source: { name: sourceName, fileId: o.fileId || null }, addedAt: new Date().toISOString() };
  });
  course.version = (course.version || 0) + 1;
  await save(tenant, doc);
  return { courseId: course.id, course: course.name, category, chunks: parsed.length, modules: [...new Set(parsed.map((p) => p.path.module).filter(Boolean))].length, chapters: [...new Set(parsed.map((p) => p.path.chapter).filter(Boolean))].length, lessons: [...new Set(parsed.map((p) => p.path.lesson).filter(Boolean))].length };
}

async function listCourses(tenant) {
  const doc = await load(tenant);
  return Object.values(doc.courses).map((c) => {
    const ch = Object.values(doc.chunks).filter((x) => x.courseId === c.id);
    const by = (cat) => ch.filter((x) => x.category === cat).length;
    return { id: c.id, name: c.name, serviceId: c.serviceId || null, groups: (c.groups || []).map((g) => ({ channel: g.channel, id: g.id, name: g.name, autoAnswer: g.autoAnswer !== false })), version: c.version || 0, chunks: ch.length, official: by('official'), complementary: by('complementary'), faq: by('faq'), internal: by('internal'), modules: [...new Set(ch.map((x) => x.path.module).filter(Boolean))].length };
  });
}
const hasCourses = async (tenant) => Object.keys((await load(tenant)).courses).length > 0;

// ---------------------------------------------------------------------------- recherche ciblée (BM25)
// opts : { courseId?, contextTerms?, limit?, categories?, audience?:'learner'|'owner' }
async function search(tenant, query, opts) {
  const o = opts || {};
  const { doc, ix } = await indexOf(tenant);
  if (!ix.n) return [];
  const cats = (o.audience === 'owner' && o.categories) ? o.categories : (o.categories || LEARNER_CATEGORIES).filter((c) => o.audience === 'owner' ? true : LEARNER_CATEGORIES.includes(c));
  const q = new Map(); const main = new Set();
  tokens(query).forEach((t) => { q.set(t, (q.get(t) || 0) + 1); main.add(t); });
  tokens((o.contextTerms || []).join(' ')).forEach((t) => q.set(t, (q.get(t) || 0) + 0.4)); // contexte de cours : poids réduit
  if (!q.size) return [];
  const k1 = 1.4; const b = 0.75; const scored = [];
  for (const id of ix.ids) {
    const c = doc.chunks[id];
    if (!cats.includes(c.category)) continue;
    if (o.courseId && c.courseId !== o.courseId) continue;
    const d = ix.tf.get(id); let s = 0; let matched = 0;
    for (const [t, w] of q) {
      const f = d.m.get(t); if (!f) continue;
      if (main.has(t)) matched += 1;
      const idf = Math.log(1 + (ix.n - (ix.df.get(t) || 0) + 0.5) / ((ix.df.get(t) || 0) + 0.5));
      s += w * idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + b * (d.len / ix.avg))));
    }
    if (s > 0) scored.push({ chunk: c, score: s, matched, of: main.size });
  }
  scored.sort((a, z) => z.score - a.score);
  const max = scored.length ? scored[0].score : 1;
  return scored.slice(0, o.limit || 5).map(({ chunk, score, matched, of }) => ({ matched, of, id: chunk.id, courseId: chunk.courseId, category: chunk.category, kind: chunk.kind, title: chunk.title, path: chunk.pathText, text: chunk.text, source: chunk.source.name, score: Math.round(score * 100) / 100, relative: Math.round((score / max) * 100) / 100 }));
}

// Section entière (résumé d'un chapitre / d'une leçon) : par numéro (« chapitre 3 ») ou par titre.
async function getSection(tenant, courseId, query) {
  const doc = await load(tenant);
  const all = Object.values(doc.chunks).filter((c) => c.courseId === courseId && LEARNER_CATEGORIES.includes(c.category)).sort((a, z) => a.ordinal - z.ordinal);
  const m = String(query || '').match(/(module|chapitre|chapter|partie|le[cç]on|recette|s[ée]ance|section)\s*(?:n[°o]?\s*)?(\d+)/i);
  let pick = [];
  if (m) {
    const word = norm(m[1]); const n = m[2];
    const re = new RegExp(`(^|\\s)${word.slice(0, 5)}\\w*\\s*${n}(\\D|$)`, 'i');
    pick = all.filter((c) => [c.path.module, c.path.chapter, c.path.lesson].some((t) => t && re.test(norm(t))));
  }
  if (!pick.length) {
    const hits = await search(tenant, query, { courseId, limit: 1 });
    if (hits.length) { const top = doc.chunks[hits[0].id]; const key = top.path.lesson || top.path.chapter || top.path.module; pick = all.filter((c) => (c.path.lesson || c.path.chapter || c.path.module) === key && c.path.chapter === top.path.chapter && c.path.module === top.path.module); }
  }
  return pick.slice(0, 12).map((c) => ({ id: c.id, category: c.category, path: c.pathText, title: c.title, text: c.text, source: c.source.name }));
}

// ---------------------------------------------------------------------------- liens formation ↔ service ↔ groupes
async function linkService(tenant, courseRef, serviceId) { const c = await findCourse(tenant, courseRef); if (!c) { const e = new Error('Formation introuvable.'); e.code = 'COURSE_NOT_FOUND'; throw e; } const doc = await load(tenant); doc.courses[c.id].serviceId = String(serviceId); await save(tenant, doc); return doc.courses[c.id]; }
async function linkGroup(tenant, courseRef, group) {
  const c = await findCourse(tenant, courseRef); if (!c) { const e = new Error('Formation introuvable.'); e.code = 'COURSE_NOT_FOUND'; throw e; }
  const doc = await load(tenant); const course = doc.courses[c.id];
  const ch = String(group.channel || 'WHATSAPP').toUpperCase(); const gid = String(group.id || '').trim();
  if (!gid) { const e = new Error('Identifiant du groupe requis.'); e.code = 'GROUP_REQUIRED'; throw e; }
  // Un groupe n'appartient qu'à UNE formation.
  for (const other of Object.values(doc.courses)) other.groups = (other.groups || []).filter((g) => !(g.channel === ch && g.id === gid));
  course.groups = (course.groups || []).concat([{ channel: ch, id: gid, name: String(group.name || '').slice(0, 120), autoAnswer: group.autoAnswer !== false, linkedAt: new Date().toISOString() }]);
  await save(tenant, doc); return course;
}
async function courseForGroup(tenant, channel, groupId) {
  const doc = await load(tenant); const ch = String(channel).toUpperCase();
  for (const c of Object.values(doc.courses)) { const g = (c.groups || []).find((x) => x.channel === ch && x.id === String(groupId)); if (g) return { course: c, group: g }; }
  return null;
}
async function courseForService(tenant, serviceId) { const doc = await load(tenant); return Object.values(doc.courses).find((c) => c.serviceId && String(c.serviceId) === String(serviceId)) || null; }

// ---------------------------------------------------------------------------- FAQ : candidates (jamais le contenu officiel)
const qKey = (q) => crypto.createHash('sha1').update(tokens(q).sort().join(' ')).digest('hex').slice(0, 12);
async function recordQuestion(tenant, courseId, question, answeredFromCourse) {
  const q = String(question || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (q.length < 8) return null;
  const doc = await load(tenant); const k = `${courseId}:${qKey(q)}`;
  const e = doc.faqCandidates[k] || { id: k, courseId, question: q, count: 0, answeredFromCourse: 0, firstAt: new Date().toISOString() };
  e.count += 1; if (answeredFromCourse) e.answeredFromCourse += 1; e.lastAt = new Date().toISOString();
  doc.faqCandidates[k] = e;
  const ids = Object.keys(doc.faqCandidates); if (ids.length > 500) delete doc.faqCandidates[ids.sort((a, z) => String(doc.faqCandidates[a].lastAt).localeCompare(String(doc.faqCandidates[z].lastAt)))[0]];
  await save(tenant, doc); return e;
}
async function faqCandidates(tenant, { min } = {}) { const doc = await load(tenant); return Object.values(doc.faqCandidates).filter((e) => e.count >= (min || 2)).sort((a, z) => z.count - a.count).slice(0, 30); }
// Promotion en FAQ VALIDÉE : action explicite du propriétaire (outil soumis aux rôles).
async function promoteFaq(tenant, candidateId, answer) {
  const doc = await load(tenant); const e = doc.faqCandidates[candidateId];
  if (!e) { const eNo = new Error('Question introuvable.'); eNo.code = 'NOT_FOUND'; throw eNo; }
  const r = await ingest(tenant, e.courseId, { text: `## ${e.question}\n\n${String(answer || '').trim()}` }, { category: 'faq', sourceName: 'FAQ validée', replace: false });
  delete (await load(tenant)).faqCandidates[candidateId]; await save(tenant, await load(tenant));
  return r;
}

module.exports = { createCourse, findCourse, ingest, listCourses, hasCourses, search, getSection, linkService, linkGroup, courseForGroup, courseForService, recordQuestion, faqCandidates, promoteFaq, parseText, parseStructure, tokens, norm, CATEGORIES, LEARNER_CATEGORIES, _reset: () => { docs.clear(); indexes.clear(); } };
