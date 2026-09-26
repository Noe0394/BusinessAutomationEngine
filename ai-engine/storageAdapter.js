const fs = require('fs');
const path = require('path');
const githubStore = require('../githubStore');

// STORAGE ADAPTER — abstraction de persistance agnostique demandée par le
// cahier des charges "Chat-Driven Agent Orchestrator" (fiches d'offres
// clarifiées, profils business construits en observant les discussions,
// état de la clarification en cours).
//
// Choix ASSUMÉ, en écart volontaire avec la formulation littérale du cahier
// des charges ("PostgreSQL/Redis sur le VPS") : ce dépôt n'utilise NULLE
// PART PostgreSQL ni Redis aujourd'hui (voir CLAUDE.md) — la persistance VPS
// existante est un fichier JSON par tenant + miroir GitHub fire-and-forget
// (voir lib/aiStudioStore.js, queues/scheduled_messages.js, campaigns_state/,
// etc.). Introduire une base de données supplémentaire pour ce seul module
// serait une infrastructure spéculative non demandée explicitement et non
// cohérente avec le reste du projet. Ce module reprend donc EXACTEMENT le
// patron déjà établi par lib/aiStudioStore.js, généralisé à plusieurs
// "espaces" (namespace) de documents au lieu d'un seul (les discussions).
//
// Sur local-client/ et mobile/webapp/, ce même contrat get/set/list est
// réimplémenté par-dessus le stockage déjà en place sur chaque cible
// (SQLite via node:sqlite côté local-client, IndexedDB côté mobile) — voir
// les copies adaptées dans ces dossiers. Aucun code ici n'est partagé
// directement entre cibles (convention déjà en place dans tout ce dépôt,
// voir CLAUDE.md § "copies à resynchroniser manuellement").

// LOCAL-FIRST : ces namespaces contiennent des données de conversation/contact
// des clients finaux. Ils restent sur le volume privé de l'instance (VPS/PC) et
// ne sont PAS poussés vers le miroir GitHub, sauf GITHUB_MIRROR_USER_DATA=true.
const LOCAL_ONLY_NAMESPACES = new Set([
  'message_history', 'conversation_index', 'conversation_state', 'closer_sessions',
  'crm_contacts', 'activity', 'chat_uploads', 'chat_intelligent_sessions',
  'task_queue', 'campaign_drafts', 'notifications', 'campaign_fallbacks',
  'contact_identity', 'alerts', 'pending_actions', 'owner_channel', 'group_campaigns', 'group_leads', 'ad_entries',
  'contact_sync_outbox',
  'contact_import_jobs',
  'contact_sync_status',
  'objective_missions',
  'pending_tool_actions',
  // Numéros de téléphone / clés de clients / contenus de formation : jamais poussés vers le miroir GitHub.
  'community_jobs', 'client_ai_quota', 'course_kb', 'lifecycle', 'improvements', 'guided_setup', 'service_trash',
]);
// Etat operationnel sensible necessaire a la reprise Render. Ces namespaces
// restent en clair uniquement sur le volume local; leur miroir distant est
// chiffre avec la cle serveur (SECRET_VAULT_KEY ou ADMIN_PASSWORD).
const ENCRYPTED_MIRROR_NAMESPACES = new Set([
  'task_queue', 'objective_missions', 'pending_tool_actions', 'campaign_drafts', 'auto_settings', 'community_jobs',
]);
const remoteStores = new Map();
const pendingWrites = new Set();
function isProductionRuntime() {
  return process.env.NODE_ENV === 'production'
    || process.env.RENDER === 'true'
    || !!process.env.RENDER_SERVICE_ID
    || !!process.env.RENDER_EXTERNAL_URL;
}
function isMirrored(namespace) {
  if (process.env.GITHUB_MIRROR_USER_DATA === 'true') return true;
  return !LOCAL_ONLY_NAMESPACES.has(String(namespace));
}
function isEncryptedMirror(namespace) {
  const name = String(namespace);
  // The opt-in user-data mirror encrypts every runtime namespace, including
  // namespaces introduced by future features.
  return process.env.GITHUB_MIRROR_USER_DATA === 'true' || ENCRYPTED_MIRROR_NAMESPACES.has(name);
}
function vault() { return require('./secretVault'); }
function canMirrorDurably(namespace) {
  const githubStore = require('../githubStore');
  return githubStore.enabled && (isEncryptedMirror(namespace) ? vault().isEncryptionConfigured() : isMirrored(namespace));
}

