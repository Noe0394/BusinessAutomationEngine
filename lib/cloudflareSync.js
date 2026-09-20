// Réplication des licences VPS <-> Worker Cloudflare (D1). Inactif tant que
// CLOUDFLARE_LICENSE_URL et CLOUDFLARE_ADMIN_SECRET ne sont pas définis.
// Ne pousse que les clés modifiées (quota D1 gratuit) ; ne remplace jamais une
// liaison d'appareil déjà faite côté Cloudflare.
const crypto = require('crypto');
const axios = require('axios');

const BASE = String(process.env.CLOUDFLARE_LICENSE_URL || '').replace(/\/+$/, '');
const SECRET = process.env.CLOUDFLARE_ADMIN_SECRET || '';
const enabled = !!(BASE && SECRET);

const state = new Map(); // key -> { hash, remoteUpdatedAt }
const http = () => axios.create({ baseURL: BASE, timeout: 15000, headers: { 'x-admin-secret': SECRET, 'content-type': 'application/json' } });

function hashOf(license) {
  const { updatedAt, ...rest } = license;
  return crypto.createHash('sha1').update(JSON.stringify(Object.keys(rest).sort().map((k) => [k, rest[k]]))).digest('hex');
}

// Envoie uniquement les licences nouvelles/modifiées et les suppressions.
async function pushLicenses(licenses) {
  if (!enabled) return { skipped: true };
  const upserts = [];
  const current = new Set();
  for (const l of licenses) {
    current.add(l.key);
    const h = hashOf(l);
    const known = state.get(l.key);
    if (!known || known.hash !== h) upserts.push(l);
  }
  const deletes = Array.from(state.keys()).filter((k) => !current.has(k));
  if (!upserts.length && !deletes.length) return { upserted: 0, deleted: 0 };
  try {
    const { data } = await http().post('/admin/sync', { upserts, deletes });
    for (const l of upserts) state.set(l.key, { hash: hashOf(l), remoteUpdatedAt: data.updatedAt });
    for (const k of deletes) state.delete(k);
    return { upserted: upserts.length, deleted: deletes.length };
  } catch (err) {
    console.error('Échec de réplication des licences vers Cloudflare :', err.message);
    return { error: err.message };
  }
}

// Fusionne ce que Cloudflare a modifié seul (liaison d'appareil, clés créées par
// la page admin Cloudflare, activation/désactivation) dans la liste locale.
// Retourne la nouvelle liste si elle a changé, sinon null.
async function pullLicenses(local) {
  if (!enabled) return null;
  let remote;
  try { remote = (await http().get('/admin/list')).data; } catch (err) {
    console.error('Échec de lecture des licences Cloudflare :', err.message);
    return null;
  }
  const byKey = new Map(local.map((l) => [l.key, l]));
  let changed = false;
  for (const r of remote) {
    const known = state.get(r.key);
    const mine = byKey.get(r.key);
    const { updatedAt, ...fields } = r;
    if (!mine) {
      byKey.set(r.key, fields); changed = true;
      state.set(r.key, { hash: hashOf(fields), remoteUpdatedAt: updatedAt });
    } else if (!known) {
      // Premier contact : on adopte seulement la liaison d'appareil distante.
      if (r.boundDeviceId && !mine.boundDeviceId) { mine.boundDeviceId = r.boundDeviceId; mine.boundAt = r.boundAt; changed = true; }
    } else if (updatedAt !== known.remoteUpdatedAt) {
      Object.assign(mine, fields);
      known.remoteUpdatedAt = updatedAt; known.hash = hashOf(mine); changed = true;
    }
  }
  return changed ? Array.from(byKey.values()) : null;
}

let timer = null;
function startPull(getLocal, setLocal, intervalMs) {
  if (!enabled || timer) return;
  const run = async () => {
    const merged = await pullLicenses(getLocal());
    if (merged) setLocal(merged);
  };
  run();
  timer = setInterval(run, intervalMs || 15 * 60 * 1000);
  if (timer.unref) timer.unref();
}

module.exports = { enabled, pushLicenses, pullLicenses, startPull, hashOf, _state: state };
