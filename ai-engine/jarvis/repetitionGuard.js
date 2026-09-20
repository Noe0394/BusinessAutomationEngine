// Détection de répétition : réponse quasi identique ou question déjà posée.
const { norm } = require('./intentClassifier');

const STOP_WORDS = new Set(['le', 'la', 'les', 'un', 'une', 'des', 'de', 'du', 'et', 'a', 'au', 'aux', 'en', 'vous', 'je', 'nous', 'est', 'pour', 'que', 'qui', 'ce', 'cela', 'ca', 'sur', 'dans', 'votre', 'notre', 'ne', 'pas', 'si', 'ou']);

function tokens(text) {
  return norm(text).split(' ').filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

function similarity(a, b) {
  const A = new Set(tokens(a)); const B = new Set(tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter += 1;
  return inter / (A.size + B.size - inter);
}

function questionsOf(text) {
  return String(text || '').split(/(?<=[?!.])\s+/).filter((s) => s.includes('?')).map((s) => tokens(s).sort().join(' ')).filter(Boolean);
}

// true si `candidate` répète une réponse récente, ou repose une question déjà posée
function check(candidate, recentReplies, opts) {
  const o = opts || {};
  const threshold = o.threshold || 0.72;
  const recent = Array.isArray(recentReplies) ? recentReplies : [];
  for (const r of recent) {
    if (similarity(candidate, r.text) >= threshold) return { repeated: true, kind: 'REPLY' };
  }
  const cq = questionsOf(candidate);
  if (cq.length) {
    const past = new Set();
    for (const r of recent) for (const q of questionsOf(r.text)) past.add(q);
    for (const q of cq) if (past.has(q)) return { repeated: true, kind: 'QUESTION' };
  }
  return { repeated: false, kind: null };
}

// Relance commerciale = question/invitation à acheter
const SALES_PUSH_RE = /(souhaitez[- ]vous (?:vous )?(?:inscrire|acheter|commander|payer|profiter)|voulez[- ]vous (?:vous )?(?:inscrire|acheter|commander|payer|profiter)|allez[- ]vous (?:payer|vous inscrire)|profiter de l'offre|je vous inscris|inscrivez[- ]vous|cliquez (?:ici )?pour (?:payer|vous inscrire)|c'est le moment de|ne (?:ratez|manquez) pas|offre (?:limit|exceptionnelle)|derni[eè]res? places?)/i;

module.exports = { similarity, check, questionsOf, SALES_PUSH_RE, tokens };
