// Worker Cloudflare — vérification et génération de licences CYRUS (D1).
// Même contrat HTTP que firebase-functions (verify/create/list/update/set-active/delete).

import { runTextCascade } from './textCascade.js';
import { ADMIN_PAGE } from './adminPage.js';
import { generateImage, startVideo, pollVideo } from './media.js';

const ALL_MODULES = ['whatsapp', 'telegram', 'studio_video'];
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'content-type, x-admin-secret, x-license-key, x-device-id',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json', ...CORS } });
const normKey = (k) => String(k == null ? '' : k).trim().toUpperCase();
const now = () => new Date().toISOString();

function normalizeModules(m) {
  if (!Array.isArray(m)) return ALL_MODULES.slice();
  return m.filter((x) => ALL_MODULES.includes(x));
}

function generateKey() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  return `KEY-${hex}-${new Date().getFullYear()}`;
}

function timingSafeEqual(a, b) {
  const A = new TextEncoder().encode(String(a));
  const B = new TextEncoder().encode(String(b));
  let diff = A.length ^ B.length;
  const len = Math.max(A.length, B.length);
  for (let i = 0; i < len; i += 1) diff |= (A[i] || 0) ^ (B[i] || 0);
  return diff === 0;
}

function isAdmin(request, env) {
  const provided = request.headers.get('x-admin-secret');
  return !!(env.ADMIN_SECRET && provided && timingSafeEqual(provided, env.ADMIN_SECRET));
}

const KNOWN = new Set(['key', 'active', 'createdAt', 'expiresAt', 'note', 'allowedModules', 'boundDeviceId', 'boundAt', 'updatedAt']);

function rowToLicense(r) {
  let extra = {};
  try { extra = JSON.parse(r.extra || '{}'); } catch (e) { extra = {}; }
  let modules = [];
  try { modules = JSON.parse(r.allowed_modules || '[]'); } catch (e) { modules = []; }
  return {
    ...extra,
    key: r.key, active: !!r.active, createdAt: r.created_at, expiresAt: r.expires_at || null,
    note: r.note || '', allowedModules: modules, boundDeviceId: r.bound_device_id || null,
    boundAt: r.bound_at || null, updatedAt: r.updated_at,
  };
}

function licenseToParams(l, ts) {
  const extra = {};
  for (const [k, v] of Object.entries(l)) if (!KNOWN.has(k)) extra[k] = v;
  return [
    normKey(l.key), l.active === false ? 0 : 1, l.createdAt || ts, l.expiresAt || null, l.note || '',
    JSON.stringify(normalizeModules(l.allowedModules)), l.boundDeviceId || null, l.boundAt || null,
    JSON.stringify(extra), ts,
  ];
}

const UPSERT = `INSERT INTO licenses (key, active, created_at, expires_at, note, allowed_modules, bound_device_id, bound_at, extra, updated_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT(key) DO UPDATE SET active = excluded.active, expires_at = excluded.expires_at, note = excluded.note,
  allowed_modules = excluded.allowed_modules, extra = excluded.extra, updated_at = excluded.updated_at,
  bound_device_id = COALESCE(excluded.bound_device_id, licenses.bound_device_id),
  bound_at = COALESCE(excluded.bound_at, licenses.bound_at)`;

async function getLicense(env, key) {
  return env.DB.prepare('SELECT * FROM licenses WHERE key = ?').bind(key).first();
}

async function verify(request, env) {
  const { key, deviceId } = await request.json().catch(() => ({}));
  if (!key) return json({ valid: false, reason: 'MISSING_KEY' }, 400);
  if (!deviceId) return json({ valid: false, reason: 'MISSING_DEVICE_ID' }, 400);
  const k = normKey(key);
  let row = await getLicense(env, k);
  if (!row) return json({ valid: false, reason: 'NOT_FOUND' }, 404);
  if (!row.active) return json({ valid: false, reason: 'INACTIVE' }, 403);
  if (row.expires_at && new Date(row.expires_at).getTime() < Date.now()) return json({ valid: false, reason: 'EXPIRED' }, 403);

  if (!row.bound_device_id) {
    // liaison atomique : seul le premier appareil gagne
    const ts = now();
    await env.DB.prepare('UPDATE licenses SET bound_device_id = ?, bound_at = ?, updated_at = ? WHERE key = ? AND bound_device_id IS NULL').bind(deviceId, ts, ts, k).run();
    row = await getLicense(env, k);
  }
  if (row.bound_device_id !== deviceId) return json({ valid: false, reason: 'DEVICE_MISMATCH' }, 403);
  return json({ valid: true, degraded: true, expiresAt: row.expires_at || null, allowedModules: JSON.parse(row.allowed_modules || '[]') });
}

