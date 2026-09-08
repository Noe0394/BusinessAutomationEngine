const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  ffmpeg, writeTemp, cleanup, probeDuration, probeDimensions, buildDrawtextFilters,
} = require('./ffmpegMediaUtils');

// IMPORT DE VIDÉOS PERSONNELLES & HABILLAGE TIKTOK/REELS — fusionne
// plusieurs clips importés (téléphone) en une seule vidéo verticale
// habillée (feuille de route). Contrairement au storyboard IA (voir
// storyboardEngine.js, clips déjà uniformes car générés par le même
// fournisseur), des clips importés par l'utilisateur peuvent avoir des
// résolutions/ratios très différents (portrait/paysage, tailles de
// téléphone variées) — d'où un recadrage "cover" (remplir tout le cadre
// 9:16, quitte à rogner les bords) plutôt que le "contain" (letterbox) du
// storyboard, seul choix qui a du sens pour un format TikTok/Reels.
//
// Piste audio : si une musique de fond est fournie, elle REMPLACE
// entièrement l'audio des clips d'origine (volume + fondu configurables) —
// mélanger la musique avec les pistes audio hétérogènes des clips
// importés (certains avec son, d'autres sans, qualités très variables)
// serait fragile pour un bénéfice incertain. Sans musique fournie, la
// sortie est silencieuse (même limitation déjà assumée ailleurs dans
// l'app pour l'export Ken Burns, voir public/dashboard.html).
const TARGET_WIDTH_916 = 1080;
const TARGET_HEIGHT_916 = 1920;
const MIX_TIMEOUT_MS = 4 * 60 * 1000;

// Fusionne plusieurs clips vidéo importés en une seule vidéo (feuille de
// route "Auto-Style TikTok/Reels") :
// - autoStyle916 : recadrage "cover" forcé en 1080x1920 (sinon, conserve le
//   ratio du premier clip, les suivants y sont recadrés).
// - musicBuffer/musicVolume/fadeAudio : musique de fond en remplacement de
//   l'audio d'origine (voir en-tête ci-dessus).
// - titleText/priceText/contactText : bannières de texte incrustées (haut/
//   centre/bas de l'écran).
// - logoBuffer : logo incrusté en haut à droite.
async function mixVideos({ clipBuffers, autoStyle916, musicBuffer, musicVolume, fadeAudio, titleText, priceText, contactText, logoBuffer }) {
  if (!Array.isArray(clipBuffers) || clipBuffers.length === 0) {
    throw new Error('Aucun clip vidéo importé.');
  }

  const clipPaths = clipBuffers.map((b) => writeTemp(b, '.mp4'));
  const musicPath = musicBuffer ? writeTemp(musicBuffer, '.mp3') : null;
  const logoPath = logoBuffer ? writeTemp(logoBuffer, '.png') : null;
  const outputPath = path.join(os.tmpdir(), `mixer_out_${crypto.randomBytes(8).toString('hex')}.mp4`);

  try {
    const { width: targetWidth, height: targetHeight } = autoStyle916
      ? { width: TARGET_WIDTH_916, height: TARGET_HEIGHT_916 }
      : await probeDimensions(clipPaths[0]);

    const filterChain = clipPaths.map((_, i) => (
      `[${i}:v]scale=${targetWidth}:${targetHeight}:force_original_aspect_ratio=increase,`
      + `crop=${targetWidth}:${targetHeight},setsar=1,fps=30[c${i}]`
    ));
    const concatInputs = clipPaths.map((_, i) => `[c${i}]`).join('');
    filterChain.push(`${concatInputs}concat=n=${clipPaths.length}:v=1:a=0[vraw]`);

    const { filters: textFilters, lastLabel: afterText } = buildDrawtextFilters([
      { text: titleText, yFrac: 0.08, sizeFrac: 0.07 },
      { text: priceText, yFrac: 0.5, sizeFrac: 0.09 },
      { text: contactText, yFrac: 0.9, sizeFrac: 0.05 },
    ], 'vraw', targetWidth, targetHeight);
    filterChain.push(...textFilters);
    let lastLabel = afterText;

    const extraInputs = [];
    let logoInputIndex = null;
    let musicInputIndex = null;
    if (musicPath) { musicInputIndex = clipPaths.length + extraInputs.length; extraInputs.push(musicPath); }
    if (logoPath) { logoInputIndex = clipPaths.length + extraInputs.length; extraInputs.push(logoPath); }

    if (logoPath) {
      filterChain.push(`[${logoInputIndex}:v]scale=${Math.round(targetWidth * 0.22)}:-1[logo]`);
      filterChain.push(`[${lastLabel}][logo]overlay=W-w-24:24[vout]`);
    } else {
      filterChain.push(`[${lastLabel}]null[vout]`);
    }

    const outputMaps = ['vout'];
    const outputOptions = ['-c:v', 'libx264', '-preset', 'veryfast', '-movflags', '+faststart'];

    if (musicPath) {
      const totalDuration = (await Promise.all(clipPaths.map(probeDuration))).reduce((a, b) => a + b, 0);
      const fadeOutStart = Math.max(0, totalDuration - 1.5);
      const volume = Number.isFinite(musicVolume) ? Math.min(Math.max(musicVolume, 0), 2) : 0.8;
      const fadeSuffix = fadeAudio ? `,afade=t=in:st=0:d=1,afade=t=out:st=${fadeOutStart.toFixed(2)}:d=1.5` : '';
      filterChain.push(`[${musicInputIndex}:a]volume=${volume}${fadeSuffix}[aout]`);
      outputMaps.push('aout');
      outputOptions.push('-c:a', 'aac', '-shortest');
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
      clipPaths.forEach((p) => command.input(p));
      extraInputs.forEach((p) => command.input(p));
      command
        .complexFilter(filterChain, outputMaps)
        .outputOptions(outputOptions)
        .on('end', () => finish())
        .on('error', (err) => finish(err))
        .save(outputPath);

      const timer = setTimeout(() => {
        if (settled) return;
        command.kill('SIGKILL');
        finish(new Error('Le montage vidéo a dépassé le délai maximal (clips trop nombreux/trop longs).'));
      }, MIX_TIMEOUT_MS);
    });

    return fs.readFileSync(outputPath);
  } finally {
    cleanup([...clipPaths, musicPath, logoPath, outputPath]);
  }
}