function assertProductionStorageReady(namespace) {
  if (!isProductionRuntime()) return true;
  const ns = namespace == null ? null : String(namespace);
  if (!githubStore.enabled) throw new Error(`DURABLE_STORAGE_UNAVAILABLE:${ns || 'startup'}:GITHUB_DATA_STORE_NOT_CONFIGURED`);
  if (process.env.GITHUB_MIRROR_USER_DATA !== 'true') {
    throw new Error(`DURABLE_STORAGE_UNAVAILABLE:${ns || 'startup'}:USER_DATA_MIRROR_NOT_ENABLED`);
  }
  if (isEncryptedMirror(ns || 'startup') && !vault().isEncryptionConfigured()) {
    throw new Error(`DURABLE_STORAGE_UNAVAILABLE:${ns || 'startup'}:ENCRYPTION_KEY_NOT_CONFIGURED`);
  }
  return true;
}

async function validateProductionStorage() {
  assertProductionStorageReady();
  if (!isProductionRuntime()) return { ok: true, checked: false };
  const repo = await githubStore.verifyPrivateRepository();
  return { ok: true, checked: true, privateRepository: repo.private, branch: repo.defaultBranch };
}

function sanitizeId(rawId) {
  const cleaned = String(rawId || '').trim().replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned || 'unknown';
}

function baseDir(namespace) {
  const root = process.env.AI_ENGINE_STORAGE_DIR || path.join(__dirname, '..', 'ai_engine_data');
  return path.join(root, sanitizeId(namespace));
}

function remoteBaseDir(namespace) {
  const root = process.env.GITHUB_AI_ENGINE_STORAGE_DIR || 'ai_engine_data';
  return `${root}/${sanitizeId(namespace)}`;
}

function docPath(namespace, docId) {
  return path.join(baseDir(namespace), `${sanitizeId(docId)}.json`);
}

function remoteDocPath(namespace, docId) {
  return `${remoteBaseDir(namespace)}/${sanitizeId(docId)}.json`;
}

function remoteStore(namespace, docId) {
  const file = remoteDocPath(namespace, docId);
  if (!remoteStores.has(file)) remoteStores.set(file, { store: githubStore.createStore(file), ready: null, initialized: false, writeQueue: Promise.resolve() });
  return remoteStores.get(file);
}
async function ensureRemoteReady(record) {
  if (record.initialized) return record.snapshot || null;
  if (!record.ready) {
    record.ready = record.store.fetchRemote().then((value) => { record.initialized = true; record.snapshot = value; return value; });
  }
  try { return await record.ready; }
  catch (err) { record.ready = null; throw err; }
}

function enqueueRemoteWrite(record, content) {
  const write = record.writeQueue.catch(() => {}).then(async () => {
    await ensureRemoteReady(record);
    await record.store.pushRemote(content);
    record.initialized = true;
    record.snapshot = { content };
    record.ready = Promise.resolve(record.snapshot);
  });
  record.writeQueue = write;
  pendingWrites.add(write);
  write.finally(() => pendingWrites.delete(write)).catch(() => {});
  return write;
}