async function admin(action, request, env) {
  const body = request.method === 'POST' ? await request.json().catch(() => ({})) : {};
  const ts = now();

  if (action === 'create') {
    const license = { key: generateKey(), createdAt: ts, expiresAt: body.expiresAt || null, active: true, note: body.note || '', allowedModules: normalizeModules(body.allowedModules), boundDeviceId: null, boundAt: null };
    await env.DB.prepare(UPSERT).bind(...licenseToParams(license, ts)).run();
    return json({ ...license, updatedAt: ts }, 201);
  }
  if (action === 'list') {
    const { results } = await env.DB.prepare('SELECT * FROM licenses ORDER BY created_at DESC').all();
    return json(results.map(rowToLicense));
  }
  const k = normKey(body.key);
  if (['update', 'set-active', 'delete', 'unbind'].includes(action)) {
    if (!k) return json({ error: 'Clé manquante.' }, 400);
    const row = await getLicense(env, k);
    if (!row) return json({ error: 'Licence introuvable.' }, 404);
    if (action === 'delete') { await env.DB.prepare('DELETE FROM licenses WHERE key = ?').bind(k).run(); return json({ ok: true }); }
    if (action === 'set-active') { await env.DB.prepare('UPDATE licenses SET active = ?, updated_at = ? WHERE key = ?').bind(body.active ? 1 : 0, ts, k).run(); }
    else if (action === 'unbind') { await env.DB.prepare('UPDATE licenses SET bound_device_id = NULL, bound_at = NULL, updated_at = ? WHERE key = ?').bind(ts, k).run(); }
    else {
      if (body.allowedModules === undefined && body.expiresAt === undefined) return json({ error: 'Rien à mettre à jour (allowedModules et/ou expiresAt requis).' }, 400);
      const mods = body.allowedModules !== undefined ? JSON.stringify(normalizeModules(body.allowedModules)) : row.allowed_modules;
      const exp = body.expiresAt !== undefined ? (body.expiresAt || null) : row.expires_at;
      await env.DB.prepare('UPDATE licenses SET allowed_modules = ?, expires_at = ?, updated_at = ? WHERE key = ?').bind(mods, exp, ts, k).run();
    }
    return json(rowToLicense(await getLicense(env, k)));
  }
  if (action === 'sync') {
    const upserts = Array.isArray(body.upserts) ? body.upserts.filter((l) => l && l.key) : [];
    const deletes = Array.isArray(body.deletes) ? body.deletes.map(normKey).filter(Boolean) : [];
    const stmts = upserts.map((l) => env.DB.prepare(UPSERT).bind(...licenseToParams(l, ts)))
      .concat(deletes.map((d) => env.DB.prepare('DELETE FROM licenses WHERE key = ?').bind(d)));
    if (stmts.length) await env.DB.batch(stmts);
    return json({ ok: true, upserted: upserts.length, deleted: deletes.length, updatedAt: ts });
  }
  return json({ error: 'Route inconnue.' }, 404);
}

// Authentification par licence des passerelles IA : clé active, non expirée, appareil lié ou encore non lié (aucune écriture D1).
async function licenseAuth(request, env) {
  const key = normKey(request.headers.get('x-license-key'));
  const deviceId = request.headers.get('x-device-id');
  if (!key || !deviceId) return json({ error: 'Licence manquante.' }, 401);
  const row = await getLicense(env, key);
  if (!row || !row.active || (row.expires_at && new Date(row.expires_at).getTime() < Date.now())) return json({ error: 'Licence invalide.' }, 401);
  if (row.bound_device_id && row.bound_device_id !== deviceId) return json({ error: 'Appareil non autorisé.' }, 401);
  return null;
}

async function aiText(request, env) {
  const denied = await licenseAuth(request, env);
  if (denied) return denied;
  const { prompt } = await request.json().catch(() => ({}));
  if (!prompt || !String(prompt).trim()) return json({ error: 'Prompt manquant.' }, 400);
  try { return json(await runTextCascade(String(prompt).slice(0, 12000), env, env.FETCH)); }
  catch (err) { return json({ error: 'Échec de la génération de texte IA (tous les fournisseurs ont échoué).' }, 502); }
}

