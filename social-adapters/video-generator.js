// VIDEO GENERATOR — GENERATE_VIDEO pour la couche intelligence (VPS)
// -----------------------------------------------------------------------------
// Réutilise lib/media/videoAiEngine.js (cascade Fal.ai -> Replicate ->
// Hugging Face, chaque fournisseur facultatif selon les clés du .env) au lieu
// de dupliquer un appel : startVideoAiJob() soumet le job asynchrone et
// pollVideoAiJob() le suit jusqu'à { done: true }.
//
// Repli honnête quand AUCUN fournisseur n'est configuré : { ok:false,
// kind:'not_configured' } — l'export client Ken Burns existant (dashboard /
// webapp, gratuit et déjà en production) reste le repli officiel de
// lib/media/videoAiEngine.js ; on renvoie la même convention pour que
// l'Automation Engine ne marque pas l'action "réussie" à tort. Jamais de
// simulation d'un appel à une API vidéo qui n'existe pas.
//
// Signature exposée (compatible action GENERATE_VIDEO du registre) :
//   generateVideo(payload) ->
//     { ok:true,  result:{ job, provider, polling: true } }   // soumission ok
//     { ok:false, error, kind:'not_configured'|'generation_failed' }
//
// L'exécution d'un job doit être reprise par l'appelant (le polling ne doit
// PAS bloquer une requête HTTP Render : scheduler/worker dédié).
'use strict';

let videoAi = null;
try { videoAi = require('../lib/media/videoAiEngine.js'); } catch (e) { videoAi = null; }

async function generateVideo(payload) {
  const p = payload || {};
  if (!videoAi) {
    return { ok: false, error: 'VIDEO_AI_ENGINE_MISSING (lib/media/videoAiEngine.js injoignable)', kind: 'not_configured' };
  }
  const imageUrl = p.imageUrl || p.image || null;
  if (!imageUrl) return { ok: false, error: 'IMAGE_REQUIRED (payload.imageUrl renvoyé par l\'étape d\'image précédente)', kind: 'bad_request' };

  const prompt = p.prompt || null;
  const seed = p.seed || null;
  const preferred = p.provider || (p.hfMode ? 'ltx2' : null);
  try {
    const job = await videoAi.startVideoAiJob(imageUrl, prompt, seed, preferred);
    return { ok: true, result: { job, provider: job.provider, polling: true, note: 'Job soumis — à suivre via pollVideoJob()' } };
  } catch (e) {
    const kind = (e && e.kind === 'not_configured') ? 'not_configured' : 'generation_failed';
    return { ok: false, error: String((e && e.message) || e), kind };
  }
}

// Suivi d'un job (à appeler par le worker/scheduler, jamais dans une requête HTTP).
async function pollVideoJob(job, maxPolls) {
  if (!videoAi) return { ok: false, error: 'VIDEO_AI_ENGINE_MISSING' };
  const remaining = (typeof maxPolls === 'number') ? maxPolls : 8;
  for (let i = 0; i < remaining; i++) {
    const r = await videoAi.pollVideoAiJob(job);
    if (r && r.done) return { ok: true, result: r };
    await new Promise((resolve) => setTimeout(resolve, (r && r.sleepMs) || 4000));
  }
  return { ok: false, error: 'POLL_TIMEOUT', result: { done: false } };
}

function isConfigured() {
  if (!videoAi || typeof videoAi.isConfigured !== 'function') return { fal: false, replicate: false, huggingface: false };
  return videoAi.isConfigured();
}

module.exports = { generateVideo, pollVideoJob, isConfigured };