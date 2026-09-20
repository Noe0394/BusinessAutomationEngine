// TEST — Worker de licences Cloudflare (D1 simulée par node:sqlite, SQL identique)
// et réplication VPS <-> Cloudflare.   node --test test/cloudflare-license.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

process.env.CLOUDFLARE_LICENSE_URL = 'https://worker.test';
process.env.CLOUDFLARE_ADMIN_SECRET = 'secret-test';

function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(__dirname, '..', 'cloudflare', 'license-worker', 'schema.sql'), 'utf8'));
  const clean = (a) => a.map((v) => (v === undefined ? null : v));
  const stmt = (sql, args) => ({
    first: async () => db.prepare(sql).get(...clean(args)) || null,
    all: async () => ({ results: db.prepare(sql).all(...clean(args)) }),
    run: async () => { db.prepare(sql).run(...clean(args)); return { success: true }; },
  });
  return {
    prepare: (sql) => Object.assign({ bind: (...args) => stmt(sql, args) }, stmt(sql, [])),
    batch: async (list) => { for (const s of list) await s.run(); return []; },
  };
}

let worker; let env; let writes; let ipSeq = 0;
const call = async (method, p, body, admin) => {
  const headers = { 'content-type': 'application/json', 'cf-connecting-ip': `ip-${++ipSeq}` };
  if (admin !== false) headers['x-admin-secret'] = admin || 'secret-test';
  const res = await worker.fetch(new Request(`https://worker.test${p}`, { method, headers, body: body ? JSON.stringify(body) : undefined }), env);
  return { status: res.status, body: await res.json() };
};

test('setup', async () => {
  worker = (await import('../cloudflare/license-worker/src/index.js')).default;
  env = { DB: makeD1(), ADMIN_SECRET: 'secret-test' };
});

test('génération : clé au format KEY-XXXXXXXX-AAAA, modules par défaut', async () => {
  const r = await call('POST', '/admin/create', { note: 'client A' });
  assert.equal(r.status, 201);
  assert.match(r.body.key, /^KEY-[0-9A-F]{8}-\d{4}$/);
  assert.deepEqual(r.body.allowedModules, ['whatsapp', 'telegram', 'studio_video']);
  assert.equal(r.body.active, true);
  env.key = r.body.key;
});

test('admin protégé : sans secret ou mauvais secret -> 401', async () => {
  assert.equal((await call('GET', '/admin/list', null, false)).status, 401);
  assert.equal((await call('GET', '/admin/list', null, 'faux')).status, 401);
  assert.equal((await call('POST', '/createLicenseOffline', {}, 'faux')).status, 401);
});

test('vérification : liaison au 1er appareil, refus du second', async () => {
  const ok = await call('POST', '/verify', { key: env.key.toLowerCase(), deviceId: 'dev-1' }, false);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.valid, true);
  const same = await call('POST', '/verifyLicenseOffline', { key: env.key, deviceId: 'dev-1' }, false);
  assert.equal(same.body.valid, true);
  const other = await call('POST', '/verify', { key: env.key, deviceId: 'dev-2' }, false);
  assert.equal(other.status, 403);
  assert.equal(other.body.reason, 'DEVICE_MISMATCH');
});

test('vérification : clé inconnue, paramètres manquants', async () => {
  assert.equal((await call('POST', '/verify', { key: 'KEY-00000000-2026', deviceId: 'd' }, false)).body.reason, 'NOT_FOUND');
  assert.equal((await call('POST', '/verify', { deviceId: 'd' }, false)).body.reason, 'MISSING_KEY');
  assert.equal((await call('POST', '/verify', { key: env.key }, false)).body.reason, 'MISSING_DEVICE_ID');
});

