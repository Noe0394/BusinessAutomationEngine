const fs = require('fs');
const path = require('path');
const githubStore = require('../githubStore');
const whatsapp = require('./whatsapp');
const { CampaignEngine, listTenantsWithPendingCampaigns } = require('../queues/campaignEngine');

// Registre des instances WhatsApp par tenant — le cœur de l'isolation
// stricte demandée : chaque clé de licence obtient sa propre instance
// (adapters/whatsapp.js#createSession) et son propre moteur de campagne
// (queues/campaignEngine.js), jamais partagés entre deux clés. Le mot de
// passe admin obtient lui aussi son propre tenant fixe (ADMIN_TENANT_ID),
// distinct de toute clé de licence.
const ADMIN_TENANT_ID = '__admin__';

const tenants = new Map(); // tenantId assaini -> { session, campaignEngine, initStarted }

function sanitizeTenantId(rawId) {
  const cleaned = String(rawId || '').trim().replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned || 'unknown';
}

function getOrCreate(rawTenantId) {
  const tenantId = sanitizeTenantId(rawTenantId);
  if (!tenants.has(tenantId)) {
    const session = whatsapp.createSession(tenantId);
    const campaignEngine = new CampaignEngine(tenantId, session);
    tenants.set(tenantId, { session, campaignEngine, initStarted: false });
  }
  return tenants.get(tenantId);
}

// Connexion paresseuse : une instance WhatsApp n'est démarrée (restauration
// des creds + connect()) qu'à la première requête d'un tenant donné, pas au
// démarrage du serveur pour toutes les clés existantes — avec potentiellement
// des dizaines de clés émises mais inactives, ouvrir un socket Baileys pour
// chacune au boot gaspillerait des ressources pour rien. idempotent : les
// requêtes concurrentes d'un même tenant ne déclenchent qu'un seul connect().
function ensureConnected(entry) {
  if (entry.initStarted) return;
  entry.initStarted = true;
  entry.session
    .restoreSessionFromRemote()
    .catch((err) => {
      console.error(`Erreur lors de la restauration de la session WhatsApp (tenant "${entry.session.tenantId}") depuis GitHub :`, err.message);
    })
    .finally(() => {
      entry.session.connect().catch((err) => {
        console.error(`Erreur lors de l'initialisation de l'adaptateur WhatsApp (tenant "${entry.session.tenantId}") :`, err.message);
      });
    });
}

// À utiliser par le middleware Express (voir index.js#attachWhatsapp) : le
// tenant d'une requête est soit l'admin (mot de passe admin, pas de
// restriction de module), soit la clé de licence fournie — jamais les deux à
// la fois, et jamais partagé entre deux clés différentes.
function getSessionForRequest(req) {
  const rawTenantId = req.isAdmin ? ADMIN_TENANT_ID : req.licenseKey;
  const entry = getOrCreate(rawTenantId);
  ensureConnected(entry);
  return entry;
}

// ---------- Migration de l'ancienne session globale (avant cette refonte) ----------
// Avant cette version, tout le serveur partageait une seule session WhatsApp
// (auth_info_baileys/creds.json en local, whatsapp_auth.json sur GitHub). On
// rattache cette session historique au tenant admin plutôt que de la perdre
// silencieusement — c'est un choix conservateur : n'importe quelle clé de
// licence pouvait déjà s'en servir avant la correction, donc la rattacher au
// tenant admin (qui reste le seul accès "propriétaire" du système) ne réduit
// aucun accès légitime, et évite de forcer un re-scan de QR non nécessaire
// pour le compte WhatsApp déjà en service.
async function migrateLegacyLocalAuth() {
  const legacyCredsPath = path.join(whatsapp.AUTH_DIR_BASE, 'creds.json');
  const adminDir = path.join(whatsapp.AUTH_DIR_BASE, ADMIN_TENANT_ID);

  if (!fs.existsSync(legacyCredsPath) || fs.existsSync(path.join(adminDir, 'creds.json'))) {
    return;
  }

  try {
    const tmpDir = `${whatsapp.AUTH_DIR_BASE}__legacy_migrate_tmp`;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.renameSync(whatsapp.AUTH_DIR_BASE, tmpDir);
    fs.mkdirSync(whatsapp.AUTH_DIR_BASE, { recursive: true });
    fs.renameSync(tmpDir, adminDir);
    console.log('Session WhatsApp locale historique (partagée) migrée vers le tenant admin.');
  } catch (err) {
    console.error('Migration locale de la session WhatsApp historique échouée (sans impact si GITHUB_TOKEN est configuré) :', err.message);
  }
}

async function migrateLegacyRemoteAuth() {
  const legacyStore = githubStore.createStore(process.env.GITHUB_WHATSAPP_AUTH_PATH || 'whatsapp_auth.json');
  if (!legacyStore.enabled) return;

  try {
    const remote = await legacyStore.fetchRemote();
    if (!remote || !remote.content) return;

    const remoteDir = process.env.GITHUB_WHATSAPP_AUTH_DIR || 'whatsapp_auth';
    const adminStore = githubStore.createStore(`${remoteDir}/${ADMIN_TENANT_ID}.json`);
    const existing = await adminStore.fetchRemote();
    if (existing && existing.content) return; // le tenant admin a déjà sa propre session

    await adminStore.pushRemote(remote.content);
    console.log(`Session WhatsApp distante historique (partagée) migrée vers ${remoteDir}/${ADMIN_TENANT_ID}.json.`);
  } catch (err) {
    console.error('Migration distante de la session WhatsApp historique échouée :', err.message);
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
// une campagne encore "running"/"paused" au moment de l'arrêt précédent du
// process (redéploiement, crash), l'envoi en arrière-plan exactement là où
// il s'était arrêté — sans action requise de l'utilisateur.
async function bootResumePendingCampaigns() {
  const tenantIds = listTenantsWithPendingCampaigns();
  for (const tenantId of tenantIds) {
    const entry = getOrCreate(tenantId);
    ensureConnected(entry);
    entry.campaignEngine.resumeIfPending();
  }
  if (tenantIds.length > 0) {
    console.log(`Reprise automatique de ${tenantIds.length} campagne(s) WhatsApp interrompue(s) par le redémarrage.`);
  }
}

// Panneau admin (/api/admin/storage-status) : conserve la forme plate
// historique (enabled/repo/branch/lastPushAt/lastPushOk/lastPushError) que
// public/admin.html sait déjà afficher — repo/branch sont communs à tous les
// tenants (même dépôt GitHub, un fichier différent par tenant), donc
// affichés une seule fois ; lastPushOk/lastPushError/lastPushAt sont agrégés
// (le pire statut l'emporte) puisqu'il n'y a plus UNE session mais une par
// tenant actif. Le détail par tenant reste disponible sous "tenants" pour une
// évolution future de l'UI, sans rien casser côté existant.
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
