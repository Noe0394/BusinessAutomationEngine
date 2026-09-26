const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const githubStore = require('../githubStore');
const secretVault = require('../ai-engine/secretVault');

// Persistance des discussions du Copywriter Studio IA — un fichier JSON par
// tenant (isolation stricte, même principe que campaigns_state/ et
// message_history/, voir queues/campaignEngine.js et
// lib/messageHistory.js) : disque local (rapide, source normale) + miroir
// GitHub en fire-and-forget (survit à un redéploiement Render qui vide le
// disque éphémère, voir githubStore.js).
const SESSIONS_DIR = process.env.AI_STUDIO_SESSIONS_DIR || path.join(__dirname, '..', 'ai_studio_sessions');
const REMOTE_SESSIONS_DIR = process.env.GITHUB_AI_STUDIO_SESSIONS_DIR || 'ai_studio_sessions';
const remoteStores = new Map();
const remoteReady = new Map();
const remoteWrites = new Map();
const pendingWrites = new Set();
const encryptRemoteData = () => process.env.GITHUB_MIRROR_USER_DATA === 'true';

const DEFAULT_TITLE = 'Nouvelle discussion';
const MAX_SESSIONS_PER_TENANT = 200; // garde-fou : élague les plus anciennes au-delà

function sanitizeTenantId(rawId) {
  const cleaned = String(rawId || '').trim().replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned || 'unknown';
}

function statePath(tenantId) {
  return path.join(SESSIONS_DIR, `${sanitizeTenantId(tenantId)}.json`);
}

function remoteFilePath(tenantId) {
  return `${REMOTE_SESSIONS_DIR}/${sanitizeTenantId(tenantId)}.json`;
}

function storeFor(tenantId) {
  const key = remoteFilePath(tenantId);
  if (!remoteStores.has(key)) remoteStores.set(key, githubStore.createStore(key));
  return remoteStores.get(key);
}

async function ensureRemoteReady(tenantId) {
  const key = remoteFilePath(tenantId);
  if (!remoteReady.has(key)) {
    remoteReady.set(key, storeFor(tenantId).fetchRemote().catch((err) => {
      remoteReady.delete(key);
      throw err;
    }));
  }
  return remoteReady.get(key);
}

function decodeRemote(content) {
  if (!encryptRemoteData()) return content;
  if (!secretVault.isEncryptionConfigured()) throw new Error('AI_STUDIO_STORAGE_KEY_MISSING');
  const envelope = JSON.parse(content);
  if (!envelope || envelope._cyrusEncrypted !== 1) return content; // one-time private-repo legacy migration
  return secretVault.decrypt(envelope.payload);
}

function encodeRemote(content) {
  if (!encryptRemoteData()) return content;
  if (!secretVault.isEncryptionConfigured()) throw new Error('AI_STUDIO_STORAGE_KEY_MISSING');
  return JSON.stringify({ _cyrusEncrypted: 1, payload: secretVault.encrypt(content) });
}

// Essaie le disque local en premier, puis GitHub si absent (redéploiement
// Render ayant vidé le disque éphémère) — même logique que
// lib/messageHistory.js#loadHistory. Retourne toujours un tableau, jamais
// null.
async function loadAll(tenantId) {
  const store = storeFor(tenantId);

  try {
    const raw = fs.readFileSync(statePath(tenantId), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // Pas de fichier local : tenter GitHub avant d'abandonner.
  }

  if (!store.enabled) return [];

  try {
    const remote = await ensureRemoteReady(tenantId);
    const remoteContent = await githubStore.fetchRemoteContent(remote);
    if (!remoteContent) return [];
    const parsed = JSON.parse(decodeRemote(remoteContent));
    const envelope = JSON.parse(remoteContent);
    if (encryptRemoteData() && (!envelope || envelope._cyrusEncrypted !== 1)) {
      if (!secretVault.isEncryptionConfigured()) throw new Error('AI_STUDIO_STORAGE_KEY_MISSING');
      await storeFor(tenantId).pushRemote(encodeRemote(JSON.stringify(parsed, null, 2)));
    }
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`Copywriter Studio IA (tenant "${tenantId}") : échec de restauration des discussions depuis GitHub :`, err.message);
    if (process.env.NODE_ENV === 'production' || process.env.RENDER === 'true' || process.env.RENDER_SERVICE_ID || process.env.RENDER_EXTERNAL_URL) throw err;
    return [];
  }
}

