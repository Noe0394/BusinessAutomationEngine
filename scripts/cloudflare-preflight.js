// Vérifie HORS-LIGNE que l'environnement Cloudflare est prêt (aucun appel réseau, aucun secret affiché).
//   node scripts/cloudflare-preflight.js            -> rapport
//   node scripts/cloudflare-preflight.js gen-secret -> génère un ADMIN_SECRET aléatoire (à copier, non enregistré)
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const W = path.join(ROOT, 'cloudflare', 'license-worker');

if (process.argv[2] === 'gen-secret') {
  console.log(crypto.randomBytes(32).toString('base64url'));
  process.exit(0);
}

const results = [];
const check = (name, ok, detail) => results.push({ name, ok, detail });

check('Node >= 22 (node:sqlite, tests)', Number(process.versions.node.split('.')[0]) >= 22, process.version);
for (const f of ['wrangler.toml', 'schema.sql', 'src/index.js', 'src/textCascade.js', 'public/index.html']) {
  check(`fichier ${f}`, fs.existsSync(path.join(W, f)));
}

const toml = fs.existsSync(path.join(W, 'wrangler.toml')) ? fs.readFileSync(path.join(W, 'wrangler.toml'), 'utf8') : '';
const dbId = (toml.match(/database_id\s*=\s*"([^"]*)"/) || [])[1] || '';
check('database_id renseigné dans wrangler.toml', /^[0-9a-f-]{32,}$/i.test(dbId), dbId.startsWith('REMPLACER') ? 'encore le marqueur (étape 3 du guide)' : (dbId ? 'ok' : 'absent'));

try {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec(fs.readFileSync(path.join(W, 'schema.sql'), 'utf8'));
  check('schema.sql valide (SQLite)', true);
} catch (e) { check('schema.sql valide (SQLite)', false, e.message); }

const wr = spawnSync('npx', ['--no-install', 'wrangler', '--version'], { cwd: W, shell: true, encoding: 'utf8', timeout: 30000 });
check('wrangler installé (sans téléchargement)', wr.status === 0, wr.status === 0 ? String(wr.stdout).trim().split('\n').pop() : 'absent — sera téléchargé au 1er `npx wrangler` (~60 Mo)');

const envPath = path.join(ROOT, '.env');
const env = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
const has = (k) => new RegExp(`^${k}=.+`, 'm').test(env);
check('.env VPS : CLOUDFLARE_LICENSE_URL', has('CLOUDFLARE_LICENSE_URL'), 'à renseigner après le déploiement');
check('.env VPS : CLOUDFLARE_ADMIN_SECRET', has('CLOUDFLARE_ADMIN_SECRET'), 'à renseigner après `wrangler secret put`');

let bad = 0;
for (const r of results) {
  if (!r.ok) bad += 1;
  console.log(`${r.ok ? '✅' : '⬜'} ${r.name}${r.detail ? ' — ' + r.detail : ''}`);
}
console.log(bad ? `\n${bad} point(s) restent à faire : suivre cloudflare/SETUP-PAS-A-PAS.md` : '\nEnvironnement prêt.');
