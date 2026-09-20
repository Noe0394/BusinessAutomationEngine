// Pipeline contacts 100 % déterministe : SOURCE -> parse -> normalize -> dedupe -> validate -> recipients.
// Aucune IA. Les entrées sont des chaînes (texte/CSV collé), des lignes déjà lues (Excel) ou un texte d'OCR.

const PHONE_RE = /(?:\+|00)?\d[\d\s().\-]{6,}\d/g;
const PHONE_HEADERS = ['telephone', 'tel', 'phone', 'numero', 'number', 'whatsapp', 'mobile', 'contact', 'gsm'];
const NAME_HEADERS = ['nom', 'name', 'prenom', 'firstname', 'client', 'fullname'];

const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

function splitCsvLine(line, sep) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i];
    if (c === '"') { if (q && line[i + 1] === '"') { cur += '"'; i += 1; } else q = !q; }
    else if (c === sep && !q) { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

// Texte libre ou CSV -> [{ raw, phone, name }]. Un numéro = séquence de 8 à 15 chiffres (séparateurs tolérés).
function parseContacts(input) {
  if (Array.isArray(input)) return input.map((r) => parseRow(r)).filter(Boolean);
  const text = String(input == null ? '' : input);
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const sep = [';', '\t', ','].find((s) => lines.length > 1 && lines[0].includes(s) && lines.slice(1, 4).every((l) => l.includes(s)));
  if (sep) {
    const head = splitCsvLine(lines[0], sep).map(plain);
    const pi = head.findIndex((h) => PHONE_HEADERS.includes(h));
    const ni = head.findIndex((h) => NAME_HEADERS.includes(h));
    if (pi >= 0) {
      return lines.slice(1).map((l) => { const c = splitCsvLine(l, sep); return { raw: l, phone: c[pi] || '', name: ni >= 0 ? (c[ni] || '') : '' }; }).filter((r) => r.phone);
    }
  }
  const out = [];
  for (const line of lines) {
    const found = line.match(PHONE_RE);
    if (!found) continue;
    let rest = line;
    for (const f of found) rest = rest.replace(f, ' ');
    const name = rest.replace(/[,;:|\-–—/\\()[\]]+/g, ' ').replace(/\s+/g, ' ').trim();
    for (const f of found) out.push({ raw: line, phone: f.trim(), name: found.length === 1 ? name : '' });
  }
  return out;
}

function parseRow(r) {
  if (!r) return null;
  if (typeof r === 'string') { const m = r.match(PHONE_RE); return m ? { raw: r, phone: m[0], name: '' } : null; }
  const key = (obj, list) => { for (const k of Object.keys(obj)) if (list.includes(plain(k))) return String(obj[k] == null ? '' : obj[k]).trim(); return ''; };
  const phone = r.phone || r.telephone || key(r, PHONE_HEADERS);
  return phone ? { raw: JSON.stringify(r).slice(0, 200), phone: String(phone), name: String(r.name || r.nom || key(r, NAME_HEADERS) || '') } : null;
}

// Numéros seuls (texte quelconque, ex. sortie d'OCR) : liste de chaînes brutes.
function extractPhoneNumbers(text) {
  return (String(text || '').match(PHONE_RE) || []).map((s) => s.trim());
}

// Chiffres seuls -> E.164 sans « + ». Sans indicatif pays connu, un numéro local (0...) reste signalé.
function normalizeOne(rawPhone, opts) {
  const o = opts || {};
  const cc = String(o.defaultCountryCode || process.env.DEFAULT_COUNTRY_CODE || '').replace(/\D/g, '');
  const src = String(rawPhone || '').trim();
  const digits = src.replace(/\D/g, '');
  if (!digits) return { phone: null, reason: 'EMPTY' };
  if (src.startsWith('+')) return { phone: digits, reason: null };
  if (digits.startsWith('00')) return { phone: digits.slice(2), reason: null };
  if (cc && digits.startsWith(cc) && digits.length >= cc.length + 7) return { phone: digits, reason: null };
  if (digits.startsWith('0') && cc) return { phone: cc + digits.replace(/^0+/, ''), reason: null };
  if (cc && digits.length <= 10) return { phone: cc + digits, reason: null };
  return { phone: digits, reason: cc ? null : 'COUNTRY_CODE_UNKNOWN' };
}

function normalizeContacts(list, opts) {
  return (list || []).map((c) => {
    const n = normalizeOne(c.phone, opts);
    return Object.assign({}, c, { normalized: n.phone, normalizeIssue: n.reason });
  });
}

function deduplicateContacts(list) {
  const seen = new Map(); const unique = []; const duplicates = [];
  for (const c of list || []) {
    const key = c.normalized || c.phone;
    if (!key) { unique.push(c); continue; }
    if (seen.has(key)) { duplicates.push(c); if (c.name && !seen.get(key).name) seen.get(key).name = c.name; continue; }
    seen.set(key, c); unique.push(c);
  }
  return { unique, duplicates };
}

function validateContacts(list) {
  const valid = []; const invalid = [];
  for (const c of list || []) {
    const p = c.normalized;
    let reason = null;
    if (!p) reason = c.normalizeIssue || 'EMPTY';
    else if (c.normalizeIssue) reason = c.normalizeIssue;
    else if (p.length < 8) reason = 'TOO_SHORT';
    else if (p.length > 15) reason = 'TOO_LONG';
    else if (/^(\d)\1+$/.test(p) || /0{7,}/.test(p)) reason = 'REPEATED_DIGITS';
    if (reason) invalid.push(Object.assign({}, c, { reason })); else valid.push(c);
  }
  return { valid, invalid };
}

// Format attendu par les moteurs de campagne (normalizeRecipientEntry : { telephone, nom }).
function prepareRecipients(validList) {
  return (validList || []).map((c) => ({ telephone: c.normalized, nom: c.name || '' }));
}

// Enchaînement complet + rapport honnête (chaque étape comptée).
function runPipeline(input, opts) {
  const parsed = parseContacts(input);
  const normalized = normalizeContacts(parsed, opts);
  const { unique, duplicates } = deduplicateContacts(normalized);
  const { valid, invalid } = validateContacts(unique);
  return {
    recipients: prepareRecipients(valid),
    report: { parsed: parsed.length, duplicates: duplicates.length, invalid: invalid.length, valid: valid.length },
    invalid: invalid.slice(0, 50).map((c) => ({ raw: c.phone, reason: c.reason })),
  };
}

// Table complète pour l'interface : chaque ligne importée avec son état (valid | duplicate | invalid | uncertain).
// `uncertain` : numéros dont le format ne peut pas être déterminé avec confiance (indicatif pays inconnu) ou signalés
// par l'OCR (opts.uncertainNumbers, chiffres seuls) — jamais corrigés ni « devinés ».
function classify(input, opts) {
  const o = opts || {};
  const flagged = new Set((o.uncertainNumbers || []).map((n) => String(n).replace(/\D/g, '')));
  const parsed = normalizeContacts(parseContacts(input), o);
  const seen = new Set();
  const rows = parsed.map((c) => {
    const base = { name: c.name || '', raw: c.phone, number: c.normalized || null };
    const check = validateContacts([c]);
    if (check.invalid.length) {
      const reason = check.invalid[0].reason;
      return Object.assign(base, { state: reason === 'COUNTRY_CODE_UNKNOWN' ? 'uncertain' : 'invalid', reason });
    }
    if (flagged.size && [...flagged].some((f) => f && c.normalized.includes(f))) return Object.assign(base, { state: 'uncertain', reason: 'OCR_LOW_CONFIDENCE' });
    if (seen.has(c.normalized)) return Object.assign(base, { state: 'duplicate', reason: 'DUPLICATE' });
    seen.add(c.normalized);
    return Object.assign(base, { state: 'valid', reason: null });
  });
  const counts = { total: rows.length, valid: 0, duplicate: 0, invalid: 0, uncertain: 0 };
  for (const r of rows) counts[r.state] += 1;
  return { rows, counts };
}

module.exports = { classify, parseContacts, extractPhoneNumbers, normalizeContacts, deduplicateContacts, validateContacts, prepareRecipients, runPipeline, normalizeOne };
