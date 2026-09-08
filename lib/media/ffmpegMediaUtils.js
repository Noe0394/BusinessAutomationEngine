const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Utilitaires ffmpeg PARTAGÉS entre lib/media/videoMixerEngine.js,
// lib/media/imageCompositorEngine.js et le post-traitement (logo) des
// vidéos générées par IA (voir index.js) — extraits ici pour ne pas
// dupliquer trois fois la même logique d'échappement/police/fichiers
// temporaires.

// Police embarquée (licence permissive, voir node_modules/dejavu-fonts-ttf)
// plutôt que de dépendre d'une police système : l'image Docker de
// déploiement (node:20-slim) n'installe aucune police, et le filtre ffmpeg
// "drawtext" échoue silencieusement sans fontfile valide.
const FONT_PATH = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf', 'DejaVuSans-Bold.ttf');

function writeTemp(buffer, ext) {
  const filePath = path.join(os.tmpdir(), `media_${crypto.randomBytes(8).toString('hex')}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function cleanup(paths) {
  paths.filter(Boolean).forEach((p) => { try { fs.unlinkSync(p); } catch (err) { /* déjà absent */ } });
}

function probeDuration(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return reject(err);
      const duration = data && data.format && data.format.duration;
      if (!duration || !Number.isFinite(duration)) return reject(new Error('Durée introuvable (ffprobe).'));
      resolve(duration);
    });
  });
}

function probeDimensions(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return reject(err);
      const stream = (data.streams || []).find((s) => s.width && s.height);
      if (!stream) return reject(new Error('Dimensions introuvables (ffprobe).'));
      resolve({ width: stream.width, height: stream.height });
    });
  });
}

// CORRECTIF (vérifié empiriquement en direct — la documentation ffmpeg sur
// l'échappement "niveau 1" entre guillemets simples s'est avérée trompeuse
// pour la version d'ffmpeg utilisée ici) : un ":" NON échappé dans une
// valeur "text=" tronque silencieusement tout le texte à partir de ce
// caractère (aucune erreur, juste un rendu incomplet — constaté sur
// plusieurs tests contrôlés : "Raw colon: test" affichait seulement
// "test"). Le backslash AVANT le ":" (\\:) corrige bien le rendu SANS
// produire d'antislash visible (re-testé et confirmé visuellement) — la
// précédente version de cette fonction avait supprimé cet échappement par
// erreur, en se fiant à la doc plutôt qu'à un test réel avec un ":". Le
// guillemet simple reste le seul autre caractère à traiter : remplacé par
// une apostrophe typographique plutôt que la séquence d'échappement
// standard ('\\''), peu lisible et source d'erreurs. Les retours à la
// ligne sont aplatis en espace : le filtre doit rester une seule ligne
// logique.
function escapeDrawtext(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/:/g, '\\:')
    .replace(/'/g, '’');
}

function ffmpegPathLiteral(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

// Construit une chaîne de filtres drawtext successifs à partir d'une liste
// de { text, yFrac, sizeFrac } (voir videoMixerEngine.js/imageCompositorEngine.js
// pour l'usage). `lastLabel` est le label d'entrée déjà présent dans le
// filtergraph ; retourne { filters, lastLabel } avec le nouveau label final.
function buildDrawtextFilters(fields, lastLabel, width, height) {
  const filters = [];
  const fontLiteral = ffmpegPathLiteral(FONT_PATH);
  // Labels générés indépendamment de `lastLabel` (préfixe fixe "dt" +
  // compteur global aléatoire) : `lastLabel` peut valoir "0:v" (référence à
  // une entrée numérotée du filtergraph, voir imageCompositorEngine.js) —
  // un ":" dans un nom de label casserait le filtergraph, jamais valide
  // pour nommer un lien, seulement pour référencer une entrée.
  const runId = Math.random().toString(36).slice(2, 8);
  let label = lastLabel;
  let counter = 0;
  fields.forEach((field) => {
    if (!field.text) return;
    const nextLabel = `dt${runId}_${counter}`;
    counter += 1;
    filters.push(
      `[${label}]drawtext=fontfile='${fontLiteral}':text='${escapeDrawtext(field.text)}':`
      + `fontcolor=white:fontsize=${Math.round(width * field.sizeFrac)}:borderw=4:bordercolor=black@0.85:`
      + `x=(w-text_w)/2:y=${Math.round(height * field.yFrac)}[${nextLabel}]`,
    );
    label = nextLabel;
  });
  return { filters, lastLabel: label };
}

module.exports = {
  FONT_PATH,
  writeTemp,
  cleanup,
  probeDuration,
  probeDimensions,
  escapeDrawtext,
  ffmpegPathLiteral,
  buildDrawtextFilters,
  ffmpeg,
};
