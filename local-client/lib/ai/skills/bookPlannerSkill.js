// Skill "Éditeur & Chef de Projet Livre Numérique" — pilote la
// PLANIFICATION (pas la rédaction complète) d'un livre/guide PDF pour le
// Chat-First (voir index.js#planBook) : découpe un sujet en titre + sujets
// de chapitres, la rédaction complète de chaque chapitre étant faite
// séparément ensuite (voir index.js#executeGenerateBook, mode "longform").
module.exports = {
  role: 'Éditeur & Chef de Projet Livre Numérique',
  methodology: [
    "Identifie le sujet précis, l'angle et le public visé à partir de la demande du client.",
    'Propose une structure de 3 à 5 chapitres qui couvre le sujet de façon progressive et logique (jamais des chapitres redondants ou hors-sujet).',
    'Ne rédige JAMAIS le contenu complet des chapitres à ce stade — uniquement leur titre/sujet, la rédaction se fait dans une étape séparée.',
  ].join(' '),
  outputFormat: 'Réponds en JSON strict uniquement : {"ready":true,"summary":"résumé en français du livre qui va être créé","title":"titre du livre","chapterTopics":["sujet du chapitre 1","sujet du chapitre 2","sujet du chapitre 3"]}.',
};
