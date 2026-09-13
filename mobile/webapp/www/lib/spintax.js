// Port navigateur de local-client/lib/spintax.js (logique identique, juste
// depouillee de module.exports/require - voir ce fichier pour les commentaires
// d'origine sur l'algorithme).
(function () {
  const INNERMOST_BLOCK_REGEX = /\{([^{}]*)\}/g;
  const MAX_PASSES = 25;

  function resolveSpintax(text) {
    if (typeof text !== 'string' || !text.includes('{')) {
      return text;
    }
    let result = text;
    for (let pass = 0; pass < MAX_PASSES; pass += 1) {
      let changed = false;
      result = result.replace(INNERMOST_BLOCK_REGEX, (match, inner) => {
        if (!inner.includes('|')) return match;
        changed = true;
        const options = inner.split('|');
        return options[Math.floor(Math.random() * options.length)];
      });
      if (!changed) break;
    }
    return result;
  }

  window.Cyrus = window.Cyrus || {};
  window.Cyrus.spintax = { resolveSpintax };
})();
