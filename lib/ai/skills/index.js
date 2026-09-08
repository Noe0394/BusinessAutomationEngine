// REGISTRE CENTRALISÉ DES SKILLS EXPERTES — un fichier par métier (voir les
// autres fichiers de ce dossier), chacun important dans le prompt système
// de la cascade LLM (lib/ai/llmFallbackEngine.js) via buildSkillPromptBlock
// ci-dessous. Contrairement à lib/ai/marketingSkills.js (détection par
// mots-clés dans un message de chat libre, toujours active), ce registre
// est destiné à un usage EXPLICITE : chaque route serveur d'un module
// précis du Studio (voir index.js) sait déjà quelle(s) skill(s) invoquer et
// les passe directement à generateAIResponse — jamais une détection
// heuristique pour ces flux structurés.
const designDirectorSkill = require('./designDirectorSkill');
const videoCinematographerSkill = require('./videoCinematographerSkill');
const ugcCreatorSkill = require('./ugcCreatorSkill');
const mobileFormatExpertSkill = require('./mobileFormatExpertSkill');
const facelessAutomationSkill = require('./facelessAutomationSkill');
const conversionContactSkill = require('./conversionContactSkill');

const SKILLS = {
  designDirectorSkill,
  videoCinematographerSkill,
  ugcCreatorSkill,
  mobileFormatExpertSkill,
  facelessAutomationSkill,
  conversionContactSkill,
};

// Correspondance module Studio -> skill(s) (feuille de route) — utilisée par
// index.js pour documenter/valider quelle route appelle quelle(s) skill(s),
// pas strictement nécessaire à l'exécution (les routes passent déjà les
// clés directement) mais garde la correspondance visible à un seul endroit.
const MODULE_SKILLS = {
  poster_generation: ['designDirectorSkill'],
  sequential_video: ['videoCinematographerSkill'],
  ugc_product: ['ugcCreatorSkill', 'conversionContactSkill'],
  mobile_assembly: ['mobileFormatExpertSkill'],
  faceless_shorts: ['facelessAutomationSkill'],
};

// Construit le bloc d'instruction à injecter dans le system prompt (voir
// llmFallbackEngine.js#buildSystemPrompt) pour une ou plusieurs skills
// combinées — chaque skill ajoute son propre rôle/méthodologie/format,
// clairement délimités, plutôt que de les fusionner en un bloc ambigu.
function buildSkillPromptBlock(skillKeys) {
  const keys = Array.isArray(skillKeys) ? skillKeys : [skillKeys];
  const blocks = keys
    .map((key) => SKILLS[key])
    .filter(Boolean)
    .map((skill) => [
      `Endosse le rôle de : ${skill.role}.`,
      `Méthodologie à appliquer strictement : ${skill.methodology}`,
      `Format de sortie attendu : ${skill.outputFormat}`,
    ].join('\n'));

  if (blocks.length === 0) return '';
  if (blocks.length === 1) return blocks[0];

  // Plusieurs skills combinées (ex : Module UGC Produit) : chaque bloc reste
  // distinct, avec une consigne explicite de les appliquer ENSEMBLE plutôt
  // que de n'en retenir qu'une — évite qu'un modèle n'ignore la seconde
  // instruction par simplification.
  return `Applique ENSEMBLE les ${blocks.length} compétences expertes suivantes pour cette réponse :\n\n${blocks.join('\n\n---\n\n')}`;
}

module.exports = {
  SKILLS,
  MODULE_SKILLS,
  buildSkillPromptBlock,
};
