const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

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

// Police embarquée (licence permissive, voir node_modules/dejavu-fonts-ttf)
// plutôt que de dépendre d'une police système : l'image Docker de
// déploiement (node:20-slim) n'installe aucune police, et le filtre
// ffmpeg "drawtext" échoue silencieusement sans fontfile valide.
const FONT_PATH = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf', 'DejaVuSans-Bold.ttf');

function writeTemp(buffer, ext) {
  const filePath = path.join(os.tmpdir(), `mixer_${crypto.randomBytes(8).toString('hex')}${ext}`);
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
      if (!duration || !Number.isFinite(duration)) return reject(new Error('Durée de clip introuvable (ffprobe).'));
      resolve(duration);
    });
  });
}

function probeDimensions(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return reject(err);
      const stream = (data.streams || []).find((s) => s.width && s.height);
      if (!stream) return reject(new Error('Dimensions de clip introuvables (ffprobe).'));
      resolve({ width: stream.width, height: stream.height });
    });
  });
}

// Chaque valeur "text=" ci-dessous est entourée de guillemets simples
// ('...') dans le filtergraph — à L'INTÉRIEUR de ces guillemets, la syntaxe
// ffmpeg prend tout littéralement (":", ";", ",", "[", "]", "\" n'ont besoin
// d'AUCUN échappement, voir "Notes on filtergraph escaping" dans la
// documentation ffmpeg) : les échapper quand même (version précédente de
// cette fonction) produisait un antislash VISIBLE dans le texte incrusté
// (ex: "Prix\: 19,99€" au lieu de "Prix: 19,99€") — corrigé ici. Le SEUL
// caractère qui pose réellement problème est le guillemet simple lui-même
// (ne peut pas être échappé proprement à l'intérieur d'un bloc déjà entre
// guillemets simples) : remplacé par une apostrophe typographique plutôt
// que la séquence d'échappement standard ('\\''), peu lisible et source
// d'erreurs. Les retours à la ligne (texte collé depuis un <textarea>,
// saut de ligne injecté via l'API) sont aplatis en espace : le filtre doit
// rester une seule ligne logique quel que soit le champ d'origine.
function escapeDrawtext(text) {
  return String(text || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/'/g, '’');
}

function ffmpegPathLiteral(p) {
  return p.replace(/\\/g, '/').replace(/:/g, '\\:');
}

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

    let lastLabel = 'vraw';
    const fontLiteral = ffmpegPathLiteral(FONT_PATH);
    [
      { text: titleText, yFrac: 0.08, sizeFrac: 0.07 },
      { text: priceText, yFrac: 0.5, sizeFrac: 0.09 },
      { text: contactText, yFrac: 0.9, sizeFrac: 0.05 },
    ].forEach((field, idx) => {
      if (!field.text) return;
      const nextLabel = `vt${idx}`;
      filterChain.push(
        `[${lastLabel}]drawtext=fontfile='${fontLiteral}':text='${escapeDrawtext(field.text)}':`
        + `fontcolor=white:fontsize=${Math.round(targetWidth * field.sizeFrac)}:borderw=4:bordercolor=black@0.85:`
        + `x=(w-text_w)/2:y=${Math.round(targetHeight * field.yFrac)}[${nextLabel}]`,
      );
      lastLabel = nextLabel;
    });

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

module.exports = { mixVideos };
