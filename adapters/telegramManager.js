const fs = require('fs');
const path = require('path');
const githubStore = require('../githubStore');
const telegram = require('./telegram');
const sessionRegulator = require('./sessionRegulator');
const { TelegramCampaignEngine, listTenantsWithPendingCampaigns } = require('../queues/telegramCampaignEngine');

// Registre des instances Telegram par tenant — même isolation stricte que
// adapters/whatsappManager.js : chaque clé de licence obtient sa PROPRE
// instance Telegram (adapters/telegram.js#createSession) et son propre
// moteur de campagne (queues/telegramCampaignEngine.js), jamais partagés
// entre deux clés. Avant cette refonte, tout le serveur partageait UN SEUL
// client Telegram (ancienne classe TelegramAdapter instanciée une fois dans
// index.js) : connecter une 2e clé de licence au module Telegram déconnectait
// et remplaçait la session de la première, exactement le bug corrigé côté
// WhatsApp par whatsappManager.js.
const ADMIN_TENANT_ID = '__admin__';

const tenants = new Map(); // tenantId assaini -> { session, campaignEngine, initStarted }

function sanitizeTenantId(rawId) {
  const cleaned = String(rawId || '').trim().replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned || 'unknown';
}

// Peut lever sessionRegulator.SessionLimitError si la limite globale de
// sessions simultanées est atteinte et qu'aucune session (WhatsApp ou
// Telegram) n'est éligible à l'éviction — à traiter par l'appelant (voir
// attachTelegram dans index.js) en refusant poliment la connexion.
function getOrCreate(rawTenantId) {
  const tenantId = sanitizeTenantId(rawTenantId);
  if (!tenants.has(tenantId)) {
    sessionRegulator.ensureCapacity('telegram', tenantId);
    const session = telegram.createSession(tenantId);
    const campaignEngine = new TelegramCampaignEngine(tenantId, session, () => sessionRegulator.touch('telegram', tenantId));
    tenants.set(tenantId, { session, campaignEngine, initStarted: false });
    sessionRegulator.register('telegram', tenantId, {
      protected: tenantId === ADMIN_TENANT_ID,
      hasActiveCampaign: () => (campaignEngine.getStatus() || {}).status === 'running',
      dispose: () => session.dispose(),
      onEvicted: () => tenants.delete(tenantId),
    });
  }
  sessionRegulator.touch('telegram', tenantId);
  return tenants.get(tenantId);
}

// Connexion paresseuse : une instance Telegram n'est démarrée (restauration
// de session + init()) qu'à la première requête d'un tenant donné — voir le
// même choix côté WhatsApp (adapters/whatsappManager.js#ensureConnected) et
// sa justification (dizaines de clés potentiellement inactives). Idempotent :
// les requêtes concurrentes d'un même tenant ne déclenchent qu'un seul init().
function ensureConnected(entry) {
  if (entry.initStarted) return;
  entry.initStarted = true;
  entry.session
    .restoreSessionFromRemote()
    .catch((err) => {
      console.error(`Erreur lors de la restauration de la session Telegram (tenant "${entry.session.tenantId}") depuis GitHub :`, err.message);
    })
    .finally(() => {
      entry.session.init().catch((err) => {
        console.error(`Erreur lors de l'initialisation de l'adaptateur Telegram (tenant "${entry.session.tenantId}") :`, err.message);
      });
    });
}

// À utiliser par le middleware Express (voir index.js#attachTelegram) : le
// tenant d'une requête est soit l'admin (mot de passe admin), soit la clé de
// licence fournie — jamais les deux à la fois, et jamais partagé entre deux
// clés différentes.
function getSessionForRequest(req) {
  const rawTenantId = req.isAdmin ? ADMIN_TENANT_ID : req.licenseKey;
  const entry = getOrCreate(rawTenantId);
  ensureConnected(entry);
  return entry;
}

