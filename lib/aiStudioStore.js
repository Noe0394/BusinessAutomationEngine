const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const githubStore = require('../githubStore');

// Persistance des discussions du Copywriter Studio IA — un fichier JSON par
// tenant (isolation stricte, même principe que campaigns_state/ et
// message_history/, voir queues/campaignEngine.js et
// lib/messageHistory.js) : disque local (rapide, source normale) + miroir
// GitHub en fire-and-forget (survit à un redéploiement Render qui vide le
// disque éphémère, voir githubStore.js).
const SESSIONS_DIR = process.env.AI_STUDIO_SESSIONS_DIR || path.join(__dirname, '..', 'ai_studio_sessions');
const REMOTE_SESSIONS_DIR = process.env.GITHUB_AI_STUDIO_SESSIONS_DIR || 'ai_studio_sessions';

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

// Essaie le disque local en premier, puis GitHub si absent (redéploiement
// Render ayant vidé le disque éphémère) — même logique que
// lib/messageHistory.js#loadHistory. Retourne toujours un tableau, jamais
// null.
async function loadAll(tenantId) {
  const store = githubStore.createStore(remoteFilePath(tenantId));

  try {
    const raw = fs.readFileSync(statePath(tenantId), 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    // Pas de fichier local : tenter GitHub avant d'abandonner.
  }

  if (!store.enabled) return [];

  try {
    const remote = await store.fetchRemote();
    if (!remote || !remote.content) return [];
    const parsed = JSON.parse(remote.content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.error(`Copywriter Studio IA (tenant "${tenantId}") : échec de restauration des discussions depuis GitHub :`, err.message);
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

  const store = githubStore.createStore(remoteFilePath(tenantId));
  store.pushRemote(content).catch((err) => {
    console.error(`Copywriter Studio IA (tenant "${tenantId}") : échec de sauvegarde GitHub des discussions :`, err.message);
  });

  return trimmed;
}

function newId() {
  return `${Date.now().toString(36)}${crypto.randomBytes(6).toString('hex')}`;
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
};
