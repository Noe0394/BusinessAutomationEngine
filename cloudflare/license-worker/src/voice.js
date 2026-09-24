const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type, x-license-key, x-device-id', 'Access-Control-Allow-Methods': 'POST, OPTIONS' } });

function decodeBase64(value) {
  const raw = atob(value);
  const bytes = new Uint8Array(raw.length);
  for (let index = 0; index < raw.length; index += 1) bytes[index] = raw.charCodeAt(index);
  return bytes;
}

export async function transcribeAudio(request, env) {
  const key = String(request.headers.get('x-license-key') || '').trim().toUpperCase();
  const deviceId = String(request.headers.get('x-device-id') || '').trim();
  if (!key || !deviceId) return json({ error: 'Licence et appareil requis.' }, 401);
  const license = await env.DB.prepare('SELECT active, expires_at, bound_device_id FROM licenses WHERE key = ?').bind(key).first();
  if (!license || !license.active || (license.expires_at && new Date(license.expires_at).getTime() < Date.now())) return json({ error: 'Licence invalide ou expiree.' }, 401);
  if (!license.bound_device_id || license.bound_device_id !== deviceId) return json({ error: 'La licence doit etre liee a cet appareil.' }, 403);
  if (!env.GROQ_API_KEY) return json({ error: 'Transcription indisponible : le Worker ne contient pas GROQ_API_KEY.' }, 501);
  const declared = Number(request.headers.get('content-length') || 0);
  if (declared > 16 * 1024 * 1024) return json({ error: 'Choisis un audio de 10 Mo maximum.' }, 413);
  const body = await request.json().catch(() => ({}));
  const encoded = String(body.base64 || '');
  const mimeType = String(body.mimeType || 'audio/ogg').toLowerCase();
  if (!encoded || encoded.length > 14 * 1024 * 1024) return json({ error: 'Fichier audio absent ou trop volumineux.' }, 413);
  if (!/^audio\/(ogg|webm|mpeg|mp4|wav|aac|flac|x-m4a)$/i.test(mimeType)) return json({ error: 'Format audio non pris en charge.' }, 415);
  let bytes;
  try { bytes = decodeBase64(encoded); } catch { return json({ error: 'Audio base64 invalide.' }, 400); }
  if (!bytes.length || bytes.length > 10 * 1024 * 1024) return json({ error: 'Choisis un audio de 10 Mo maximum.' }, 413);

  const filename = String(body.filename || 'voice-note.ogg').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 100) || 'voice-note.ogg';
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: mimeType }), filename);
  form.append('model', String(env.GROQ_WHISPER_MODEL || 'whisper-large-v3'));
  form.append('response_format', 'verbose_json');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST', headers: { authorization: `Bearer ${env.GROQ_API_KEY}` }, body: form, signal: controller.signal,
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) return json({ error: `Le fournisseur vocal a repondu HTTP ${response.status}.` }, 502);
    const text = String(result.text || '').trim();
    if (!text) return json({ error: 'Aucune parole exploitable detectee.' }, 422);
    return json({ text, language: result.language || null, provider: 'Groq Whisper via Cloudflare' });
  } catch (error) {
    return json({ error: error.name === 'AbortError' ? 'La transcription a depasse 30 secondes.' : 'Le fournisseur vocal est injoignable.' }, 502);
  } finally { clearTimeout(timeout); }
}