// Lit un document {namespace}/{docId} — disque local en premier, puis
// GitHub si absent (redéploiement Render ayant vidé le disque éphémère,
// même logique que lib/aiStudioStore.js#loadAll). Retourne `defaultValue`
// (jamais null/undefined) si le document n'existe nulle part.
async function get(namespace, docId, defaultValue) {
  assertProductionStorageReady(namespace);
  try {
    const raw = fs.readFileSync(docPath(namespace, docId), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    // Pas de fichier local : tenter GitHub avant d'abandonner.
  }

  if (!isMirrored(namespace) && !isEncryptedMirror(namespace)) return defaultValue !== undefined ? defaultValue : null;
  if (isEncryptedMirror(namespace) && !vault().isEncryptionConfigured()) {
    if (isProductionRuntime()) throw new Error(`DURABLE_STORAGE_UNAVAILABLE:${namespace}:ENCRYPTION_KEY_NOT_CONFIGURED`);
    return defaultValue !== undefined ? defaultValue : null;
  }
  const remote = remoteStore(namespace, docId);
  if (!remote.store.enabled) {
    if (isProductionRuntime()) throw new Error(`DURABLE_STORAGE_UNAVAILABLE:${namespace}:GITHUB_DATA_STORE_NOT_CONFIGURED`);
    return defaultValue !== undefined ? defaultValue : null;
  }

  try {
    const fetched = await ensureRemoteReady(remote);
    const fetchedContent = await githubStore.fetchRemoteContent(fetched);
    if (!fetchedContent) return defaultValue !== undefined ? defaultValue : null;
    if (isEncryptedMirror(namespace)) {
      const envelope = JSON.parse(fetchedContent);
      if (!envelope || envelope._cyrusEncrypted !== 1) {
        // One-time migration from the previously configured backup branch.
        // Render now points only at the private repository; read the legacy
        // JSON once, then replace it with an encrypted snapshot before use.
        if (process.env.GITHUB_MIRROR_USER_DATA === 'true' && isProductionRuntime()) {
          const legacy = JSON.parse(fetchedContent);
          await setDurable(namespace, docId, legacy);
          return legacy;
        }
        return defaultValue !== undefined ? defaultValue : null;
      }
      const plaintext = vault().decrypt(envelope.payload);
      if (plaintext == null) {
        if (isProductionRuntime()) throw new Error('REMOTE_DOCUMENT_DECRYPT_FAILED');
        return defaultValue !== undefined ? defaultValue : null;
      }
      return JSON.parse(plaintext);
    }
    return JSON.parse(fetchedContent);
  } catch (err) {
    console.error(`ai-engine/storageAdapter (${namespace}/${docId}) : échec de restauration depuis GitHub :`, err.message);
    if (isProductionRuntime()) throw new Error(`DURABLE_STORAGE_READ_FAILED:${namespace}:${err.message}`);
    return defaultValue !== undefined ? defaultValue : null;
  }
}

// Écriture locale synchrone + sauvegarde GitHub fire-and-forget (jamais
// bloquant — un échec de sauvegarde distante ponctuel n'interrompt jamais
// l'appelant), même style que lib/aiStudioStore.js#saveAll.
function set(namespace, docId, data) {
  fs.mkdirSync(baseDir(namespace), { recursive: true });
  const content = JSON.stringify(data, null, 2);
  fs.writeFileSync(docPath(namespace, docId), content, 'utf8');
  if (!isMirrored(namespace) && !isEncryptedMirror(namespace)) return data;
  if (!githubStore.enabled) {
    if (isProductionRuntime()) console.error(`ai-engine/storageAdapter (${namespace}/${docId}) : persistence unavailable (GITHUB_DATA_STORE_NOT_CONFIGURED).`);
    return data;
  }
  if (isEncryptedMirror(namespace) && !vault().isEncryptionConfigured()) {
    console.error(`ai-engine/storageAdapter (${namespace}/${docId}) : miroir durable ignoré, clé de chiffrement absente.`);
    return data;
  }

  const remoteContent = isEncryptedMirror(namespace)
    ? JSON.stringify({ _cyrusEncrypted: 1, payload: vault().encrypt(content) }) : content;
  const remote = remoteStore(namespace, docId);
  enqueueRemoteWrite(remote, remoteContent).catch((err) => {
    console.error(`ai-engine/storageAdapter (${namespace}/${docId}) : échec de sauvegarde GitHub :`, err.message);
  });

  return data;
}

// Ecriture attendue pour les etats qui doivent survivre a un redemarrage
// Render. Le fichier local est mis a jour d'abord, puis l'appelant attend la
// confirmation du miroir GitHub chiffre avant de lancer l'effet externe.
async function setDurable(namespace, docId, data) {
  assertProductionStorageReady(namespace);
  if (isProductionRuntime() && !canMirrorDurably(namespace)) {
    throw new Error(`DURABLE_STORAGE_UNAVAILABLE:${namespace}:REMOTE_MIRROR_NOT_READY`);
  }
  if (isEncryptedMirror(namespace) && !vault().isEncryptionConfigured()) {
    throw new Error(`DURABLE_STORAGE_UNAVAILABLE:${namespace}:ENCRYPTION_KEY_NOT_CONFIGURED`);
  }
  fs.mkdirSync(baseDir(namespace), { recursive: true });
  const content = JSON.stringify(data, null, 2);
  if (!isMirrored(namespace) && !isEncryptedMirror(namespace)) {
    fs.writeFileSync(docPath(namespace, docId), content, 'utf8');
    return data;
  }
  if (!githubStore.enabled) {
    if (isProductionRuntime()) throw new Error(`DURABLE_STORAGE_UNAVAILABLE:${namespace}:GITHUB_DATA_STORE_NOT_CONFIGURED`);
    fs.writeFileSync(docPath(namespace, docId), content, 'utf8');
    return data;
  }
  const remoteContent = isEncryptedMirror(namespace)
    ? JSON.stringify({ _cyrusEncrypted: 1, payload: vault().encrypt(content) }) : content;
  const remote = remoteStore(namespace, docId);
  await enqueueRemoteWrite(remote, remoteContent);
  fs.writeFileSync(docPath(namespace, docId), content, 'utf8');
  return data;
}

// Liste les identifiants de documents connus localement pour un namespace
// (best-effort, disque local seulement — n'inclut pas un document qui
// existerait UNIQUEMENT sur GitHub après une purge du disque éphémère sans
// avoir encore été relu via get()).
function listIds(namespace) {
  try {
    return fs.readdirSync(baseDir(namespace))
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.slice(0, -5));
  } catch (err) {
    return [];
  }
}