// Écriture locale synchrone + sauvegarde GitHub fire-and-forget — même style
// que lib/messageHistory.js#saveHistory : jamais bloquant, un échec de
// sauvegarde distante ponctuel n'interrompt jamais la conversation en cours.
function saveAll(tenantId, sessions) {
  // Garde-fou anti-croissance illimitée : conserve les MAX_SESSIONS_PER_TENANT
  // discussions les plus récemment modifiées, jamais un historique complet
  // qui grossirait indéfiniment sur un usage prolongé.
  const trimmed = sessions
    .slice()
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .slice(0, MAX_SESSIONS_PER_TENANT);

  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const content = JSON.stringify(trimmed, null, 2);
  fs.writeFileSync(statePath(tenantId), content, 'utf8');

  const key = remoteFilePath(tenantId);
  const store = storeFor(tenantId);
  const prior = remoteWrites.get(key) || Promise.resolve();
  const write = prior.catch(() => {}).then(async () => {
    await ensureRemoteReady(tenantId);
    await store.pushRemote(encodeRemote(content));
  });
  remoteWrites.set(key, write);
  pendingWrites.add(write);
  write.finally(() => {
    pendingWrites.delete(write);
    if (remoteWrites.get(key) === write) remoteWrites.delete(key);
  }).catch(() => {});
  write.catch((err) => {
    console.error(`Copywriter Studio IA (tenant "${tenantId}") : échec de sauvegarde GitHub des discussions :`, err.message);
  });

  return trimmed;
}

function newId() {
  return `${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
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

// Résumé léger d'une discussion (pour le panneau "Mes Discussions IA") —
// jamais les messages complets, pour garder la liste rapide à charger même
// avec de nombreuses discussions volumineuses.
function toSummary(session) {
  return {
    id: session.id,
    title: session.title || DEFAULT_TITLE,
    createdAt: session.createdAt,
    updatedAt: session.updatedAt,
    messageCount: Array.isArray(session.messages) ? session.messages.length : 0,
  };
}

async function listSessions(tenantId) {
  const sessions = await loadAll(tenantId);
  return sessions
    .slice()
    .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime())
    .map(toSummary);
}

async function getSession(tenantId, sessionId) {
  const sessions = await loadAll(tenantId);
  return sessions.find((s) => s.id === sessionId) || null;
}

async function createSession(tenantId) {
  const sessions = await loadAll(tenantId);
  const now = new Date().toISOString();
  const session = {
    id: newId(),
    title: DEFAULT_TITLE,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  sessions.push(session);
  saveAll(tenantId, sessions);
  return session;
}

// Ajoute un ou plusieurs messages à une discussion existante — utilisé pour
// ajouter en une fois le message utilisateur ET la réponse de l'assistant
// (voir index.js#POST /api/ai-studio/sessions/:id/messages), pour ne
// persister qu'une seule fois par échange. `title`, si fourni, ne remplace
// le titre que s'il est encore la valeur par défaut (voir
// lib/ai/localCopywriterEngine.js#generateSessionTitle, dérivé du PREMIER
// message utilisateur uniquement — une discussion garde ensuite un titre
// stable).
async function appendMessages(tenantId, sessionId, newMessages, title) {
  const sessions = await loadAll(tenantId);
  const session = sessions.find((s) => s.id === sessionId);
  if (!session) return null;

  if (!Array.isArray(session.messages)) session.messages = [];
  session.messages.push(...newMessages);
  session.updatedAt = new Date().toISOString();
  if (title && (!session.title || session.title === DEFAULT_TITLE)) {
    session.title = title;
  }

  saveAll(tenantId, sessions);
  return session;
}

async function deleteSession(tenantId, sessionId) {
  const sessions = await loadAll(tenantId);
  const next = sessions.filter((s) => s.id !== sessionId);
  if (next.length === sessions.length) return false;
  saveAll(tenantId, next);
  return true;
}

module.exports = {
  DEFAULT_TITLE,
  listSessions,
  getSession,
  createSession,
  appendMessages,
  deleteSession,
  flushPendingWrites,
};
