const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Règles "mot-clé détecté → réponse automatique" du module de Capture
// Automatique de Prospects, configurables depuis l'onglet Contacts /
// Prospects du dashboard plutôt que codées en dur.
const STORE_PATH = process.env.KEYWORD_RULES_PATH || path.join(__dirname, '..', 'keyword_rules.json');

function tenantStorePath(tenantId) {
  if (!tenantId) throw new Error('TENANT_REQUIRED');
  const tenant = String(tenantId);
  if (tenant === '__admin__') return STORE_PATH;
  const key = crypto.createHash('sha256').update(tenant).digest('hex');
  return path.join(path.dirname(STORE_PATH), 'tenant-data', key, 'facebook-keyword-rules.json');
}

function createStore(tenantId) {
const storePath = tenantStorePath(tenantId);
function readAll() {
  try {
    const value = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    return Array.isArray(value) ? value : [];
  } catch (err) {
    return [];
  }
}

function writeAll(list) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.writeFileSync(storePath, JSON.stringify(list, null, 2), 'utf8');
}

function list() {
  return readAll();
}

function create({ keyword, replyMessage, mediaUrl, mediaMimetype, mediaFilename }) {
  const rule = {
    id: `rule_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    keyword: String(keyword || '').trim().toUpperCase(),
    replyMessage: replyMessage || '',
    mediaUrl: mediaUrl || null,
    mediaMimetype: mediaMimetype || null,
    mediaFilename: mediaFilename || null,
    createdAt: new Date().toISOString(),
  };
  const all = readAll();
  all.push(rule);
  writeAll(all);
  return rule;
}

function remove(id) {
  const all = readAll().filter((r) => r.id !== id);
  writeAll(all);
  return all;
}

// Correspondance simple, insensible à la casse, sous-chaîne du texte reçu —
// cohérent avec le cahier des charges ("si un commentaire contient un
// mot-clé"). La première règle qui correspond est utilisée.
function findMatch(text) {
  if (!text) return null;
  const upperText = String(text).toUpperCase();
  return readAll().find((r) => r.keyword && upperText.includes(r.keyword)) || null;
}

return { list, create, remove, findMatch };
}

const adminStore = createStore('__admin__');
module.exports = { ...adminStore, forTenant: (tenantId) => createStore(tenantId) };
