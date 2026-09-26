const fs = require('fs');
const path = require('path');
const whatsapp = require('./whatsapp');
const sessionRegulator = require('./sessionRegulator');
const { CampaignEngine, listTenantsWithPendingCampaigns } = require('../queues/campaignEngine');
const platformOrchestrator = require('../ai-engine/platformOrchestrator');
const githubStore = require('../githubStore');
const secretVault = require('../ai-engine/secretVault');

// Registre des instances WhatsApp par tenant — le cœur de l'isolation
// stricte demandée : chaque clé de licence obtient sa propre instance
// (adapters/whatsapp.js#createSession) et son propre moteur de campagne
// (queues/campaignEngine.js), jamais partagés entre deux clés. Le mot de
// passe admin obtient lui aussi son propre tenant fixe (ADMIN_TENANT_ID),
// distinct de toute clé de licence.
const ADMIN_TENANT_ID = '__admin__';

const tenants = new Map(); // tenantId assaini -> { session, campaignEngine, initStarted }

// Filtrage privé/pro (voir lib/intelligence/message-triage.js) + tuteur
// pédagogique auto — callback UNIQUE, réglé une fois au démarrage par
// index.js (setIncomingMessageHandler ci-dessous), jamais un require direct
// de lib/intelligence/* ici : ce module reste volontairement découplé de la
// couche intelligence, comme le reste de adapters/ (voir onIncomingMessage,
// déjà utilisé par queues/campaignEngine.js pour la pause de campagne —
// ceci est un DEUXIÈME abonné indépendant, pas un remplacement).
let incomingMessageHandler = null;
function setIncomingMessageHandler(fn) {
  incomingMessageHandler = typeof fn === 'function' ? fn : null;
}

// Activité humaine (l'utilisateur écrit lui-même depuis son téléphone) : callback unique réglé par index.js.
let historyMessageHandler = null;
function setHistoryMessageHandler(fn) {
  historyMessageHandler = typeof fn === 'function' ? fn : null;
}
let outgoingMessageHandler = null;
function setOutgoingMessageHandler(fn) {
  outgoingMessageHandler = typeof fn === 'function' ? fn : null;
}
// Canal propriétaire : message écrit par l'utilisateur dans sa propre conversation (self-chat) -> Chat Intelligent.
let ownerMessageHandler = null;
function setOwnerMessageHandler(fn) {
  ownerMessageHandler = typeof fn === 'function' ? fn : null;
}

function sanitizeTenantId(rawId) {
  const cleaned = String(rawId || '').trim().replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned || 'unknown';
}

