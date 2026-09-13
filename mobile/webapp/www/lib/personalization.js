// Port navigateur de local-client/lib/personalization.js (logique identique
// - voir ce fichier pour les commentaires d'origine). Depend de spintax.js
// (charge avant celui-ci, voir index.html).
(function () {
  const resolveSpintax = window.Cyrus.spintax.resolveSpintax;
  // String.fromCharCode plutot qu'un litteral \uXXXX dans le source : un
  // caractere de controle brut colle directement dans ce fichier s'est deja
  // avere silencieusement vide (perdu en transit) lors d'une premiere version.
  const PROTECT_TOKEN = String.fromCharCode(1);
  const REMOVED_MARK = String.fromCharCode(2);

  function replaceVariables(template, vars) {
    const row = vars || {};
    const marked = String(template).replace(/([ \t]*)\{(\w+)\}/g, function (match, leadingSpace, key) {
      const value = row[key];
      if (value !== undefined && value !== null && value !== '') {
        return leadingSpace + String(value);
      }
      return leadingSpace ? ' ' + REMOVED_MARK : REMOVED_MARK;
    });

    let cleaned = marked;
    let previous;
    do {
      previous = cleaned;
      cleaned = cleaned.replace(new RegExp('[ \\t]*' + REMOVED_MARK + '[ \\t]*(?=[,.;:!?]|$)', 'g'), '');
    } while (cleaned !== previous);

    return cleaned
      .replace(new RegExp(REMOVED_MARK, 'g'), ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function buildPersonalizationVars(name, identifier) {
    const cleanName = name ? String(name).trim() : '';
    const cleanIdentifier = identifier !== undefined && identifier !== null && identifier !== ''
      ? String(identifier).trim()
      : '';
    return {
      nom: cleanName,
      prenom: cleanName,
      first_name: cleanName,
      name: cleanName,
      username: cleanIdentifier,
    };
  }

  function personalizeMessage(template, vars) {
    if (typeof template !== 'string' || !template) return template || '';

    const placeholders = [];
    const protectedText = template.replace(/\{(\w+)\}/g, function (match, key) {
      placeholders.push(key);
      return PROTECT_TOKEN + (placeholders.length - 1) + PROTECT_TOKEN;
    });

    const spun = resolveSpintax(protectedText);

    const restored = spun.replace(
      new RegExp(PROTECT_TOKEN + '(\\d+)' + PROTECT_TOKEN, 'g'),
      function (match, idx) { return '{' + placeholders[idx] + '}'; },
    );

    return replaceVariables(restored, vars);
  }

  window.Cyrus.personalization = { replaceVariables: replaceVariables, buildPersonalizationVars: buildPersonalizationVars, personalizeMessage: personalizeMessage };
})();
