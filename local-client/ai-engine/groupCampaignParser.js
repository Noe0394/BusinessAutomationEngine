// Analyse d'une instruction de campagne de groupes donnée au Chat Intelligent / au self-chat.
// Déterministe : mot-clé, durée, horaires, messages fournis (entre guillemets) et objectif sont extraits par le code ;
// rien n'est inventé (un champ absent reste null et l'appelant le demande).

const { quotedBlocks } = require('./adCampaignParser');
const { norm } = require('./jarvis/intentClassifier');

const NUMBER_WORDS = { un: 1, une: 1, deux: 2, trois: 3, quatre: 4, cinq: 5, six: 6, sept: 7, huit: 8, dix: 10, quinze: 15 };
const UNIT_DAYS = { jour: 1, jours: 1, semaine: 7, semaines: 7, mois: 30 };

function extractKeyword(text) {
  const s = String(text || '');
  const quoted = s.match(/(?:contien(?:t|nent)|contenant|comportant|comprenant|incluant)\s+(?:le\s+mot\s+)?[«"“]\s*([^»"”]+?)\s*[»"”]/i);
  if (quoted) return quoted[1].trim();
  const m = s.match(/(?:nom|noms|intitul[ée]s?|titre)\s+(?:contien(?:t|nent)|contenant|comportant|comprenant|incluant|commen[çc]ant\s+par)\s+(?:le\s+mot\s+)?([^\s«»"”,.;:!?()]+)/i)
    || s.match(/(?:contien(?:t|nent)|contenant)\s+(?:le\s+mot\s+)?([^\s«»"”,.;:!?()]+)/i);
  return m ? m[1].trim() : null;
}

function extractDuration(text) {
  const n = norm(text);
  const m = n.match(/(?:pendant|durant|sur|pour)?\s*(\d+|un|une|deux|trois|quatre|cinq|six|sept|huit|dix|quinze)\s+(jours?|semaines?|mois)\b/);
  if (!m) return null;
  const count = /^\d+$/.test(m[1]) ? parseInt(m[1], 10) : NUMBER_WORDS[m[1]];
  const unit = m[2].replace(/s$/, '');
  const days = count * (UNIT_DAYS[unit] || UNIT_DAYS[m[2]] || 1);
  return { days, label: `${count} ${m[2]}` };
}

const WORD_TIMES = [['matin', '08:00'], ['midi', '12:00'], ['apres midi', '15:00'], ['soir', '18:00']];
function extractTimes(text) {
  const s = String(text || '');
  const times = [];
  const re = /(?<![\d.,])(\d{1,2})\s*(?:h|:)\s*(\d{2})?(?![\d])/gi;
  let m;
  while ((m = re.exec(s))) {
    const h = parseInt(m[1], 10); const mi = m[2] ? parseInt(m[2], 10) : 0;
    if (h >= 0 && h <= 23 && mi >= 0 && mi <= 59) times.push(`${String(h).padStart(2, '0')}:${String(mi).padStart(2, '0')}`);
  }
  if (times.length) return Array.from(new Set(times)).sort();
  const n = norm(s);
  const words = WORD_TIMES.filter(([w]) => new RegExp(`(?:^|\\s)${w}(?=\\s|$|[?!,.])`).test(n)).map(([, t]) => t);
  return Array.from(new Set(words)).sort();
}

function parseAmount(raw) {
  let s = String(raw || '').replace(/[\s  ]/g, '');
  if (!s) return null;
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) s = s.replace(/[.,]/g, '');
  else s = s.replace(',', '.');
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
}
function extractGoal(text) {
  const m = String(text || '').match(/objectifs?[^0-9\n]{0,60}?([0-9][0-9\s  .,]*)\s*(fcfa|f\s?cfa|xof|cfa|francs?|€|eur|euros?|usd|\$|dollars?)/i);
  if (!m) return null;
  const amount = parseAmount(m[1]);
  if (amount == null) return null;
  const cur = /€|eur/i.test(m[2]) ? 'EUR' : (/usd|\$|dollar/i.test(m[2]) ? 'USD' : 'FCFA');
  const per = /du\s+mois|mensuel|ce\s+mois/i.test(text) ? 'mois' : (/de\s+la\s+semaine|hebdo|cette\s+semaine/i.test(text) ? 'semaine' : null);
  return { amount, currency: cur, period: per };
}

// Assemble le résultat. `messages` : blocs entre guillemets, dans l'ordre. Ils sont associés aux horaires (1 pour 1 s'il y en
// a autant ; un seul message = le même à chaque horaire ; sinon rotation) — jamais un texte inventé.
function parseInstruction(text) {
  const blocks = quotedBlocks(text).map((b) => b.text).filter((t) => t.length >= 8);
  const keyword = extractKeyword(text);
  const duration = extractDuration(text);
  const times = extractTimes(text);
  const goal = extractGoal(text);
  const perSlotDistinct = /(messages?\s+(?:diff[ée]rents?|distincts?)|un\s+message\s+diff[ée]rent|selon\s+le\s+moment|matin\s*[:,].*soir\s*:)/i.test(text);
  return { keyword, duration, times, messages: blocks, goal, perSlotDistinct };
}

function assignMessages(times, messages) {
  if (!messages.length || !times.length) return [];
  return times.map((t, i) => ({ time: t, message: messages.length === times.length ? messages[i] : (messages.length === 1 ? messages[0] : messages[i % messages.length]) }));
}

module.exports = { extractKeyword, extractDuration, extractTimes, extractGoal, parseAmount, parseInstruction, assignMessages };
