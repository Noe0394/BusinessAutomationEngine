// Passerelles image / vidéo du Worker (portage de firebase-functions generateImageFallback / start|pollVideoFallback).
// Les fichiers ne sont pas rapatriés (pas de stockage objet activé) : les URL des fournisseurs sont renvoyées telles quelles.

const FAL_IMAGE_URL = 'https://fal.run/fal-ai/flux/schnell';
const DEFAULT_MOTION_PROMPT = 'smooth cinematic camera motion, subtle parallax and depth, natural movement, high quality, no distortion';
const TIMEOUT_MS = 30000;

async function call(fetchFn, url, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetchFn(url, Object.assign({ signal: ctrl.signal }, init));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally { clearTimeout(t); }
}

export async function generateImage(prompt, env, fetchFn) {
  const f = fetchFn || fetch;
  if (env.FAL_KEY) {
    try {
      const res = await call(f, FAL_IMAGE_URL, { method: 'POST', headers: { Authorization: `Key ${env.FAL_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ prompt, num_images: 1, output_format: 'jpeg' }) });
      const data = await res.json();
      const url = data && data.images && data.images[0] && data.images[0].url;
      if (url) return { url, provider: 'fal (Cloudflare)' };
    } catch (e) { /* repli Pollinations */ }
  }
  // Workers AI (binding « AI », quota gratuit quotidien) : FLUX schnell, image renvoyée en base64 (data URL, aucun stockage requis).
  if (env.AI && typeof env.AI.run === 'function') {
    try {
      const out = await env.AI.run('@cf/black-forest-labs/flux-1-schnell', { prompt, steps: 4 });
      const b64 = out && (out.image || (typeof out === 'string' ? out : null));
      if (b64) return { url: `data:image/jpeg;base64,${b64}`, provider: 'workers-ai flux (Cloudflare)' };
    } catch (e) { /* repli Pollinations */ }
  }
  const seed = Math.floor(Math.random() * 1000000);
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=1024&height=1024&nologo=true&seed=${seed}&enhance=true&safe=true`;
  const res = await call(f, url, { method: 'GET' });
  const type = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
  if (res.body && res.body.cancel) res.body.cancel();
  if (!String(type).startsWith('image/')) throw new Error('Pollinations a renvoyé une réponse non-image (service saturé).');
  return { url, provider: 'pollinations (Cloudflare)' };
}

export async function startVideo(imageUrl, prompt, seed, env, fetchFn) {
  const f = fetchFn || fetch;
  const motion = prompt || DEFAULT_MOTION_PROMPT;
  if (env.FAL_KEY) {
    try {
      const input = { image_url: imageUrl, prompt: motion };
      if (Number.isFinite(seed)) input.seed = seed;
      const res = await call(f, `https://queue.fal.run/${env.FAL_LTX_MODEL_ID || 'fal-ai/ltx-video-13b-distilled/image-to-video'}`, { method: 'POST', headers: { Authorization: `Key ${env.FAL_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify(input) });
      const d = await res.json();
      if (d.status_url && d.response_url) return { provider: 'fal', statusUrl: d.status_url, responseUrl: d.response_url };
    } catch (e) { /* repli Replicate */ }
  }
  if (env.REPLICATE_API_TOKEN) {
    try {
      const auth = { Authorization: `Bearer ${env.REPLICATE_API_TOKEN}` };
      const model = env.REPLICATE_LTX_MODEL || 'lightricks/ltx-video';
      const m = await (await call(f, `https://api.replicate.com/v1/models/${model}`, { headers: auth })).json();
      const version = m && m.latest_version && m.latest_version.id;
      if (version) {
        const input = { image: imageUrl, prompt: motion };
        if (Number.isFinite(seed)) input.seed = seed;
        const p = await (await call(f, 'https://api.replicate.com/v1/predictions', { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, auth), body: JSON.stringify({ version, input }) })).json();
        if (p && p.urls && p.urls.get) return { provider: 'replicate', getUrl: p.urls.get };
      }
    } catch (e) { /* aucun fournisseur disponible */ }
  }
  const err = new Error('Aucun fournisseur vidéo IA disponible (FAL_KEY ou REPLICATE_API_TOKEN absent ou en échec). Hugging Face n\'est pas porté sur Cloudflare.');
  err.kind = 'not_configured';
  throw err;
}

export async function pollVideo(job, env, fetchFn) {
  const f = fetchFn || fetch;
  if (job.provider === 'fal') {
    const headers = { Authorization: `Key ${env.FAL_KEY}` };
    const st = await (await call(f, job.statusUrl, { headers })).json();
    if (st.status === 'COMPLETED') {
      const r = await (await call(f, job.responseUrl, { headers })).json();
      const url = r && r.video && r.video.url;
      if (!url) throw new Error('fal.ai a terminé le job mais aucune URL vidéo n\'a été trouvée.');
      return { done: true, videoUrl: url };
    }
    if (st.status === 'IN_QUEUE' || st.status === 'IN_PROGRESS') return { done: false };
    throw new Error(`fal.ai a échoué : ${st.error || st.status || 'statut inconnu'}`);
  }
  if (job.provider === 'replicate') {
    const p = await (await call(f, job.getUrl, { headers: { Authorization: `Bearer ${env.REPLICATE_API_TOKEN}` } })).json();
    if (p.status === 'succeeded') {
      const url = Array.isArray(p.output) ? p.output[0] : p.output;
      if (!url) throw new Error('Replicate a terminé le job mais aucune URL vidéo n\'a été trouvée.');
      return { done: true, videoUrl: url };
    }
    if (p.status === 'starting' || p.status === 'processing') return { done: false };
    throw new Error(`Replicate a échoué : ${p.error || p.status || 'statut inconnu'}`);
  }
  throw new Error(`Fournisseur vidéo inconnu : ${job.provider}`);
}
