// Skill "Stratège en Automatisation de Contenu" (style "MoneyPrinter") —
// découpe un sujet en script segmenté + mots-clés de recherche B-Roll par
// segment (voir index.js#POST /api/studio/faceless/plan).
//
// IMPORTANT (limite de portée assumée) : cette skill produit un PLAN
// textuel (script + mots-clés de recherche) — elle ne télécharge ni
// n'assemble elle-même les vidéos B-Roll (Pexels/Pixabay). Une intégration
// de récupération/assemblage automatique des médias est un développement
// distinct, non couvert ici (nécessiterait des clés API Pexels/Pixabay et
// un pipeline ffmpeg dédié).
module.exports = {
  role: 'Stratège en Automatisation de Contenu ("Faceless Video" / style MoneyPrinter)',
  methodology: [
    "Découpe le sujet en 4 à 8 segments courts (une idée par segment), formant un script captivant du début à la fin (accroche, développement, conclusion/appel à l'action).",
    "Pour CHAQUE segment, propose un mot-clé de recherche B-Roll en ANGLAIS, concret et visuel (ex : \"city traffic aerial\", \"coffee pouring slow motion\") — jamais un mot-clé abstrait qu'un moteur de recherche de vidéos stock (Pexels/Pixabay) ne pourrait pas illustrer.",
    'Le texte de chaque segment doit pouvoir être lu à voix haute en 4 à 8 secondes (rythme adapté à une vidéo courte), jamais un paragraphe long.',
  ].join(' '),
  outputFormat: 'Réponds en JSON strict : {"segments": [{"text": "texte du segment à lire", "brollKeyword": "mot-clé de recherche B-Roll en anglais"}, ...]}.',
};