test('désactivation, expiration, réactivation, suppression', async () => {
  await call('POST', '/admin/set-active', { key: env.key, active: false });
  assert.equal((await call('POST', '/verify', { key: env.key, deviceId: 'dev-1' }, false)).body.reason, 'INACTIVE');
  await call('POST', '/admin/set-active', { key: env.key, active: true });
  await call('POST', '/admin/update', { key: env.key, expiresAt: '2020-01-01T00:00:00.000Z' });
  assert.equal((await call('POST', '/verify', { key: env.key, deviceId: 'dev-1' }, false)).body.reason, 'EXPIRED');
  await call('POST', '/admin/update', { key: env.key, expiresAt: null, allowedModules: ['whatsapp'] });
  const v = await call('POST', '/verify', { key: env.key, deviceId: 'dev-1' }, false);
  assert.deepEqual(v.body.allowedModules, ['whatsapp']);
  assert.equal((await call('POST', '/admin/update', { key: env.key })).status, 400);
  assert.equal((await call('POST', '/admin/delete', { key: env.key })).body.ok, true);
  assert.equal((await call('POST', '/verify', { key: env.key, deviceId: 'dev-1' }, false)).body.reason, 'NOT_FOUND');
});

test('réplication : ne pousse que les clés modifiées, conserve la liaison distante', async () => {
  const axios = require('axios');
  writes = [];
  axios.create = () => ({
    post: async (p, body) => { writes.push([p, body]); const r = await call('POST', p, body); return { data: r.body }; },
    get: async (p) => { const r = await call('GET', p); return { data: r.body }; },
  });
  const sync = require('../lib/cloudflareSync');
  assert.equal(sync.enabled, true);

  const licA = { key: 'KEY-AAAA0001-2026', createdAt: '2026-01-01T00:00:00.000Z', expiresAt: null, active: true, note: 'a', allowedModules: ['whatsapp'], boundDeviceId: null, boundAt: null };
  const licB = { key: 'KEY-BBBB0002-2026', createdAt: '2026-01-02T00:00:00.000Z', expiresAt: null, active: true, note: 'b', allowedModules: ['telegram'], boundDeviceId: null, boundAt: null, custom: 42 };
  let r = await sync.pushLicenses([licA, licB]);
  assert.equal(r.upserted, 2);
  r = await sync.pushLicenses([licA, licB]);
  assert.equal(r.upserted, 0, 'rien de modifié -> aucune écriture');
  assert.equal(writes.length, 1);

  await new Promise((r2) => setTimeout(r2, 5));
  await call('POST', '/verify', { key: licA.key, deviceId: 'phone-9' }, false); // liaison côté Cloudflare
  const merged = await sync.pullLicenses([licA, licB]);
  assert.ok(merged, 'la liaison distante revient au VPS');
  assert.equal(merged.find((l) => l.key === licA.key).boundDeviceId, 'phone-9');

  // désactivation faite sur la page admin Cloudflare -> adoptée localement
  await new Promise((r2) => setTimeout(r2, 5));
  await call('POST', '/admin/set-active', { key: licB.key, active: false });
  const merged2 = await sync.pullLicenses(merged);
  assert.equal(merged2.find((l) => l.key === licB.key).active, false);

  // un push complet ne doit pas effacer la liaison distante
  const stale = Object.assign({}, licA, { note: 'a2', boundDeviceId: null });
  await sync.pushLicenses([stale, licB]);
  const list = await call('GET', '/admin/list');
  assert.equal(list.body.find((l) => l.key === licA.key).boundDeviceId, 'phone-9');
  assert.equal(list.body.find((l) => l.key === licB.key).custom, 42, 'champs supplémentaires conservés');

  // suppression locale -> suppression distante
  await sync.pushLicenses([stale]);
  assert.equal((await call('GET', '/admin/list')).body.some((l) => l.key === licB.key), false);
});

