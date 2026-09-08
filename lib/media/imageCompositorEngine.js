const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  ffmpeg, writeTemp, cleanup, buildDrawtextFilters,
} = require('./ffmpegMediaUtils');

// HABILLAGE D'AFFICHE GÉNÉRÉE PAR IA (Chat-First, voir index.js) — un
// modèle de génération d'image (FLUX/fal.ai, voir imageAiEngine.js) ne rend
// JAMAIS du texte fiable et lisible (titre, prix, contact) directement dans
// l'image — exactement le même problème que rencontrait déjà l'ancien
// Studio Média, qui composait ces éléments via Canvas 2D CÔTÉ NAVIGATEUR
// (voir public/dashboard.html#mediaDrawFlyerLayers). Le flux Chat-First
// génère l'image CÔTÉ SERVEUR : ce fichier reproduit la même idée avec
// ffmpeg (déjà utilisé pour l'habillage vidéo, voir videoMixerEngine.js)
// plutôt que d'introduire une dépendance "canvas" native supplémentaire.
const MIX_TIMEOUT_MS = 60 * 1000;

// Incruste titre/prix/contact/badge + logo sur une image déjà générée.
// Traite l'image comme une vidéo d'UNE seule frame (-frames:v 1) : mêmes
// filtres drawtext/overlay que videoMixerEngine.js, sortie JPEG.
async function compositeImage({ imageBuffer, titleText, priceText, contactText, badgeText, logoBuffer }) {
  const { probeDimensions } = require('./ffmpegMediaUtils');
  const imagePath = writeTemp(imageBuffer, '.jpg');
  const logoPath = logoBuffer ? writeTemp(logoBuffer, '.png') : null;
  const outputPath = path.join(os.tmpdir(), `composite_${crypto.randomBytes(8).toString('hex')}.jpg`);

  try {
    // Dimensions lues via ffprobe : nécessaires pour dimensionner texte/logo
    // proportionnellement, l'appelant (voir index.js) ne les connaît pas
    // forcément avec certitude une fois l'image redescendue de fal.ai/Pollinations.
    const { width, height } = await probeDimensions(imagePath);

    // [0:v] : première (et pour l'instant unique) entrée du filtergraph —
    // syntaxe "-filter_complex" avec entrées numérotées, jamais l'alias
    // implicite "[in]" (réservé à la syntaxe simple "-vf", invalide ici).
    const { filters: textFilters, lastLabel } = buildDrawtextFilters([
      { text: titleText, yFrac: 0.06, sizeFrac: 0.06 },
      { text: badgeText, yFrac: 0.16, sizeFrac: 0.04 },
      { text: priceText, yFrac: 0.78, sizeFrac: 0.08 },
      { text: contactText, yFrac: 0.90, sizeFrac: 0.035 },
    ], '0:v', width, height);

    const filterChain = [...textFilters];
    let finalLabel = textFilters.length ? lastLabel : '0:v';

    const inputs = [imagePath];
    if (logoPath) {
      inputs.push(logoPath);
      filterChain.push(`[1:v]scale=${Math.round(width * 0.18)}:-1[logo]`);
      filterChain.push(`[${finalLabel}][logo]overlay=W-w-24:24[vout]`);
    } else {
      filterChain.push(`[${finalLabel}]null[vout]`);
    }

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve();
      };
      const command = ffmpeg();
      inputs.forEach((p) => command.input(p));
      command
        .complexFilter(filterChain, ['vout'])
        .outputOptions(['-frames:v', '1', '-update', '1'])
        .on('end', () => finish())
        .on('error', (err) => finish(err))
        .save(outputPath);

      const timer = setTimeout(() => {
        if (settled) return;
        command.kill('SIGKILL');
        finish(new Error("L'habillage de l'affiche a dépassé le délai maximal."));
      }, MIX_TIMEOUT_MS);
    });

    return fs.readFileSync(outputPath);
  } finally {
    cleanup([imagePath, logoPath, outputPath]);
  }
}

module.exports = { compositeImage };