// Peut lever sessionRegulator.SessionLimitError si la limite globale de
// sessions simultanées (voir adapters/sessionRegulator.js) est atteinte et
// qu'aucune session n'est éligible à l'éviction — à traiter par l'appelant
// (voir attachWhatsapp dans index.js) en refusant poliment la connexion
// plutôt que de laisser planter la requête.
function getOrCreate(rawTenantId) {
  const tenantId = sanitizeTenantId(rawTenantId);
  if (!tenants.has(tenantId)) {
    sessionRegulator.ensureCapacity('whatsapp', tenantId);
    const session = whatsapp.createSession(tenantId);
    const campaignEngine = new CampaignEngine(
      tenantId,
      session,
      () => sessionRegulator.touch('whatsapp', tenantId),
      platformOrchestrator.onCampaignNetworkStatusChange,
    );
    // Voir adapters/whatsapp.js#onAccountReset et CampaignEngine#reset : dès
    // que le NUMÉRO WhatsApp connecté sous ce tenant change (déconnexion
    // manuelle, ré-appairage, révocation détectée), la campagne de l'ancien
    // numéro est annulée proprement plutôt que de verrouiller le nouveau.
    session.onAccountReset(() => campaignEngine.reset());
    if (typeof session.onIncomingMessage === 'function') {
      session.onIncomingMessage((msg) => {
        if (!incomingMessageHandler) return;
        Promise.resolve(incomingMessageHandler({ channel: 'WHATSAPP', tenantId, session, msg })).catch((err) => {
          console.error(`Erreur dans le filtrage privé/pro WhatsApp (tenant "${tenantId}") :`, err.message);
        });
      });
    }
    if (typeof session.onHistoryMessage === 'function') {
      session.onHistoryMessage((msg) => {
        if (!historyMessageHandler) return;
        Promise.resolve(historyMessageHandler({ channel: 'WHATSAPP', tenantId, session, msg })).catch((err) => {
          console.error(`Erreur d'enregistrement d'un message historique WhatsApp (tenant "${tenantId}") :`, err.message);
        });
      });
    }
    if (typeof session.onOwnerMessage === 'function') {
      session.onOwnerMessage((msg) => {
        if (!ownerMessageHandler) return;
        Promise.resolve(ownerMessageHandler({ channel: 'WHATSAPP', tenantId, session, msg })).catch((err) => {
          console.error(`Erreur du canal propriétaire WhatsApp (tenant "${tenantId}") :`, err.message);
        });
      });
    }
    if (typeof session.onOutgoingMessage === 'function') {
      session.onOutgoingMessage((msg) => {
        if (!outgoingMessageHandler) return;
        Promise.resolve(outgoingMessageHandler({ channel: 'WHATSAPP', tenantId, msg })).catch(() => {});
      });
    }
    tenants.set(tenantId, { session, campaignEngine, initStarted: false });
    sessionRegulator.register('whatsapp', tenantId, {
      protected: tenantId === ADMIN_TENANT_ID || require('../ai-engine/alwaysOn').isAlwaysOn(tenantId),
      hasActiveCampaign: () => (campaignEngine.getStatus() || {}).status === 'running',
      // NE JAMAIS annuler une campagne juste parce que sa session est
      // libérée (limite de sessions simultanées atteinte, voir
      // adapters/sessionRegulator.js) : on la met en pause (destinataires
      // restants et progression conservés) AVANT de couper la connexion —
      // voir CampaignEngine#pauseForShutdown. Une reprise ultérieure (bouton
      // "Reprendre", ou resumeIfPending() ci-dessous à la prochaine
      // reconnexion de ce tenant) la continuera exactement là où elle en
      // était.
      dispose: () => {
        campaignEngine.pauseForShutdown();
        session.dispose();
      },
      onEvicted: () => tenants.delete(tenantId),
    });
    // Restaure une campagne persistée (même tenant, instance précédente
    // évincée ou process redémarré sans que bootResumePendingCampaigns() ne
    // soit passé par ce tenant) : voir CampaignEngine#resumeIfPending, qui
    // ne relance jamais l'envoi automatiquement (restaure en pause) et est
    // idempotent (sans effet si ce tenant a déjà une campagne en mémoire).
    // Fire-and-forget : ne doit jamais bloquer la création de la session.
    campaignEngine.resumeIfPending().catch((err) => {
      console.error(`Erreur lors de la reprise automatique de campagne WhatsApp (tenant "${tenantId}") :`, err.message);
    });
  }
  sessionRegulator.touch('whatsapp', tenantId);
  return tenants.get(tenantId);
}

// Utilisé par index.js pour mettre en pause (jamais annuler) toute campagne
// active lors d'un arrêt propre du process (SIGTERM envoyé par Render avant
// un redéploiement) — voir CampaignEngine#pauseForShutdown.
function listActiveEntries() {
  return Array.from(tenants.values());
}

