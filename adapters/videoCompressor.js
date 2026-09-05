const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// Limite ciblée par la compression : WhatsApp accepte des vidéos bien plus
// lourdes en pratique, mais au-delà d'un certain poids l'envoi en message de
// type "vidéo" devient peu fiable (rejet, échec silencieux, transcodage côté
// serveur WhatsApp) — 15 Mo est la valeur demandée pour ce module.
const MAX_SIZE_BYTES = 15 * 1024 * 1024;
// Au-delà, on abandonne la compression plutôt que de bloquer indéfiniment
// une campagne WhatsApp sur un seul fichier — voir compressVideoIfNeeded.
const COMPRESSION_TIMEOUT_MS = 90 * 1000;
const AUDIO_BITRATE_BPS = 96 * 1000;
const MIN_VIDEO_BITRATE_BPS = 150 * 1000;

function probeDurationSeconds(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return reject(err);
      const duration = data?.format?.duration;
      if (!duration || !Number.isFinite(duration) || duration <= 0) {
        return reject(new Error('DURATION_UNKNOWN'));
      }
      return resolve(duration);
    });
  });
}

function runCompression(inputPath, outputPath, { videoBitrateBps, height }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };

    const command = ffmpeg(inputPath)
      .videoCodec('libx264')
      .size(`?x${height}`)
      .videoBitrate(Math.round(videoBitrateBps / 1000))
      .audioCodec('aac')
      .audioBitrate(Math.round(AUDIO_BITRATE_BPS / 1000))
      .outputOptions(['-preset veryfast', '-movflags +faststart'])
      .on('end', () => finish())
      .on('error', (err) => finish(err))
      .save(outputPath);

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      command.kill('SIGKILL');
      reject(new Error('COMPRESSION_TIMEOUT'));
    }, COMPRESSION_TIMEOUT_MS);
  });
}

/**
 * Compresse une vidéo trop lourde (> MAX_SIZE_BYTES) pour un envoi WhatsApp :
 * calcule le débit cible à partir de la durée réelle (ffprobe) pour viser
 * fiablement le poids demandé plutôt que de deviner un débit fixe, résolution
 * abaissée à 720p (ou 480p si le débit calculé est trop faible pour rester
 * lisible en 720p). En cas d'échec, de dépassement du délai, ou si le
 * résultat dépasse quand même MAX_SIZE_BYTES, renvoie forceDocument:true —
 * l'appelant doit alors envoyer le fichier ORIGINAL en pièce jointe
 * "document" (limite de taille bien plus haute chez WhatsApp que pour un
 * message de type "vidéo") plutôt que d'échouer l'envoi.
 */
async function compressVideoIfNeeded(buffer, originalFilename) {
  if (buffer.length <= MAX_SIZE_BYTES) {
    return { buffer, mimetype: 'video/mp4', forceDocument: false };
  }

  const tmpDir = os.tmpdir();
  const token = crypto.randomBytes(8).toString('hex');
  const inputExt = path.extname(originalFilename || '') || '.mp4';
  const inputPath = path.join(tmpDir, `wa_video_in_${token}${inputExt}`);
  const outputPath = path.join(tmpDir, `wa_video_out_${token}.mp4`);

  try {
    fs.writeFileSync(inputPath, buffer);

    const durationSeconds = await probeDurationSeconds(inputPath);

    // Marge de sécurité (8%) : le conteneur MP4 et ses métadonnées ajoutent
    // un peu de poids au-delà du seul débit vidéo+audio encodé.
    const targetTotalBps = (MAX_SIZE_BYTES * 8 * 0.92) / durationSeconds;
    const videoBitrateBps = Math.max(MIN_VIDEO_BITRATE_BPS, targetTotalBps - AUDIO_BITRATE_BPS);
    const height = videoBitrateBps >= 800 * 1000 ? 720 : 480;

    await runCompression(inputPath, outputPath, { videoBitrateBps, height });

    const compressed = fs.readFileSync(outputPath);
    if (compressed.length <= MAX_SIZE_BYTES) {
      return { buffer: compressed, mimetype: 'video/mp4', forceDocument: false };
    }

    console.warn(
      `Compression vidéo insuffisante (${compressed.length} octets > ${MAX_SIZE_BYTES}) — bascule en envoi "document".`,
    );
    return { buffer, mimetype: null, forceDocument: true };
  } catch (err) {
    console.warn('Compression vidéo échouée ou trop longue — bascule en envoi "document" :', err.message);
    return { buffer, mimetype: null, forceDocument: true };
  } finally {
    try { fs.unlinkSync(inputPath); } catch (err) { /* déjà absent */ }
    try { fs.unlinkSync(outputPath); } catch (err) { /* déjà absent */ }
  }
}

module.exports = { compressVideoIfNeeded, MAX_SIZE_BYTES };
