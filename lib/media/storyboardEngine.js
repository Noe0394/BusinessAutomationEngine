const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const ffmpeg = require('fluent-ffmpeg');
const ffmpegPath = require('ffmpeg-static');
const ffprobePath = require('ffprobe-static').path;
const imageLinkStore = require('./imageLinkStore');
const videoAiEngine = require('./videoAiEngine');

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath);

// CONTINUITÉ MULTI-SCÈNES (storyboard vidéo IA) — feuille de route :
// enchaîne plusieurs scènes image-to-video (voir videoAiEngine.js) en
// conservant la cohérence visuelle d'une scène à l'autre par DEUX leviers :
// (1) le même `seed` numérique et le même suffixe de style transmis à
// chaque scène (cohérence de rendu/ambiance) ; (2) la DERNIÈRE frame de la
// vidéo de la scène N, extraite via ffmpeg, réutilisée comme image de départ
// (image-to-video) de la scène N+1 — c'est ce second levier qui garantit
// réellement la continuité (un sujet qui "part" d'où il s'est arrêté),
// le seed n'étant qu'un raffinement best-effort (voir videoAiEngine.js).
//
// Pipeline entièrement asynchrone et potentiellement long (plusieurs
// minutes, une génération par scène) : startStoryboard() ne fait que
// démarrer l'orchestration en tâche de fond et renvoie immédiatement un id
// à interroger via getStoryboardStatus() (voir index.js, routes
// /api/studio/storyboard/*) — même principe de job stateless que
// /api/studio/video-ai/*, mais avec un état de progression en mémoire ici
// (plusieurs étapes serveur à orchestrer nous-mêmes, pas un simple relais
// vers un job externe).
const SCENE_POLL_MS = 4000;
const SCENE_MAX_POLLS = 75; // ~5 minutes max par scène avant abandon
const STORYBOARD_TTL_MS = 30 * 60 * 1000; // purge de sécurité si jamais lu

const jobs = new Map();

function purgeExpired() {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (job.expiresAt < now) jobs.delete(id);
  }
}

function writeTemp(buffer, ext) {
  const filePath = path.join(os.tmpdir(), `storyboard_${crypto.randomBytes(8).toString('hex')}${ext}`);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

function cleanup(paths) {
  paths.forEach((p) => { try { fs.unlinkSync(p); } catch (err) { /* déjà absent */ } });
}

function probeDimensions(inputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputPath, (err, data) => {
      if (err) return reject(err);
      const stream = (data.streams || []).find((s) => s.width && s.height);
      if (!stream) return reject(new Error('Dimensions vidéo introuvables (ffprobe).'));
      resolve({ width: stream.width, height: stream.height });
    });
  });
}

// Extrait la toute dernière frame d'un clip (voir en-tête ci-dessus) —
// `-sseof -1` positionne la lecture à 1 seconde de la fin plutôt que de
// décoder tout le fichier juste pour en garder la dernière image.
function extractLastFrame(videoBuffer) {
  return new Promise((resolve, reject) => {
    const inputPath = writeTemp(videoBuffer, '.mp4');
    const outputPath = path.join(os.tmpdir(), `storyboard_frame_${crypto.randomBytes(8).toString('hex')}.png`);
    ffmpeg(inputPath)
      .inputOptions(['-sseof', '-1'])
      .outputOptions(['-update', '1', '-q:v', '2'])
      .frames(1)
      .on('end', () => {
        try {
          const buf = fs.readFileSync(outputPath);
          cleanup([inputPath, outputPath]);
          resolve(buf);
        } catch (err) {
          cleanup([inputPath, outputPath]);
          reject(err);
        }
      })
      .on('error', (err) => {
        cleanup([inputPath, outputPath]);
        reject(err);
      })
      .save(outputPath);
  });
}