// Session déjà instanciée d'un tenant, SANS en créer ni la connecter (contrairement à getOrCreate) : utilisé pour
// livrer une alerte au propriétaire seulement si son WhatsApp est réellement actif.
function peek(rawTenantId) {
  return tenants.get(sanitizeTenantId(rawTenantId)) || null;
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
      console.error(`Erreur lors de la v?rification du stockage de la session WhatsApp (tenant "${entry.session.tenantId}") :`, err.message);
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
  // Les anciens fichiers GitHub ne contiennent que creds.json. Ils n'incluent
  // pas les cl?s Signal et ne peuvent pas restaurer une session Baileys s?re.
  // Ne jamais les migrer vers un tenant ni les utiliser pour reconnecter.
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
  // listTenantsWithPendingCampaigns() et resumeIfPending() vérifient GitHub
  // en plus du disque local (voir queues/campaignEngine.js) : nécessaire
  // pour retrouver les campagnes en cours après un vrai redéploiement Render,
  // qui vide le disque éphémère avant que ce code ne s'exécute.
  const tenantIds = await listTenantsWithPendingCampaigns();
  for (const tenantId of tenantIds) {
    const entry = getOrCreate(tenantId);
    ensureConnected(entry);
    await entry.campaignEngine.resumeIfPending();
  }
  if (tenantIds.length > 0) {
    console.log(`Reprise automatique de ${tenantIds.length} campagne(s) WhatsApp interrompue(s) par le redémarrage.`);
  }
}

// Liste tous les tenants ayant déjà une session WhatsApp appairée (creds.json
// non vide, en local et/ou sur GitHub) — contrairement à
// listTenantsWithPendingCampaigns() ci-dessus, aucune condition sur une
// campagne en cours : sert à reconnecter au démarrage TOUTE clé de licence
// déjà appairée, pas seulement celles avec un envoi actif (voir
// bootReconnectAllPairedTenants juste en dessous).
async function listTenantsWithSavedSession() {
  const tenantIds = [];
  let entries = [];
  try {
    entries = fs.readdirSync(whatsapp.AUTH_DIR_BASE, { withFileTypes: true });
  } catch (err) {
    return tenantIds;
  }

  // Seuls les dossiers de session qui existent sur le stockage AUTH_DIR sont
  // des candidats de reconnexion. A remote creds.json without its Signal keys is not a usable session.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const credsPath = path.join(whatsapp.AUTH_DIR_BASE, entry.name, 'creds.json');
    try {
      if (fs.statSync(credsPath).size > 0) tenantIds.push(entry.name);
    } catch (err) {
      // No local state exists for this tenant.
    }
  }
  if (githubStore.enabled && secretVault.isEncryptionConfigured()) {
    const known = new Set(tenantIds);
    const remoteDir = process.env.GITHUB_WHATSAPP_AUTH_DIR || 'whatsapp_auth';
    const remoteFiles = await githubStore.listDirectory(remoteDir, { strict: process.env.RENDER === 'true' || !!process.env.RENDER_SERVICE_ID || !!process.env.RENDER_EXTERNAL_URL });
    for (const filename of remoteFiles) {
      if (!filename.endsWith('.json')) continue;
      const tenantId = filename.replace(/\.json$/, '');
      if (known.has(tenantId)) continue;
      try {
        const remote = await githubStore.createStore(`${remoteDir}/${filename}`).fetchRemote();
        let content = remote && remote.content;
        if (!content && remote && remote.tooLarge && remote.sha) {
          const blob = await githubStore.fetchLargeFile(remote.sha);
          content = blob ? blob.toString('utf8') : null;
        }
        const snapshot = content ? JSON.parse(content) : null;
        if (snapshot && snapshot._cyrusEncrypted === 1 && snapshot.format === 'baileys-auth-dir-v1') {
          tenantIds.push(tenantId);
          known.add(tenantId);
        }
      } catch (err) {
        console.error(`État de session WhatsApp distant illisible pour un tenant :`, err.message);
      }
    }
  }
  return tenantIds;
}

