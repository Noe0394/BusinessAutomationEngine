// Déploie le Worker de licences par l'API REST Cloudflare (aucun téléchargement de wrangler).
// Idempotent : réutilise la base D1 et le Worker s'ils existent.
//   node scripts/cloudflare-deploy.js            -> déploie
//   node scripts/cloudflare-deploy.js --seed KEY -> copie une licence du licenses.json local vers D1
// Lit CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN (+ clés IA facultatives) dans .env ; ne les affiche jamais.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const ROOT = path.join(__dirname, '..');
const W = path.join(ROOT, 'cloudflare', 'license-worker');
const ENV_PATH = path.join(ROOT, '.env');
require('dotenv').config({ path: ENV_PATH });

const ACCOUNT = process.env.CLOUDFLARE_ACCOUNT_ID;
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;
const NAME = 'cyrus-license';
const DB_NAME = 'cyrus-licenses';
const AI_KEYS = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'HUGGINGFACE_API_KEY'];

if (!ACCOUNT || !TOKEN) { console.error('CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN manquants dans .env'); process.exit(1); }

const api = axios.create({ baseURL: `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}`, headers: { Authorization: `Bearer ${TOKEN}` }, timeout: 60000 });
const fail = (step, err) => { console.error(`❌ ${step} : ${err.response ? JSON.stringify(err.response.data.errors || err.response.data) : err.message}`); process.exit(1); };

function ensureAdminSecret() {
  if (process.env.CLOUDFLARE_ADMIN_SECRET) return process.env.CLOUDFLARE_ADMIN_SECRET;
  const secret = crypto.randomBytes(32).toString('base64url');
  fs.appendFileSync(ENV_PATH, `\nCLOUDFLARE_ADMIN_SECRET=${secret}\n`);
  process.env.CLOUDFLARE_ADMIN_SECRET = secret;
  console.log('🔐 Secret admin généré et enregistré dans .env (CLOUDFLARE_ADMIN_SECRET).');
  return secret;
}

async function ensureDatabase() {
  const list = (await api.get('/d1/database', { params: { name: DB_NAME } })).data.result || [];
  let db = list.find((d) => d.name === DB_NAME);
  if (!db) { db = (await api.post('/d1/database', { name: DB_NAME })).data.result; console.log('🗄️  Base D1 créée.'); } else { console.log('🗄️  Base D1 existante réutilisée.'); }
  const id = db.uuid || db.id;
  await api.post(`/d1/database/${id}/query`, { sql: fs.readFileSync(path.join(W, 'schema.sql'), 'utf8') });
  console.log('📐 Schéma appliqué.');
  return id;
}

async function uploadWorker(dbId, adminSecret) {
  const html = fs.readFileSync(path.join(W, 'public', 'index.html'), 'utf8');
  fs.writeFileSync(path.join(W, 'src', 'adminPage.js'), `// Généré depuis public/index.html par scripts/cloudflare-deploy.js\nexport const ADMIN_PAGE = ${JSON.stringify(html)};\n`);

  const bindings = [{ type: 'd1', name: 'DB', id: dbId }, { type: 'secret_text', name: 'ADMIN_SECRET', text: adminSecret }];
  const aiSent = [];
  for (const k of AI_KEYS) if (process.env[k]) { bindings.push({ type: 'secret_text', name: k, text: process.env[k] }); aiSent.push(k); }

  const form = new FormData();
  form.append('metadata', JSON.stringify({ main_module: 'index.js', compatibility_date: '2025-01-01', bindings }));
  for (const f of ['index.js', 'textCascade.js', 'adminPage.js']) {
    form.append(f, new Blob([fs.readFileSync(path.join(W, 'src', f), 'utf8')], { type: 'application/javascript+module' }), f);
  }
  await api.put(`/workers/scripts/${NAME}`, form, { maxBodyLength: Infinity });
  await api.post(`/workers/scripts/${NAME}/subdomain`, { enabled: true });
  console.log(`🚀 Worker déployé (clés IA transmises : ${aiSent.length ? aiSent.join(', ') : 'aucune'}).`);
}

async function workerUrl() {
  const sub = (await api.get('/workers/subdomain')).data.result.subdomain;
  return `https://${NAME}.${sub}.workers.dev`;
}

async function seed(key) {
  const file = path.join(ROOT, 'licenses.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const lic = (Array.isArray(raw) ? raw : Object.values(raw)).find((l) => String(l.key).toUpperCase() === key.toUpperCase());
  if (!lic) { console.error('Clé introuvable dans licenses.json local.'); process.exit(1); }
  const url = await workerUrl();
  const res = await axios.post(`${url}/admin/sync`, { upserts: [lic], deletes: [] }, { headers: { 'x-admin-secret': process.env.CLOUDFLARE_ADMIN_SECRET } });
  console.log(`🌱 Licence ${lic.key} copiée vers D1 (${res.data.upserted} écriture).`);
}

(async () => {
  const secret = ensureAdminSecret();
  const seedIdx = process.argv.indexOf('--seed');
  if (seedIdx > -1) { await seed(process.argv[seedIdx + 1]).catch((e) => fail('seed', e)); return; }
  const dbId = await ensureDatabase().catch((e) => fail('D1', e));
  await uploadWorker(dbId, secret).catch((e) => fail('Worker', e));
  const url = await workerUrl().catch((e) => fail('sous-domaine', e));
  console.log(`✅ URL : ${url}`);
  const sub = fs.readFileSync(ENV_PATH, 'utf8');
  if (!/^CLOUDFLARE_LICENSE_URL=/m.test(sub)) fs.appendFileSync(ENV_PATH, `CLOUDFLARE_LICENSE_URL=${url}\n`);
})();