async function aiImage(request, env) {
  const denied = await licenseAuth(request, env);
  if (denied) return denied;
  const { prompt } = await request.json().catch(() => ({}));
  if (!prompt || !String(prompt).trim()) return json({ error: 'Prompt manquant.' }, 400);
  try { return json(await generateImage(String(prompt).slice(0, 2000), env, env.FETCH)); }
  catch (err) { return json({ error: 'Échec de la génération image IA (tous les fournisseurs ont échoué).' }, 502); }
}

async function videoStart(request, env) {
  const denied = await licenseAuth(request, env);
  if (denied) return denied;
  const { imageUrl, prompt, seed } = await request.json().catch(() => ({}));
  if (!imageUrl) return json({ error: 'imageUrl manquant.' }, 400);
  try {
    const job = await startVideo(imageUrl, prompt, Number.isFinite(seed) ? seed : undefined, env, env.FETCH);
    const jobId = crypto.randomUUID();
    await env.DB.prepare('INSERT INTO video_jobs (id, job, created_at) VALUES (?, ?, ?)').bind(jobId, JSON.stringify(job), Date.now()).run();
    await env.DB.prepare('DELETE FROM video_jobs WHERE created_at < ?').bind(Date.now() - 24 * 3600 * 1000).run();
    return json({ jobId, provider: `${job.provider} (Cloudflare)` });
  } catch (err) { return json({ error: err.message }, err.kind === 'not_configured' ? 501 : 502); }
}

async function videoPoll(request, env) {
  const denied = await licenseAuth(request, env);
  if (denied) return denied;
  const { jobId } = await request.json().catch(() => ({}));
  if (!jobId) return json({ error: 'jobId manquant.' }, 400);
  const row = await env.DB.prepare('SELECT * FROM video_jobs WHERE id = ?').bind(jobId).first();
  if (!row) return json({ error: 'Job vidéo introuvable (expiré ou déjà terminé).' }, 404);
  const job = JSON.parse(row.job);
  try {
    const r = await pollVideo(job, env, env.FETCH);
    if (!r.done) return json({ done: false });
    await env.DB.prepare('DELETE FROM video_jobs WHERE id = ?').bind(jobId).run();
    return json({ done: true, url: r.videoUrl, provider: `${job.provider} (Cloudflare)` });
  } catch (err) {
    await env.DB.prepare('DELETE FROM video_jobs WHERE id = ?').bind(jobId).run();
    return json({ error: err.message }, 502);
  }
}

// ---- Mise à jour du client PC (métadonnées seulement ; le binaire est hébergé ailleurs) ----
async function checkUpdate(env) {
  const row = await env.DB.prepare("SELECT value FROM app_config WHERE key = 'local-client'").first();
  const d = row ? JSON.parse(row.value) : {};
  return json({ latestVersion: d.latestVersion || '0.0.0', downloadUrl: d.downloadUrl || '', notes: d.notes || '', sha256: d.sha256 || '' });
}