test('passerelle IA /ai/text : licence requise, cascade avec repli, aucune clé côté client', async () => {
  const created = (await call('POST', '/admin/create', {})).body.key;
  const calls = [];
  const fakeFetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes('groq')) return { ok: false, status: 500, json: async () => ({}), text: async () => '' };
    if (String(url).includes('openrouter')) return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'réponse openrouter' } }] }), text: async () => '' };
    return { ok: true, status: 200, json: async () => ({}), text: async () => 'réponse pollinations' };
  };
  const ai = (headers, body, extraEnv) => worker.fetch(new Request('https://worker.test/ai/text', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }), Object.assign({}, env, { FETCH: fakeFetch }, extraEnv));

  assert.equal((await ai({}, { prompt: 'x' })).status, 401, 'sans licence');
  assert.equal((await ai({ 'x-license-key': 'KEY-00000000-2026', 'x-device-id': 'd' }, { prompt: 'x' })).status, 401, 'licence inconnue');
  const good = { 'x-license-key': created, 'x-device-id': 'dev-ai' };
  assert.equal((await ai(good, {})).status, 400, 'prompt manquant');

  let r = await ai(good, { prompt: 'Bonjour' }, { GROQ_API_KEY: 'g', OPENROUTER_API_KEY: 'o' });
  const body = await r.json();
  assert.equal(r.status, 200);
  assert.equal(body.text, 'réponse openrouter', 'groq en échec -> niveau suivant');
  assert.match(body.provider, /openrouter/);

  calls.length = 0;
  r = await ai(good, { prompt: 'Bonjour' }, {});
  assert.match((await r.json()).provider, /pollinations/, 'sans aucune clé : repli public');
  assert.ok(!calls.some((u) => u.includes('groq')), 'niveau sans clé sauté');
});

