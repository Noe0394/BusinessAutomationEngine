// Répondeur permanent : ensemble (synchrone) des comptes dont l'auto-réponse doit rester active en permanence sur
// WhatsApp et Telegram. Sources : AUTO_REPLY_ALWAYS_ON_TENANTS (liste séparée par des virgules) et le réglage
// `alwaysOn` de chaque compte (auto_settings). Les gestionnaires de sessions s'en servent pour ne jamais évincer ces sessions.
const sanitize = (id) => String(id || '').trim().replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown';

const dynamic = new Set();

function fromEnv() {
  return new Set(String(process.env.AUTO_REPLY_ALWAYS_ON_TENANTS || '').split(',').map((s) => s.trim()).filter(Boolean).map(sanitize));
}

function isAlwaysOn(tenant) {
  const t = sanitize(tenant);
  return dynamic.has(t) || fromEnv().has(t);
}

function mark(tenant, on) {
  if (on) dynamic.add(sanitize(tenant)); else dynamic.delete(sanitize(tenant));
}

function list() {
  return Array.from(new Set([...dynamic, ...fromEnv()]));
}

// Charge les réglages persistés (au démarrage) : tout compte avec alwaysOn=true est marqué.
async function loadFromStorage(storageAdapter, namespace) {
  const ns = namespace || 'auto_settings';
  const ids = typeof storageAdapter.listIdsAsync === 'function'
    ? await storageAdapter.listIdsAsync(ns).catch(() => storageAdapter.listIds(ns)) : storageAdapter.listIds(ns);
  for (const id of ids) {
    try {
      const doc = await storageAdapter.get(ns, id, null);
      if (doc && doc.alwaysOn === true) dynamic.add(sanitize(id));
    } catch (e) { /* ignoré */ }
  }
  return list();
}

module.exports = { isAlwaysOn, mark, list, loadFromStorage, sanitize };