// ---------- Migration de l'ancienne session globale (avant cette refonte) ----------
// Avant cette version, tout le serveur partageait une seule session Telegram
// (telegram_session.txt en local, telegram_session.json sur GitHub). On
// rattache cette session historique au tenant admin plutôt que de la perdre
// silencieusement — même choix conservateur que côté WhatsApp (voir
// whatsappManager.js#migrateLegacyLocalAuth).
async function migrateLegacyLocalAuth() {
  const legacyPath = telegram.LEGACY_SESSION_PATH;
  const newPath = telegram.sessionPathFor(ADMIN_TENANT_ID);

  if (!fs.existsSync(legacyPath) || fs.existsSync(newPath)) {
    return;
  }

  try {
    fs.mkdirSync(path.dirname(newPath), { recursive: true });
    fs.copyFileSync(legacyPath, newPath);
    fs.rmSync(legacyPath, { force: true });
    console.log('Session Telegram locale historique (partagée) migrée vers le tenant admin.');
  } catch (err) {
    console.error('Migration locale de la session Telegram historique échouée (sans impact si GITHUB_TOKEN est configuré) :', err.message);
  }
}

async function migrateLegacyRemoteAuth() {
  const legacyStore = githubStore.createStore(process.env.GITHUB_TELEGRAM_SESSION_PATH || 'telegram_session.json');
  if (!legacyStore.enabled) return;

  try {
    const remote = await legacyStore.fetchRemote();
    if (!remote || !remote.content) return;

    const remoteDir = process.env.GITHUB_TELEGRAM_SESSION_DIR || 'telegram_sessions';
    const adminStore = githubStore.createStore(`${remoteDir}/${ADMIN_TENANT_ID}.json`);
    const existing = await adminStore.fetchRemote();
    if (existing && existing.content) return; // le tenant admin a déjà sa propre session

    await adminStore.pushRemote(remote.content);
    console.log(`Session Telegram distante historique (partagée) migrée vers ${remoteDir}/${ADMIN_TENANT_ID}.json.`);
  } catch (err) {
    console.error('Migration distante de la session Telegram historique échouée :', err.message);
  }
}

// À appeler une fois au démarrage du serveur : préserve le comportement
// historique (le tenant admin se connecte automatiquement, sans attendre une
// première requête) et rattache l'ancienne session partagée si elle existe.
async function initAdminSession() {
  await migrateLegacyLocalAuth();
  await migrateLegacyRemoteAuth();
  ensureConnected(getOrCreate(ADMIN_TENANT_ID));
}

// À appeler une fois au démarrage du serveur, après initAdminSession() :
// reprend automatiquement, pour chaque tenant dont l'état persisté indique
// une campagne Telegram encore "running"/"paused" au moment de l'arrêt
// précédent du process, l'envoi en arrière-plan exactement là où il s'était
// arrêté — sans action requise de l'utilisateur.
async function bootResumePendingCampaigns() {
  const tenantIds = await listTenantsWithPendingCampaigns();
  for (const tenantId of tenantIds) {
    const entry = getOrCreate(tenantId);
    ensureConnected(entry);
    await entry.campaignEngine.resumeIfPending();
  }
  if (tenantIds.length > 0) {
    console.log(`Reprise automatique de ${tenantIds.length} campagne(s) Telegram interrompue(s) par le redémarrage.`);
  }
}

// Panneau admin (/api/admin/storage-status) : même forme agrégée que
// whatsappManager.getStorageStatus().
function getStorageStatus() {
  const list = [];
  for (const [tenantId, entry] of tenants.entries()) {
    list.push({ tenantId, ...entry.session.getStorageStatus() });
  }

  const first = list[0] || {};
  const failing = list.find((t) => t.lastPushOk === false);
  const mostRecentPush = list.reduce((latest, t) => {
    if (!t.lastPushAt) return latest;
    return (!latest || t.lastPushAt > latest) ? t.lastPushAt : latest;
  }, null);

  return {
    enabled: githubStore.enabled,
    repo: first.repo || null,
    branch: first.branch || null,
    lastPushOk: failing ? false : (list.length > 0 ? true : null),
    lastPushError: failing ? `[tenant ${failing.tenantId}] ${failing.lastPushError}` : null,
    lastPushAt: mostRecentPush,
    activeTenants: list.length,
    tenants: list,
  };
}

module.exports = {
  ADMIN_TENANT_ID,
  sanitizeTenantId,
  getOrCreate,
  getSessionForRequest,
  initAdminSession,
  bootResumePendingCampaigns,
  getStorageStatus,
};