async function listIdsAsync(namespace) {
  const local = listIds(namespace);
  if (!isMirrored(namespace) && !isEncryptedMirror(namespace)) return local;
  const names = await githubStore.listDirectory(remoteBaseDir(namespace), { strict: isProductionRuntime() });
  return Array.from(new Set(local.concat(names.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5)))));
}

function persistenceStatus() {
  const encryptionConfigured = vault().isEncryptionConfigured();
  const userDataMirror = process.env.GITHUB_MIRROR_USER_DATA === 'true';
  return { githubEnabled: githubStore.enabled, userDataMirror, encryptionConfigured,
    durableAcrossRestarts: githubStore.enabled && (!userDataMirror || encryptionConfigured),
    encryptedNamespaceCount: userDataMirror ? 'all' : ENCRYPTED_MIRROR_NAMESPACES.size,
    encryptedNamespaces: Array.from(ENCRYPTED_MIRROR_NAMESPACES).map((namespace) => ({ namespace,
      encryptionConfigured, durableAcrossRestarts: canMirrorDurably(namespace) })) };
}

async function flushPendingWrites(timeoutMs = 10000) {
  if (!pendingWrites.size) return { pending: 0, completed: true };
  let timeout;
  const result = await Promise.race([
    Promise.allSettled(Array.from(pendingWrites)).then(() => ({ done: true })),
    new Promise((resolve) => { timeout = setTimeout(() => resolve({ done: false }), Math.max(0, timeoutMs)); }),
  ]);
  if (timeout) clearTimeout(timeout);
  return { pending: pendingWrites.size, completed: result.done };
}

// Suppression d'un document (purge des données expirées) — local + miroir GitHub
// seulement si le namespace est mirroré.
function remove(namespace, docId) {
  try { fs.unlinkSync(docPath(namespace, docId)); } catch (err) { /* déjà absent */ }
  if (!isMirrored(namespace) && !isEncryptedMirror(namespace)) return true;
  const remote = remoteStore(namespace, docId);
  if (remote.store.enabled && typeof remote.store.deleteRemote === 'function') {
    remote.store.deleteRemote().catch((err) => console.error(`ai-engine/storageAdapter (${namespace}/${docId}) : échec de suppression GitHub :`, err.message));
  }
  return true;
}

module.exports = { get, set, setDurable, listIds, listIdsAsync, remove, isMirrored, isEncryptedMirror,
  canMirrorDurably, persistenceStatus, assertProductionStorageReady, validateProductionStorage, flushPendingWrites,
  LOCAL_ONLY_NAMESPACES, ENCRYPTED_MIRROR_NAMESPACES };
