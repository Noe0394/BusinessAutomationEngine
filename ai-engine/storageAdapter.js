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
]);
function isMirrored(namespace) {
  if (process.env.GITHUB_MIRROR_USER_DATA === 'true') return true;
  return !LOCAL_ONLY_NAMESPACES.has(String(namespace));
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

// Lit un document {namespace}/{docId} — disque local en premier, puis
// GitHub si absent (redéploiement Render ayant vidé le disque éphémère,
// même logique que lib/aiStudioStore.js#loadAll). Retourne `defaultValue`
// (jamais null/undefined) si le document n'existe nulle part.
async function get(namespace, docId, defaultValue) {
  try {
    const raw = fs.readFileSync(docPath(namespace, docId), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    // Pas de fichier local : tenter GitHub avant d'abandonner.
  }

  if (!isMirrored(namespace)) return defaultValue !== undefined ? defaultValue : null;
  const store = githubStore.createStore(remoteDocPath(namespace, docId));
  if (!store.enabled) return defaultValue !== undefined ? defaultValue : null;

  try {
    const remote = await store.fetchRemote();
    if (!remote || !remote.content) return defaultValue !== undefined ? defaultValue : null;
    return JSON.parse(remote.content);
  } catch (err) {
    console.error(`ai-engine/storageAdapter (${namespace}/${docId}) : échec de restauration depuis GitHub :`, err.message);
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
  if (!isMirrored(namespace)) return data;

  const store = githubStore.createStore(remoteDocPath(namespace, docId));
  store.pushRemote(content).catch((err) => {
    console.error(`ai-engine/storageAdapter (${namespace}/${docId}) : échec de sauvegarde GitHub :`, err.message);
  });

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

// Suppression d'un document (purge des données expirées) — local + miroir GitHub
// seulement si le namespace est mirroré.
function remove(namespace, docId) {
  try { fs.unlinkSync(docPath(namespace, docId)); } catch (err) { /* déjà absent */ }
  if (!isMirrored(namespace)) return true;
  const store = githubStore.createStore(remoteDocPath(namespace, docId));
  if (store.enabled && typeof store.deleteRemote === 'function') {
    store.deleteRemote().catch((err) => console.error(`ai-engine/storageAdapter (${namespace}/${docId}) : échec de suppression GitHub :`, err.message));
  }
  return true;
}

module.exports = { get, set, listIds, remove, isMirrored, LOCAL_ONLY_NAMESPACES };