// Reconnecte au démarrage TOUTE clé de licence ayant déjà une session
// WhatsApp appairée (pas seulement admin ou celles avec une campagne en
// cours — voir bootResumePendingCampaigns ci-dessus) : sans ça, une clé sans
// campagne active mais bien connectée avant un redéploiement Render restait
// affichée "Déconnectée" jusqu'à ce que son propriétaire recharge le
// dashboard (reconnexion paresseuse, voir ensureConnected) — demandé
// explicitement par l'utilisateur suite à cette confusion en production le
// 2026-09-07. Contrepartie assumée : un socket Baileys est rouvert pour
// CHAQUE clé déjà appairée dès le démarrage, même inactive depuis longtemps
// — plus de charge mémoire/CPU si de nombreuses clés sont en circulation
// (voir le commentaire original sur ensureConnected qui documentait ce
// compromis dans l'autre sens). Le tenant admin (déjà connecté par
// initAdminSession) et les tenants avec campagne en cours (déjà connectés
// par bootResumePendingCampaigns) sont simplement reconnectés une seconde
// fois sans effet grâce à l'idempotence de ensureConnected
// (entry.initStarted).
// Délai entre deux connect() successifs pendant la reconnexion de masse au
// démarrage : sans lui, tous les tenants appairés ouvraient leur socket
// Baileys dans la même boucle synchrone, donc en quelques millisecondes
// depuis la MÊME IP sortante du VM — un pattern que WhatsApp traite comme
// abusif (voir l'incident de blocage d'IP déjà documenté sur Render,
// section "État actuel du projet" de CLAUDE.md) et qui provoquait des
// révocations (code 401) en rafale sur plusieurs tenants distincts au
// redémarrage, observé en production le 2026-09-22 (4 tenants sur 5
// révoqués quasi simultanément). L'étalement imite un rythme de connexion
// plus organique, sans rien changer au protocole lui-même.
const BOOT_RECONNECT_STAGGER_MS = Math.max(0, parseInt(process.env.WHATSAPP_BOOT_RECONNECT_STAGGER_MS, 10) || 4000);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function bootReconnectAllPairedTenants() {
  const tenantIds = await listTenantsWithSavedSession();
  let reconnected = 0;
  for (const tenantId of tenantIds) {
    if (tenantId === ADMIN_TENANT_ID) continue;
    if (reconnected > 0) await delay(BOOT_RECONNECT_STAGGER_MS);
    ensureConnected(getOrCreate(tenantId));
    reconnected += 1;
  }
  if (reconnected > 0) {
    console.log(`Reconnexion automatique de ${reconnected} session(s) WhatsApp déjà appairée(s) après redémarrage (étalée sur ${BOOT_RECONNECT_STAGGER_MS}ms entre chaque).`);
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
  return {
    enabled: githubStore.enabled && secretVault.isEncryptionConfigured(),
    repo: null,
    branch: null,
    lastPushOk: null,
    lastPushError: 'La session WhatsApp exige la persistance du dossier AUTH_DIR complet.',
    lastPushAt: null,
    activeTenants: list.length,
    tenants: list,
  };
}

async function flushAuthSnapshots() {
  const entries = Array.from(tenants.values());
  const results = await Promise.allSettled(entries.map((entry) => (
    entry.session && typeof entry.session.persistSession === 'function' ? entry.session.persistSession() : null
  )));
  return { tenants: entries.length, failed: results.filter((item) => item.status === 'rejected' || item.value === false).length };
}

// Ce numéro est-il celui d'un AUTRE compte Cyrus connecté sur ce serveur ? (anti-boucle entre deux comptes : voir ai-engine/botSignature.js)
function isNumberOfOtherTenant(digits, exceptTenant) {
  const except = sanitizeTenantId(exceptTenant);
  for (const [id, entry] of tenants) {
    if (id === except || !entry || !entry.session || typeof entry.session.getConnectedNumber !== 'function') continue;
    try { if (String(entry.session.getConnectedNumber() || '') === String(digits)) return true; } catch (e) { /* session en reconnexion */ }
  }
  return false;
}

module.exports = {
  isNumberOfOtherTenant,
  ensureConnected,
  ADMIN_TENANT_ID,
  sanitizeTenantId,
  getOrCreate,
  getSessionForRequest,
  initAdminSession,
  bootResumePendingCampaigns,
  bootReconnectAllPairedTenants,
  flushAuthSnapshots,
  listActiveEntries,
  peek,
  getStorageStatus,
  setIncomingMessageHandler,
  setOutgoingMessageHandler,
  setOwnerMessageHandler,
  setHistoryMessageHandler,
};