// Assemble les clips de chaque scène en UNE seule vidéo continue (feuille de
// route : "Assemblage/lecture des clips MP4 dans une timeline cohérente").
// Chaque fournisseur choisit sa propre résolution de sortie selon l'image
// d'entrée — un concat direct échouerait sur des flux de tailles
// différentes, d'où le scale+pad uniforme sur la résolution de la PREMIÈRE
// scène avant concaténation. Piste audio volontairement ignorée (a=0) : les
// clips image-to-video générés n'ont pas de bande son exploitable en
// pratique, mélanger scènes avec/sans audio compliquerait le graphe de
// filtres pour un bénéfice incertain.
async function concatScenes(buffers) {
  if (buffers.length === 1) return buffers[0];

  const inputPaths = buffers.map((b) => writeTemp(b, '.mp4'));
  const outputPath = path.join(os.tmpdir(), `storyboard_final_${crypto.randomBytes(8).toString('hex')}.mp4`);

  try {
    const { width, height } = await probeDimensions(inputPaths[0]);
    const filters = inputPaths.map((_, i) => (
      `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,`
      + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=24[v${i}]`
    ));
    const concatInputs = inputPaths.map((_, i) => `[v${i}]`).join('');
    const filterComplex = `${filters.join(';')};${concatInputs}concat=n=${inputPaths.length}:v=1:a=0[outv]`;

    await new Promise((resolve, reject) => {
      const command = ffmpeg();
      inputPaths.forEach((p) => command.input(p));
      command
        .complexFilter(filterComplex, ['outv'])
        .outputOptions(['-map', '[outv]', '-c:v', 'libx264', '-preset', 'veryfast', '-movflags', '+faststart'])
        .on('end', resolve)
        .on('error', reject)
        .save(outputPath);
    });

    return fs.readFileSync(outputPath);
  } finally {
    cleanup([...inputPaths, outputPath]);
  }
}

async function pollUntilSceneDone(job) {
  for (let attempt = 0; attempt < SCENE_MAX_POLLS; attempt += 1) {
    const result = await videoAiEngine.pollVideoAiJob(job);
    if (result.done) return result;
    await new Promise((resolve) => setTimeout(resolve, SCENE_POLL_MS));
  }
  throw new Error('Délai dépassé pour cette scène (le fournisseur vidéo IA met trop de temps à répondre).');
}

async function fetchSceneBuffer(result) {
  if (result.videoBuffer) return result.videoBuffer;
  const res = await axios.get(result.videoUrl, { responseType: 'arraybuffer', timeout: 120_000 });
  return Buffer.from(res.data);
}

async function runStoryboard(id, { imageBuffer, imageMimetype, scenes, baseStyle, publicBaseUrl }) {
  const state = jobs.get(id);
  // Seed unique pour tout le storyboard (voir en-tête ci-dessus) : transmis
  // à chaque scène pour un rendu visuellement plus cohérent d'un fournisseur
  // qui le respecte (voir videoAiEngine.js#startFalJob/startReplicateJob).
  const seed = Math.floor(Math.random() * 1_000_000);
  let currentImageBuffer = imageBuffer;
  let currentImageMimetype = imageMimetype;
  const sceneBuffers = [];

  try {
    for (let i = 0; i < scenes.length; i += 1) {
      state.currentScene = i + 1;

      const imageId = imageLinkStore.register(currentImageBuffer, currentImageMimetype, {
        title: `Storyboard — image de départ scène ${i + 1}`,
      });
      const imageUrl = `${publicBaseUrl}/v/${imageId}/raw`;
      const prompt = baseStyle ? `${scenes[i]}, ${baseStyle}` : scenes[i];

      const job = await videoAiEngine.startVideoAiJob(imageUrl, prompt, seed);
      const result = await pollUntilSceneDone(job);
      const buffer = await fetchSceneBuffer(result);
      sceneBuffers.push(buffer);

      // Dernière frame de CETTE scène = image de départ de la SUIVANTE
      // (levier de continuité principal, voir en-tête) — inutile de
      // l'extraire après la toute dernière scène.
      if (i < scenes.length - 1) {
        currentImageBuffer = await extractLastFrame(buffer);
        currentImageMimetype = 'image/png';
      }
    }

    state.status = 'assembling';
    const finalBuffer = await concatScenes(sceneBuffers);
    state.resultBuffer = finalBuffer;
    state.resultMimetype = 'video/mp4';
    state.status = 'done';
  } catch (err) {
    state.status = 'error';
    state.error = err.message;
  }
}

function startStoryboard({ imageBuffer, imageMimetype, scenes, baseStyle, publicBaseUrl }) {
  purgeExpired();
  const id = crypto.randomBytes(12).toString('hex');
  const state = {
    status: 'running',
    currentScene: 0,
    totalScenes: scenes.length,
    error: null,
    resultBuffer: null,
    resultMimetype: null,
    expiresAt: Date.now() + STORYBOARD_TTL_MS,
  };
  jobs.set(id, state);

  // Non attendu volontairement : startStoryboard() doit renvoyer
  // immédiatement l'id au client (voir index.js), l'orchestration réelle se
  // poursuit en tâche de fond et met à jour `state` au fil de l'eau.
  runStoryboard(id, { imageBuffer, imageMimetype, scenes, baseStyle, publicBaseUrl }).catch((err) => {
    state.status = 'error';
    state.error = err.message;
  });

  return id;
}

function getStoryboardStatus(id) {
  purgeExpired();
  const state = jobs.get(id);
  if (!state) return null;
  return {
    status: state.status,
    currentScene: state.currentScene,
    totalScenes: state.totalScenes,
    error: state.error,
    resultBuffer: state.resultBuffer,
    resultMimetype: state.resultMimetype,
  };
}

// À appeler une fois le résultat final récupéré (voir index.js) — libère
// immédiatement le buffer vidéo assemblé de la mémoire plutôt que d'attendre
// l'expiration de STORYBOARD_TTL_MS, ce résultat étant maintenant hébergé
// séparément via lib/media/imageLinkStore.js.
function clearStoryboard(id) {
  jobs.delete(id);
}

module.exports = {
  startStoryboard,
  getStoryboardStatus,
  clearStoryboard,
};
