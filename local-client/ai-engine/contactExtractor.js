// EXTRACTEUR DE CONTACTS UNIQUE — ai-engine/contactExtractor.js
// ---------------------------------------------------------------------------
// Une seule logique d'extraction pour TOUTES les sources : Excel (toutes les feuilles), CSV/TSV/TXT (séparateur détecté), vCard
// (.vcf), JSON, texte collé, texte d'OCR d'une image. Aucune dépendance à des noms de colonnes exacts : les colonnes sont
// reconnues par leur CONTENU (une colonne de numéros ressemble à des numéros) et, en plus, par leur en-tête s'il existe.
// Retourne des entrées { phone, name, username, raw, sheet } ; la validation/normalisation reste celle de contactsPipeline
// (aucun numéro n'est deviné ici). Sert Excel, collage et photo, WhatsApp comme Telegram.

const XLSX = require('xlsx');

const PHONE_FIND = /(?:\+|00)?\d[\d\s().\-]{6,}\d/g;
const USER_FIND = /(?:^|[\s,;:(])@([A-Za-z][A-Za-z0-9_]{3,31})\b|t\.me\/([A-Za-z][A-Za-z0-9_]{3,31})/g;
const SEPARATORS = [';', '\t', '|', ','];

const plain = (s) => String(s == null ? '' : s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
const PHONE_HEAD = ['tel', 'phone', 'mobile', 'gsm', 'numero', 'number', 'whatsapp', 'portable', 'cell', 'num', 'contact', 'wa'];
const NAME_HEAD = ['nom', 'name', 'prenom', 'firstname', 'lastname', 'client', 'fullname', 'pseudo', 'contactname', 'identite'];
const USER_HEAD = ['username', 'telegram', 'identifiant', 'handle', 'user', 'pseudo'];

function cellStr(v) {
  if (v == null) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(v);
  if (v instanceof Date) return '';
  return String(v).replace(/ | /g, ' ').trim();
}
const digitsOf = (s) => String(s).replace(/\D/g, '');
// Une cellule « est un numéro » : presque uniquement des chiffres et séparateurs, 8 à 15 chiffres.
function phoneCell(s) {
  const t = String(s).trim();
  if (!t) return false;
  if (/[A-Za-z]{2,}/.test(t)) return false;
  const d = digitsOf(t);
  return d.length >= 8 && d.length <= 15 && /^[+()\d\s.\-\/]+$/.test(t);
}
const looksSciNotation = (s) => /^\d(?:[.,]\d+)?e\+?\d+$/i.test(String(s).trim());
const nameCell = (s) => /[A-Za-zÀ-ÿ]{2,}/.test(s) && !phoneCell(s) && !/^@/.test(s) && s.length <= 80 && !/^[\w.+-]+@[\w-]+\.[\w.]+$/.test(s);

function phonesIn(s) {
  const out = [];
  const t = String(s);
  if (looksSciNotation(t)) return [{ phone: t, sci: true }];
  // Séquences de 8 à 20 chiffres : au-delà de 15 le pipeline signale « trop long » (visible pour l'utilisateur) au lieu de l'ignorer.
  for (const m of t.match(PHONE_FIND) || []) { const d = digitsOf(m); if (d.length >= 8 && d.length <= 20) out.push({ phone: m.trim() }); }
  return out;
}
function usersIn(s) {
  const out = []; const t = String(s); let m; USER_FIND.lastIndex = 0;
  while ((m = USER_FIND.exec(t))) out.push('@' + (m[1] || m[2]));
  return out;
}

// --------------------------------------------------------------------------- matrice (Excel / CSV) -> entrées
function fromMatrix(matrix, sheet) {
  const rows = (matrix || []).map((r) => (r || []).map(cellStr)).filter((r) => r.some((c) => c));
  if (!rows.length) return [];
  const width = Math.max(...rows.map((r) => r.length));
  const grid = rows.map((r) => Array.from({ length: width }, (_, i) => r[i] || ''));

  // Ligne d'en-tête : une des 6 premières lignes sans aucune cellule-numéro, suivie d'une ligne qui en contient.
  let headerIdx = -1;
  const vocab = PHONE_HEAD.concat(NAME_HEAD, USER_HEAD);
  // 1) en-tête reconnu par son VOCABULAIRE (au moins une cellule = mot d'en-tête connu, aucune cellule-numéro) ;
  for (let i = 0; i < Math.min(4, grid.length - 1); i += 1) {
    const cells = grid[i].filter(Boolean);
    if (cells.length && !cells.some(phoneCell) && cells.some((c) => vocab.some((h) => plain(c).includes(h)))) { headerIdx = i; break; }
  }
  // 2) sinon : 1re ligne sans numéro directement suivie d'une ligne avec numéro (en-tête aux mots inconnus).
  if (headerIdx < 0) {
    const first = grid[0]; const second = grid[1];
    if (second && !first.some(phoneCell) && !first.some((c) => phonesIn(c).length) && first.some(Boolean) && (second.some(phoneCell) || second.some((c) => phonesIn(c).length))) headerIdx = 0;
  }
  const header = headerIdx >= 0 ? grid[headerIdx].map(plain) : [];
  const data = grid.slice(headerIdx + 1);
  const cols = Array.from({ length: width }, (_, c) => {
    const cells = data.map((r) => r[c]).filter(Boolean);
    const n = cells.length || 1;
    const hint = header[c] || '';
    return {
      c, hint,
      phoneShare: cells.filter((x) => phoneCell(x) || looksSciNotation(x)).length / n,
      nameShare: cells.filter(nameCell).length / n,
      userShare: cells.filter((x) => usersIn(x).length || /^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(x)).length / n,
      phoneHead: PHONE_HEAD.some((h) => hint.includes(h)), nameHead: NAME_HEAD.some((h) => hint.includes(h)) && !hint.includes('numero') && !hint.includes('num'),
      userHead: USER_HEAD.some((h) => hint.includes(h)),
    };
  });
  // Colonnes de numéros : contenu majoritairement numérique (≥ 40 %), ou en-tête « téléphone » + au moins 20 % de numéros.
  const phoneCols = cols.filter((k) => k.phoneShare >= 0.4 || (k.phoneHead && k.phoneShare >= 0.2)).map((k) => k.c);
  const nameCols = cols.filter((k) => k.nameHead && k.nameShare >= 0.3).map((k) => k.c);
  const userCols = cols.filter((k) => k.userHead && k.userShare >= 0.3 && !phoneCols.includes(k.c)).map((k) => k.c);
  // Sans en-tête utilisable : la première colonne « texte-nom » qui n'est pas une colonne de numéros.
  const fallbackNameCol = nameCols.length ? null : (cols.find((k) => !phoneCols.includes(k.c) && !userCols.includes(k.c) && k.nameShare >= 0.5) || {}).c;

  const out = [];
  for (const r of data) {
    let phones = [];
    for (const c of phoneCols) phones.push(...phonesIn(r[c]));
    if (!phones.length) for (const c of r.keys()) { if (phoneCell(r[c])) phones.push(...phonesIn(r[c])); }
    if (!phones.length) for (const c of r.keys()) phones.push(...phonesIn(r[c])); // dernier recours : numéro noyé dans un texte
    const usernames = [];
    for (const c of userCols) usernames.push(...(usersIn(r[c]).length ? usersIn(r[c]) : (/^@?[A-Za-z][A-Za-z0-9_]{3,31}$/.test(r[c]) ? ['@' + r[c].replace(/^@/, '')] : [])));
    if (!usernames.length) for (const c of r.keys()) usernames.push(...usersIn(r[c]));
    let name = nameCols.map((c) => r[c]).filter(Boolean).join(' ');
    if (!name && fallbackNameCol != null) name = r[fallbackNameCol] || '';
    if (!name) name = (r.find((x, i) => x && !phoneCols.includes(i) && nameCell(x)) || '');
    const raw = r.filter(Boolean).join(' | ').slice(0, 200);
    const uniqPhones = [...new Map(phones.map((p) => [digitsOf(p.phone) || p.phone, p])).values()];
    if (uniqPhones.length) uniqPhones.forEach((p) => out.push({ phone: p.phone, name, username: usernames[0] || null, raw, sheet, sci: !!p.sci }));
    else if (usernames.length) usernames.forEach((u) => out.push({ phone: '', name, username: u, raw, sheet }));
  }
  return out;
}

// --------------------------------------------------------------------------- texte libre / CSV collé / OCR
function splitCsvLine(line, sep) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i += 1; } else q = !q; } else if (c === sep && !q) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}
function detectSeparator(lines) {
  const sample = lines.slice(0, 12);
  if (sample.length < 2) return null;
  for (const sep of SEPARATORS) {
    const counts = sample.map((l) => splitCsvLine(l, sep).length);
    if (counts[0] >= 2 && counts.filter((n) => n === counts[0]).length >= Math.ceil(sample.length * 0.7)) return sep;
  }
  return null;
}
function fromText(text, sheet) {
  const src = String(text == null ? '' : text).replace(/\r/g, '');
  const lines = src.split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  if (/BEGIN:VCARD/i.test(src)) return fromVcard(src);
  const sep = detectSeparator(lines);
  if (sep) { const m = fromMatrix(lines.map((l) => splitCsvLine(l, sep)), sheet); if (m.length) return m; }
  const out = [];
  for (const line of lines) {
    const phones = phonesIn(line); const users = usersIn(line);
    if (!phones.length && !users.length) continue;
    let rest = line;
    for (const p of phones) rest = rest.replace(p.phone, ' ');
    for (const u of users) rest = rest.replace(new RegExp('@?' + u.slice(1), 'i'), ' ');
    const name = rest.replace(/^\s*\d{1,3}\s*[.)\-:]\s+/, ' ').replace(/t\.me\/\S*/gi, ' ').replace(/[,;:|\-–—/\\()[\]<>]+/g, ' ').replace(/\b(?:tel|tél|telephone|téléphone|phone|whatsapp|num|numero|numéro|nom|name)\b\s*:?/gi, ' ').replace(/\s+/g, ' ').trim();
    if (phones.length) phones.forEach((p) => out.push({ phone: p.phone, name: phones.length === 1 ? name : '', username: users[0] || null, raw: line.slice(0, 200), sheet, sci: !!p.sci }));
    else users.forEach((u) => out.push({ phone: '', name, username: u, raw: line.slice(0, 200), sheet }));
  }
  return out;
}
function fromVcard(text) {
  const out = [];
  for (const card of String(text).split(/BEGIN:VCARD/i).slice(1)) {
    const fn = (card.match(/^FN[^:]*:(.+)$/im) || [])[1] || (card.match(/^N[^:]*:(.+)$/im) || [])[1] || '';
    const tels = [...card.matchAll(/^TEL[^:]*:(.+)$/gim)].map((m) => m[1].trim());
    const name = fn.replace(/;/g, ' ').replace(/\s+/g, ' ').trim();
    tels.forEach((t) => { if (digitsOf(t).length >= 8) out.push({ phone: t, name, username: null, raw: `${name} ${t}`.slice(0, 200), sheet: 'vcf' }); });
  }
  return out;
}

