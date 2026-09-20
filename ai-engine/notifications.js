// Notifications du vendeur (persistées par tenant, non mirrorées) : création, lecture, marquage lu.
const storageAdapter = require('./storageAdapter');

const NS = 'notifications';
const MAX = 200;
const sanitize = (id) => String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';
const uid = () => 'ntf_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const load = (tenant) => storageAdapter.get(NS, sanitize(tenant), { tenant: sanitize(tenant), items: [] });

async function create(tenant, { title, body, level, ref }) {
  const doc = await load(tenant);
  const n = { id: uid(), title: String(title).slice(0, 120), body: String(body || '').slice(0, 500), level: level || 'info', ref: ref || null, read: false, at: Date.now() };
  doc.items = doc.items.concat(n).slice(-MAX);
  storageAdapter.set(NS, sanitize(tenant), doc);
  return n;
}
async function list(tenant, all) { const doc = await load(tenant); return all ? doc.items : doc.items.filter((n) => !n.read); }
async function markRead(tenant, id) {
  const doc = await load(tenant);
  const n = doc.items.find((x) => x.id === id);
  if (!n) return false;
  n.read = true;
  storageAdapter.set(NS, sanitize(tenant), doc);
  return true;
}

module.exports = { create, list, markRead };
