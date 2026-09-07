// Correspondance de mot-clé "en limite de mot" — utilisé par
// marketingKnowledgeBase.js et cyrusSupportGuide.js pour la détection
// d'intention par mots-clés. Un simple `text.includes(keyword)` produit des
// faux positifs fréquents en français dès qu'un mot-clé court est aussi une
// sous-chaîne d'un mot plus long sans rapport (ex: le mot-clé "sea" —
// Search Engine Ads — matche à l'intérieur de "réseau" ; le mot-clé "ebook"
// matche à l'intérieur de "facebook") : cette fonction ne considère une
// correspondance valide que si le mot-clé n'est pas immédiatement encadré
// par un autre caractère "de mot" (lettre/chiffre, accents compris — la
// classe \w native de JavaScript exclut les caractères accentués, d'où
// l'implémentation manuelle plutôt qu'un simple \b regex).
const WORD_CHAR_RE = /[A-Za-zÀ-ÖØ-öø-ÿ0-9_]/;

function isWordChar(ch) {
  return ch !== undefined && WORD_CHAR_RE.test(ch);
}

// Retourne true si `keyword` apparaît dans `text` à une position qui n'est
// pas collée à un autre caractère de mot des deux côtés (les mots-clés qui
// commencent/finissent par un caractère non-mot, ex: "{option", sont de
// fait toujours considérés en limite de ce côté-là).
function keywordMatches(text, keyword) {
  if (!keyword) return false;
  let searchFrom = 0;
  const startsWithWordChar = isWordChar(keyword[0]);
  const endsWithWordChar = isWordChar(keyword[keyword.length - 1]);

  for (;;) {
    const pos = text.indexOf(keyword, searchFrom);
    if (pos === -1) return false;

    const before = pos > 0 ? text[pos - 1] : undefined;
    const after = pos + keyword.length < text.length ? text[pos + keyword.length] : undefined;

    const startOk = !startsWithWordChar || !isWordChar(before);
    const endOk = !endsWithWordChar || !isWordChar(after);
    if (startOk && endOk) return true;

    searchFrom = pos + 1;
  }
}

module.exports = { keywordMatches };