// --------------------------------------------------------------------------- fichiers
function extractFromFile(file) {
  const name = String((file && file.name) || '').toLowerCase();
  const type = String((file && file.type) || '').toLowerCase();
  const buf = file && file.buffer;
  if (!buf || !buf.length) return { entries: [], sheets: 0, kind: 'empty' };
  const head = buf.slice(0, 4).toString('latin1');
  const isZip = head.startsWith('PK'); const isOle = buf[0] === 0xD0 && buf[1] === 0xCF;
  const isBinarySheet = isZip || isOle || /\.(xlsx|xls|xlsb|xlsm|ods)$/.test(name) || /spreadsheet|excel|opendocument/.test(type);
  if (isBinarySheet) {
    const wb = XLSX.read(buf, { type: 'buffer', cellDates: false, raw: true });
    const entries = [];
    for (const sn of wb.SheetNames) {
      const matrix = XLSX.utils.sheet_to_json(wb.Sheets[sn], { header: 1, raw: true, defval: '', blankrows: false });
      entries.push(...fromMatrix(matrix, sn));
    }
    return { entries, sheets: wb.SheetNames.length, kind: 'spreadsheet' };
  }
  let text = buf.toString('utf8');
  if (/�/.test(text)) text = buf.toString('latin1');
  text = text.replace(/^﻿/, '');
  if (/\.json$/.test(name) || /json/.test(type)) {
    try {
      const j = JSON.parse(text); const arr = Array.isArray(j) ? j : (Array.isArray(j.contacts) ? j.contacts : []);
      if (arr.length) return { entries: fromRows(arr), sheets: 1, kind: 'json' };
    } catch (e) { /* texte ordinaire */ }
  }
  return { entries: fromText(text, 'texte'), sheets: 1, kind: /\.vcf$/.test(name) || /vcard/.test(type) ? 'vcard' : 'text' };
}

// Lignes déjà structurées (JSON / tableau d'objets) : mêmes règles de colonnes que pour une feuille.
function fromRows(rows) {
  if (!Array.isArray(rows) || !rows.length) return [];
  if (rows.every((r) => typeof r === 'string')) return fromText(rows.join('\n'), 'rows');
  const keys = [...new Set(rows.flatMap((r) => Object.keys(r || {})))];
  const matrix = [keys].concat(rows.map((r) => keys.map((k) => (r || {})[k])));
  return fromMatrix(matrix, 'rows');
}

// Telegram : identifiant = @username si présent, sinon le numéro normalisé par l'appelant.
function toTelegramIdentifiers(entries, normalizePhone) {
  const seen = new Set(); const out = [];
  for (const e of entries || []) {
    let id = e.username || null;
    if (!id && e.phone) { const n = normalizePhone ? normalizePhone(e.phone) : digitsOf(e.phone); if (n) id = '+' + String(n).replace(/^\+/, ''); }
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase()); out.push({ identifier: id, name: e.name || '' });
  }
  return out;
}

module.exports = { extractFromFile, extractFromText: fromText, extractFromRows: fromRows, fromMatrix, toTelegramIdentifiers, phoneCell, usersIn };
