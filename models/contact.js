const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const durableFiles = require('../lib/durableJsonFiles');

// "Table/Modèle Contact" du module de Capture Automatique de Prospects.
// Même principe de persistance par fichier JSON que le reste du projet (pas
// de base de données ici) — voir queues/scheduled_messages.js pour le même
// choix motivé.
const STORE_PATH = process.env.CONTACTS_PATH || path.join(__dirname, '..', 'contacts.json');

function tenantStorePath(tenantId) {
  if (!tenantId) throw new Error('TENANT_REQUIRED');
  const tenant = String(tenantId);
  if (tenant === '__admin__') return STORE_PATH;
  const key = crypto.createHash('sha256').update(tenant).digest('hex');
  return path.join(path.dirname(STORE_PATH), 'tenant-data', key, 'facebook-contacts.json');
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

function writeAll(list) { return durableFiles.write(storePath, list); }

function list({ keyword, source } = {}) {
  let all = readAll().sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  if (keyword) {
    all = all.filter((c) => c.keyword === keyword);
  }
  if (source) {
    all = all.filter((c) => c.source === source);
  }
  return all;
}

function get(id) {
  return readAll().find((c) => c.id === id) || null;
}

/**
 * Crée ou met à jour (par PSID) le profil d'un prospect capturé depuis un
 * commentaire ou un message Messenger. "keyword" n'est mis à jour que si un
 * mot-clé a effectivement été détecté sur cette interaction — un contact
 * déjà qualifié par un mot-clé précédent ne perd pas cette thématique s'il
 * écrit ensuite un message qui n'en contient aucun.
 */
async function upsertFromLead({ psid, firstName, lastName, name, source, sourceText, postId, keyword }) {
  const all = readAll();
  const idx = all.findIndex((c) => c.psid === psid);
  const now = new Date().toISOString();
  const resolvedName = name || [firstName, lastName].filter(Boolean).join(' ') || null;

  if (idx === -1) {
    const contact = {
      id: `contact_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      psid,
      firstName: firstName || null,
      lastName: lastName || null,
      name: resolvedName,
      source,
      lastText: sourceText || '',
      postId: postId || null,
      keyword: keyword || null,
      autoReplied: false,
      createdAt: now,
      updatedAt: now,
    };
    all.push(contact);
    await writeAll(all);
    return contact;
  }

  const updated = {
    ...all[idx],
    firstName: firstName || all[idx].firstName,
    lastName: lastName || all[idx].lastName,
    name: resolvedName || all[idx].name,
    source,
    lastText: sourceText || all[idx].lastText,
    postId: postId || all[idx].postId,
    keyword: keyword || all[idx].keyword,
    updatedAt: now,
  };
  all[idx] = updated;
  await writeAll(all);
  return updated;
}

async function markAutoReplied(id) {
  const all = readAll();
  const idx = all.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], autoReplied: true };
  await writeAll(all);
  return all[idx];
}

return { list, get, upsertFromLead, markAutoReplied };
}

const adminStore = createStore('__admin__');
async function restorePersistedFiles(tenantIds = []) {
  const files = [STORE_PATH];
  for (const tenantId of new Set((tenantIds || []).map(String))) if (tenantId !== '__admin__') files.push(tenantStorePath(tenantId));
  return durableFiles.restoreMany(files);
}
module.exports = { ...adminStore, forTenant: (tenantId) => createStore(tenantId), restorePersistedFiles };
