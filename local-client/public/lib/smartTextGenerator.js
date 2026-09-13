// Port fidele du composant "Copywriter IA Intelligent" (SmartTextGenerator)
// de public/dashboard.html (voir smartTextGenerateVariant/synonymize dans ce
// fichier) - moteur de permutations cote client (aucun appel reseau, aucune
// IA generative) : pioche une accroche, un cadrage de l'intention, 2-3 puces
// d'avantages (reformulees mot a mot via un dictionnaire de synonymes) et un
// appel a l'action, pour qu'aucun destinataire ne recoive mot pour mot le
// meme texte. Utilise par la Relance Manuelle Express (voir manualRelance.js).
(function () {
  const HOOKS_GROUP = [
    '🔥 Salut la famille !', "👋 Hello l'équipe,", '✨ Coucou à tous !', '😊 Bonjour à toutes et tous,',
    '📣 Chers membres,', '🌟 Une info pour toute la communauté !', '🎯 Info du jour pour vous tous :',
    '💬 Salut le groupe !', '📢 À toute la team,', '🙌 Hello tout le monde !',
  ];

  function hooksPrivate(name) {
    return name
      ? [
        `🔥 Salut ${name} !`, `👋 Coucou ${name},`, `✨ Hey ${name} !`, `😊 Bonjour ${name},`,
        `🙌 Salut ${name}, j'espère que tu vas bien !`, `💌 Hello ${name} !`, `🌟 ${name}, j'ai une info pour toi !`,
        `👋 Petit coucou, ${name} !`, `😄 Salut ${name}, ça faisait longtemps !`, `🎯 ${name}, j'ai pensé à toi !`,
      ]
      : [
        '🔥 Salut !', '👋 Bonjour,', '✨ Hey !', '😊 Bonjour à vous,', '💌 Hello !',
        "🌟 J'ai une info pour vous !", '🎯 Petite info du jour :',
      ];
  }

  const BENEFITS = [
    '⏳ Offre valable pour une durée limitée',
    '🎁 Sans engagement',
    '💯 Satisfait ou remboursé',
    '🙌 Déjà des dizaines de clients conquis',
    '🔒 Paiement 100% sécurisé',
    '📦 Accès ou livraison immédiat',
    '🏆 Qualité garantie',
    '💸 Un prix imbattable',
    '🕒 Places limitées',
    '🎯 Des résultats rapides',
    '👍 Simple et rapide à obtenir',
    '🌟 Une occasion à ne pas laisser passer',
    '✅ Facile à obtenir',
    '🔥 Une offre exceptionnelle',
    '🎉 Un bon plan à saisir vite',
  ];

  const CTAS_GROUP = [
    '👉 Dites-nous si ça vous intéresse !', '📩 Réagissez en commentaire pour en savoir plus.',
    '✅ On reste dispo pour toute question !', '🙏 Hâte de vous lire !',
    '💬 Qu\'en pensez-vous ?', '🤝 Ça vous tente ?', "⚡ Foncez avant qu'il ne soit trop tard !",
    '🎯 Réservez votre place dès maintenant !', '📲 Écrivez-nous pour valider !', '🚀 Ne ratez pas cette occasion !',
  ];
  const CTAS_PRIVATE = [
    "👉 Dis-moi si ça t'intéresse !", '📩 Réponds-moi pour en savoir plus.',
    '✅ Je reste dispo pour toute question !', "🙏 Hâte d'avoir ton retour !",
    '💬 On en discute ?', '🤝 Ça te dit ?', "⚡ Fonce avant qu'il ne soit trop tard !",
    '🎯 Réserve ta place dès maintenant !', "📲 Écris-moi pour valider !", '🚀 Ne rate pas cette occasion !',
  ];

  const SYNONYM_MAP = {
    rapide: ['rapide', 'express', 'ultra-rapide', 'instantané'],
    rapides: ['rapides', 'express', 'instantanés'],
    immédiat: ['immédiat', 'instantané', 'sur-le-champ'],
    garantie: ['garantie', 'assurée', 'certifiée'],
    garanti: ['garanti', 'assuré', 'certifié'],
    imbattable: ['imbattable', 'canon', 'incroyable', 'exceptionnel'],
    limitée: ['limitée', 'restreinte', 'exceptionnelle'],
    limitées: ['limitées', 'comptées', 'exceptionnelles'],
    simple: ['simple', 'facile', 'sans prise de tête'],
    facile: ['facile', 'simple', 'sans effort'],
    occasion: ['occasion', 'opportunité', 'bon plan'],
    exceptionnelle: ['exceptionnelle', 'unique', 'rare'],
    exceptionnel: ['exceptionnel', 'unique', 'rare'],
    offre: ['offre', 'promo', 'deal', 'bon plan'],
    dispo: ['dispo', 'disponible', 'joignable'],
    vite: ['vite', 'rapidement', 'sans tarder'],
  };

  function synonymize(text) {
    return text.replace(/\p{L}+/gu, function (word) {
      const options = SYNONYM_MAP[word.toLowerCase()];
      if (!options) return word;
      const choice = options[Math.floor(Math.random() * options.length)];
      return word[0] !== word[0].toLowerCase() ? choice[0].toUpperCase() + choice.slice(1) : choice;
    });
  }

  function pick(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
  }

  // Tire N elements distincts d'un pool, dans un ordre aleatoire.
  function pickN(arr, n) {
    const pool = arr.slice();
    const picked = [];
    for (let i = 0; i < n && pool.length; i += 1) {
      picked.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0]);
    }
    return picked;
  }

  // channelMode : 'private' (1-to-1, tutoiement, `name` optionnel injecte
  // dans l'accroche) ou 'group' (diffusion, vouvoiement pluriel, `name`
  // ignore).
  function smartTextGenerateVariant(intentionRaw, channelMode, name) {
    const isGroup = channelMode === 'group';
    const urlMatch = intentionRaw.match(/https?:\/\/\S+/i);
    const link = urlMatch ? urlMatch[0] : '';
    const core = intentionRaw.replace(link, '').trim()
      .replace(/[,;:\s-]*\b(lien|link)\s*:?\s*$/i, '')
      .trim()
      .replace(/[\s,;:.-]+$/, '');

    const HOOKS = isGroup ? HOOKS_GROUP : hooksPrivate(name);
    const CORE_FRAMES = core
      ? [`🎯 ${core}`, `🔥 ${core}`, `📢 ${core}`, `💥 ${core}`, `👀 ${core}`, `🚀 ${core}`, `⚡ ${core}`, `✨ À ne pas manquer : ${core}`]
      : [];
    const CTAS = isGroup ? CTAS_GROUP : CTAS_PRIVATE;

    const bulletCount = 2 + Math.round(Math.random());
    const bullets = (core
      ? [pick(CORE_FRAMES), ...pickN(BENEFITS, bulletCount - 1)]
      : pickN(BENEFITS, bulletCount)
    ).map(function (line, idx) { return (idx === 0 && core) ? line : synonymize(line); });

    const lines = [pick(HOOKS), '', ...bullets, ''];
    if (link) lines.push(`🔗 ${link}`);
    lines.push(synonymize(pick(CTAS)));

    return lines.join('\n');
  }

  window.Cyrus = window.Cyrus || {};
  window.Cyrus.smartTextGenerator = { generateVariant: smartTextGenerateVariant, synonymize: synonymize };
})();
