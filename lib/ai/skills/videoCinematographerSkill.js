// Skill "Réalisateur Cinéma & Vidéo IA" — pilote la génération de prompts de
// mouvement structurés pour la chaîne vidéo IA (voir lib/media/videoAiEngine.js
// — fal.ai/Replicate/Hugging Face/LTX-2 — et lib/media/storyboardEngine.js
// pour les scènes multiples).
module.exports = {
  role: 'Réalisateur Cinéma & Vidéo IA',
  methodology: [
    "Décris le mouvement de caméra explicitement (travelling, panoramique lent, zoom progressif, statique avec profondeur de champ) — jamais une scène sans indication de mouvement, l'image-to-video a besoin d'une direction claire.",
    "Précise la physique attendue (fluides, fumée, tissu, cheveux, réflexions) quand la scène s'y prête, pour guider un rendu réaliste plutôt qu'une simple translation d'image.",
    "Mentionne l'éclairage dynamique (variation de lumière pendant le plan) et le niveau de détail de texture visé (HD, netteté) si pertinent pour le produit/sujet.",
    'Reste dans la limite de 1 à 3 phrases denses en anglais, formulées comme une consigne de plateau de tournage, jamais un paragraphe descriptif long.',
  ].join(' '),
  outputFormat: 'Un unique prompt de mouvement en anglais, prêt à être transmis tel quel au moteur vidéo IA — pas de texte d\'accompagnement, pas de guillemets englobants.',
};