async function publishUpdate(request, env) {
  const { version, downloadUrl, notes, sha256 } = await request.json().catch(() => ({}));
  if (!version || !downloadUrl) return json({ error: 'version et downloadUrl requis (URL HTTPS du binaire déjà hébergé).' }, 400);
  if (!/^https:\/\//.test(String(downloadUrl))) return json({ error: 'downloadUrl doit être une URL https.' }, 400);
  const value = JSON.stringify({ latestVersion: String(version), downloadUrl: String(downloadUrl), notes: notes || '', sha256: sha256 || '', publishedAt: now() });
  await env.DB.prepare("INSERT INTO app_config (key, value) VALUES ('local-client', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(value).run();
  return json({ ok: true, latestVersion: String(version) });
}

// ---- Élèves / accès (portage de grantAccessOnPurchase et grantModuleAccess) ----
const ACCESS_KEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
function generateAccessKey() {
  const groups = [];
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  for (let g = 0; g < 6; g += 1) {
    let part = '';
    for (let i = 0; i < 4; i += 1) part += ACCESS_KEY_CHARS[bytes[g * 4 + i] % ACCESS_KEY_CHARS.length];
    groups.push(part);
  }
  return groups.join('-');
}

async function grantAccessOnPurchase(request, env) {
  const { student, purchase, tenantId, accessKey } = await request.json().catch(() => ({}));
  if (!student || !purchase) return json({ error: 'student et purchase requis.' }, 400);
  const ts = now();
  const studentId = `cyrus_st_${Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('')}`;
  const generated = !accessKey || accessKey.generate !== false ? generateAccessKey() : null;
  const stmts = [env.DB.prepare('INSERT INTO cyrus_students (id, full_name, email, phone, sku, amount, currency, transaction_id, paid_at, tenant_id, access_key, modules, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(studentId, student.fullName || null, student.email || null, student.phone || null, purchase.sku || null, purchase.amount || null, purchase.currency || 'FCFA', purchase.transactionId || null, purchase.paidAt || ts, tenantId || 'default', generated, '[]', ts)];
  if (generated) stmts.push(env.DB.prepare('INSERT INTO cyrus_access_keys (access_key, student_id, sku, issued_at) VALUES (?, ?, ?, ?)').bind(generated, studentId, purchase.sku || null, ts));
  await env.DB.batch(stmts);
  return json({ studentId, accessKey: generated, status: 'CREATED' }, 201);
}

async function grantModuleAccess(request, env) {
  const { student, module: mod } = await request.json().catch(() => ({}));
  if (!mod || !mod.key) return json({ error: 'module.key requis.' }, 400);
  if (!student || (!student.id && !student.phone && !student.email)) return json({ error: 'student.id, student.phone ou student.email requis.' }, 400);
  let row = null;
  if (student.id) row = await env.DB.prepare('SELECT * FROM cyrus_students WHERE id = ?').bind(student.id).first();
  else if (student.phone) row = await env.DB.prepare('SELECT * FROM cyrus_students WHERE phone = ? LIMIT 1').bind(student.phone).first();
  else row = await env.DB.prepare('SELECT * FROM cyrus_students WHERE email = ? LIMIT 1').bind(student.email).first();
  if (!row) return json({ error: 'Étudiant introuvable.' }, 404);
  const modules = JSON.parse(row.modules || '[]');
  if (!modules.includes(mod.key)) modules.push(mod.key);
  await env.DB.prepare('UPDATE cyrus_students SET modules = ? WHERE id = ?').bind(JSON.stringify(modules), row.id).run();
  return json({ status: 'GRANTED', moduleKey: mod.key });
}

const PUBLIC = { '/verify': 'verify', '/verifyLicenseOffline': 'verify' };
const AI_ROUTES = {
  '/ai/text': aiText, '/generateTextFallback': aiText,
  '/ai/image': aiImage, '/generateImageFallback': aiImage,
  '/ai/video/start': videoStart, '/startVideoFallback': videoStart,
  '/ai/video/poll': videoPoll, '/pollVideoFallback': videoPoll,
};
const ADMIN_POST = { '/publishUpdateOffline': publishUpdate, '/grantAccessOnPurchase': grantAccessOnPurchase, '/grantModuleAccess': grantModuleAccess };
const ADMIN_ROUTES = {
  '/admin/create': 'create', '/createLicenseOffline': 'create',
  '/admin/list': 'list', '/listLicensesOffline': 'list',
  '/admin/update': 'update', '/updateLicenseOffline': 'update',
  '/admin/set-active': 'set-active', '/setLicenseActiveOffline': 'set-active',
  '/admin/delete': 'delete', '/deleteLicenseOffline': 'delete',
  '/admin/unbind': 'unbind', '/admin/sync': 'sync',
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (url.pathname === '/health') return json({ ok: true });
    if (PUBLIC[url.pathname]) return request.method === 'POST' ? verify(request, env) : json({ error: 'POST requis.' }, 405);
    if (AI_ROUTES[url.pathname]) return request.method === 'POST' ? AI_ROUTES[url.pathname](request, env) : json({ error: 'POST requis.' }, 405);
    if (url.pathname === '/checkUpdateOffline') return checkUpdate(env);
    if (url.pathname === '/generateEbookFallback') return json({ error: 'Génération d’ebook indisponible sur Cloudflare (moteur PDF non portable) : utilisez le VPS ou le client PC.' }, 501);
    if (ADMIN_POST[url.pathname]) {
      if (request.method !== 'POST') return json({ error: 'POST requis.' }, 405);
      if (!isAdmin(request, env)) return json({ error: 'Secret admin invalide.' }, 401);
      return ADMIN_POST[url.pathname](request, env);
    }
    if (ADMIN_ROUTES[url.pathname]) {
      if (!isAdmin(request, env)) return json({ error: 'Secret admin invalide.' }, 401);
      return admin(ADMIN_ROUTES[url.pathname], request, env);
    }
    if (url.pathname === '/' || url.pathname === '/index.html') return new Response(ADMIN_PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
    return json({ error: 'Introuvable.' }, 404);
  },
};

export { generateKey, normalizeModules, rowToLicense };