test('portage Firebase -> Cloudflare : élèves, accès, mise à jour, image, vidéo, alias et ebook', async () => {
  const lic = (await call('POST', '/admin/create', {})).body.key;
  const good = { 'x-license-key': lic, 'x-device-id': 'dev-media' };
  const post = (p, body, headers, extraEnv) => worker.fetch(new Request(`https://worker.test${p}`, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, headers || {}), body: JSON.stringify(body || {}) }), Object.assign({}, env, extraEnv || {}));

  // --- élèves / accès (admin uniquement) ---
  assert.equal((await post('/grantAccessOnPurchase', { student: {}, purchase: {} })).status, 401, 'sans secret admin');
  const admin = { 'x-admin-secret': 'secret-test' };
  const g = await post('/grantAccessOnPurchase', { student: { fullName: 'Awa', phone: '22670000001', email: 'a@x.io' }, purchase: { sku: 'FORM-1', amount: 8000, transactionId: 'T1' }, tenantId: 'tX' }, admin);
  assert.equal(g.status, 201);
  const gb = await g.json();
  assert.match(gb.studentId, /^cyrus_st_[0-9a-f]{12}$/);
  assert.match(gb.accessKey, /^([A-Za-z0-9]{4}-){5}[A-Za-z0-9]{4}$/);
  assert.equal((await post('/grantAccessOnPurchase', { student: { fullName: 'B' } }, admin)).status, 400);
  const mod = await post('/grantModuleAccess', { student: { phone: '22670000001' }, module: { key: 'atelier-2' } }, admin);
  assert.equal((await mod.json()).status, 'GRANTED');
  await post('/grantModuleAccess', { student: { id: gb.studentId }, module: { key: 'atelier-2' } }, admin);
  const row = await env.DB.prepare('SELECT * FROM cyrus_students WHERE id = ?').bind(gb.studentId).first();
  assert.deepEqual(JSON.parse(row.modules), ['atelier-2'], 'module ajouté une seule fois');
  assert.equal((await post('/grantModuleAccess', { student: { phone: '000' }, module: { key: 'x' } }, admin)).status, 404);
  assert.equal((await env.DB.prepare('SELECT * FROM cyrus_access_keys WHERE access_key = ?').bind(gb.accessKey).first()).student_id, gb.studentId);

  // --- mise à jour du client PC ---
  const empty = await (await worker.fetch(new Request('https://worker.test/checkUpdateOffline'), env)).json();
  assert.equal(empty.latestVersion, '0.0.0');
  assert.equal((await post('/publishUpdateOffline', { version: '1.2.0', downloadUrl: 'http://insecure' }, admin)).status, 400);
  assert.equal((await post('/publishUpdateOffline', { version: '1.2.0', downloadUrl: 'https://exemple.test/cyrus-1.2.0.exe', sha256: 'abc', notes: 'ok' }, admin)).status, 200);
  const upd = await (await worker.fetch(new Request('https://worker.test/checkUpdateOffline'), env)).json();
  assert.deepEqual([upd.latestVersion, upd.downloadUrl, upd.sha256], ['1.2.0', 'https://exemple.test/cyrus-1.2.0.exe', 'abc']);

  // --- image : licence requise, fal puis Pollinations ---
  const imgFetch = async (url) => {
    if (String(url).includes('fal.run')) return { ok: true, status: 200, json: async () => ({ images: [{ url: 'https://fal.cdn/img.jpg' }] }), headers: { get: () => 'application/json' } };
    return { ok: true, status: 200, headers: { get: () => 'image/jpeg' }, body: { cancel() {} } };
  };
  assert.equal((await post('/generateImageFallback', { prompt: 'x' })).status, 401);
  assert.equal((await post('/generateImageFallback', {}, good)).status, 400);
  const withFal = await (await post('/ai/image', { prompt: 'un chat' }, good, { FETCH: imgFetch, FAL_KEY: 'k' })).json();
  assert.deepEqual([withFal.url, withFal.provider], ['https://fal.cdn/img.jpg', 'fal (Cloudflare)']);
  const noKey = await (await post('/ai/image', { prompt: 'un chat' }, good, { FETCH: imgFetch })).json();
  assert.match(noKey.url, /^https:\/\/image\.pollinations\.ai\/prompt\//);
  const notImage = await post('/ai/image', { prompt: 'x' }, good, { FETCH: async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, body: { cancel() {} } }) });
  assert.equal(notImage.status, 502, 'réponse non-image = échec honnête');

  // --- vidéo : job persisté puis interrogé ---
  const vFetch = async (url) => {
    const u = String(url);
    if (u === 'https://queue.fal.run/s') return { ok: true, status: 200, json: async () => ({ status: state.status }) };
    if (u === 'https://queue.fal.run/r') return { ok: true, status: 200, json: async () => ({ video: { url: 'https://fal.cdn/v.mp4' } }) };
    if (u.includes('queue.fal.run')) return { ok: true, status: 200, json: async () => ({ status_url: 'https://queue.fal.run/s', response_url: 'https://queue.fal.run/r' }) };
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const state = { status: 'IN_PROGRESS' };
  const noProvider = await post('/startVideoFallback', { imageUrl: 'https://i/x.jpg' }, good, { FETCH: vFetch });
  assert.equal(noProvider.status, 501, 'aucun fournisseur : erreur explicite');
  const started = await (await post('/ai/video/start', { imageUrl: 'https://i/x.jpg', seed: 3 }, good, { FETCH: vFetch, FAL_KEY: 'k' })).json();
  assert.ok(started.jobId);
  assert.equal((await (await post('/pollVideoFallback', { jobId: started.jobId }, good, { FETCH: vFetch, FAL_KEY: 'k' })).json()).done, false);
  state.status = 'COMPLETED';
  const done = await (await post('/ai/video/poll', { jobId: started.jobId }, good, { FETCH: vFetch, FAL_KEY: 'k' })).json();
  assert.deepEqual([done.done, done.url], [true, 'https://fal.cdn/v.mp4']);
  assert.equal((await post('/ai/video/poll', { jobId: started.jobId }, good, { FETCH: vFetch, FAL_KEY: 'k' })).status, 404, 'job consommé');

  // --- ebook : non porté, dit clairement ---
  const eb = await post('/generateEbookFallback', {}, good);
  assert.equal(eb.status, 501);
  assert.match((await eb.json()).error, /indisponible/);
});