// Post-traitement LÉGER d'une vidéo déjà générée par IA (voir index.js —
// Chat-First, incrustation automatique du logo importé par l'utilisateur) :
// contrairement à mixVideos ci-dessus (fusion de plusieurs clips + texte),
// ceci ne fait qu'incruster un logo en haut à droite sur un flux vidéo déjà
// complet, sans re-catégoriser sa résolution ni toucher son audio.
async function overlayLogoOnVideo(videoBuffer, logoBuffer) {
  const videoPath = writeTemp(videoBuffer, '.mp4');
  const logoPath = writeTemp(logoBuffer, '.png');
  const outputPath = path.join(os.tmpdir(), `mixer_logo_out_${crypto.randomBytes(8).toString('hex')}.mp4`);

  try {
    const { width } = await probeDimensions(videoPath);
    const filterChain = [
      `[1:v]scale=${Math.round(width * 0.22)}:-1[logo]`,
      '[0:v][logo]overlay=W-w-24:24[vout]',
    ];

    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err); else resolve();
      };
      const command = ffmpeg().input(videoPath).input(logoPath)
        .complexFilter(filterChain, ['vout'])
        .outputOptions(['-map', '0:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-c:a', 'copy', '-movflags', '+faststart'])
        .on('end', () => finish())
        .on('error', (err) => finish(err))
        .save(outputPath);

      const timer = setTimeout(() => {
        if (settled) return;
        command.kill('SIGKILL');
        finish(new Error("L'incrustation du logo a dépassé le délai maximal."));
      }, MIX_TIMEOUT_MS);
    });

    return fs.readFileSync(outputPath);
  } finally {
    cleanup([videoPath, logoPath, outputPath]);
  }
}

module.exports = { mixVideos, overlayLogoOnVideo };