test('Workers AI : image et texte sans aucune clé externe (fournisseurs tiers hors service)', async () => {
  const lic = (await call('POST', '/admin/create', {})).body.key;
  const good = { 'x-license-key': lic, 'x-device-id': 'dev-wai' };
  const AI = { calls: [], run: async (model, input) => { AI.calls.push(model); return model.includes('flux') ? { image: 'QUJD' } : { response: 'Bonjour depuis Workers AI' }; } };
  const post = (p, body, extraEnv) => worker.fetch(new Request(`https://worker.test${p}`, { method: 'POST', headers: Object.assign({ 'content-type': 'application/json' }, good), body: JSON.stringify(body) }), Object.assign({}, env, extraEnv));
  const failing = async () => ({ ok: false, status: 402, json: async () => ({}), text: async () => '', headers: { get: () => '' } });

  const img = await (await post('/generateImageFallback', { prompt: 'pomme' }, { AI, FETCH: failing, FAL_KEY: 'k' })).json();
  assert.equal(img.url, 'data:image/jpeg;base64,QUJD');
  assert.match(img.provider, /workers-ai/);

  const txt = await (await post('/generateTextFallback', { prompt: 'salut' }, { AI, FETCH: failing, GROQ_API_KEY: 'g' })).json();
  assert.equal(txt.text, 'Bonjour depuis Workers AI');
  assert.match(txt.provider, /workers-ai/);
  assert.ok(AI.calls.some((m) => m.includes('llama')));
});

test('démarrage du VPS : les licences locales sont poussées vers Cloudflare sans écraser une liaison distante', async () => {
  const sync = require('../lib/cloudflareSync');
  const local = [{ key: 'KEY-CCCC0003-2026', createdAt: '2026-02-01T00:00:00.000Z', expiresAt: null, active: true, note: 'vps', allowedModules: ['whatsapp'], boundDeviceId: null, boundAt: null }];
  await call('POST', '/admin/sync', { upserts: [Object.assign({}, local[0], { boundDeviceId: 'phone-cf', boundAt: '2026-02-02T00:00:00.000Z' })], deletes: [] });
  let saved = null;
  sync.startPull(() => local, (l) => { saved = l; }, 3600000);
  await new Promise((r) => setTimeout(r, 400));
  const list = (await call('GET', '/admin/list')).body;
  const row = list.find((l) => l.key === 'KEY-CCCC0003-2026');
  assert.ok(row, 'licence du VPS présente sur Cloudflare');
  assert.equal(row.note, 'vps');
  assert.equal(row.boundDeviceId, 'phone-cf', 'liaison faite côté Cloudflare conservée');
  assert.ok(saved && saved.find((l) => l.key === 'KEY-CCCC0003-2026').boundDeviceId === 'phone-cf', 'et remontée au VPS');
});

test('anti-force-brute : 5 secrets erronés = blocage 429 même avec le bon secret ; une autre adresse reste servie', async () => {
  const hit = (secret, ip) => worker.fetch(new Request('https://worker.test/admin/list', { headers: { 'x-admin-secret': secret, 'cf-connecting-ip': ip } }), env);
  for (let i = 0; i < 5; i += 1) assert.equal((await hit('mauvais' + i, '9.9.9.9')).status, 401);
  assert.equal((await hit('mauvais', '9.9.9.9')).status, 429, 'bloqué');
  assert.equal((await hit('secret-test', '9.9.9.9')).status, 429, 'le bon secret ne passe pas pendant le blocage');
  assert.equal((await hit('secret-test', '8.8.8.8')).status, 200, 'autre adresse non affectée');
  // succès efface l'historique d'échecs
  await hit('faux', '7.7.7.7'); await hit('faux', '7.7.7.7');
  assert.equal((await hit('secret-test', '7.7.7.7')).status, 200);
  const row = await env.DB.prepare('SELECT * FROM admin_attempts WHERE ip = ?').bind('7.7.7.7').first();
  assert.equal(row, null);
});
