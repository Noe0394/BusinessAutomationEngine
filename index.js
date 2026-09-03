const crypto = require('crypto');
if (!globalThis.crypto) {
  globalThis.crypto = crypto.webcrypto || crypto;
}

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const XLSX = require('xlsx');
const QRCode = require('qrcode');
const whatsapp = require('./adapters/whatsapp');
const FacebookMessengerAdapter = require('./adapters/facebook');
const TelegramAdapter = require('./adapters/telegram');
const MediaPublisherAdapter = require('./adapters/media_publisher');
const licenses = require('./licenses');
const oauthConfig = require('./oauth_config');

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '@CYRUS2026';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
// Les vidéos (YouTube/Instagram/TikTok) sont bien plus lourdes que les
// médias WhatsApp/Telegram/Messenger : instance multer dédiée, limite plus
// large. Reste en mémoire (multer.memoryStorage) comme le reste de l'app :
// à surveiller sur une instance Render à faible RAM avec de grosses vidéos.
const videoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 200 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^video\/(mp4|quicktime)$/.test(file.mimetype)) {
      return cb(null, true);
    }
    return cb(new Error('INVALID_VIDEO_TYPE'));
  },
});
const DASHBOARD_PATH = path.join(__dirname, 'public', 'dashboard.html');
const ADMIN_PORTAL_PATH = path.join(__dirname, 'public', 'admin.html');
const facebook = new FacebookMessengerAdapter();
const telegram = new TelegramAdapter();
const mediaPublisher = new MediaPublisherAdapter();

if (!process.env.ADMIN_PASSWORD) {
  console.warn('ADMIN_PASSWORD non défini : utilisation du mot de passe par défaut codé en dur. Définissez cette variable d\'environnement avant tout déploiement public.');
}

// ---------- Portail admin : instructions d'accès (console + fichier) ----------
// Pas un secret (juste l'URL publique de ce déploiement) : valeur de repli
// sûre à coder en dur, contrairement aux identifiants OAuth (voir
// oauth_config.js). Reste prioritairement piloté par la variable
// d'environnement PUBLIC_BASE_URL si elle est définie sur Render.
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || 'https://business-automation-engine.onrender.com').replace(/\/$/, '');
const ADMIN_PORTAL_URL = `${PUBLIC_BASE_URL}/admin-secret-portal`;

function printAndWriteAdminAccessInstructions() {
  const banner = [
    '========================================================================',
    '  ACCES ADMINISTRATEUR — Orchestrateur multi-plateformes',
    '========================================================================',
    `  URL du portail secret : ${ADMIN_PORTAL_URL}`,
    `  Mot de passe           : ${ADMIN_PASSWORD}`,
    '',
    '  Depuis ce portail : générer des clés de licence (durée + modules),',
    '  activer/désactiver des clés, consulter la consommation et le nombre',
    "  d'utilisateurs actuellement connectés.",
    '',
    '  SECURITE :',
    '  - Ne partagez cette URL et ce mot de passe avec personne.',
    "  - Changez ADMIN_PASSWORD en variable d'environnement dès que possible",
    '    (la valeur ci-dessus est le mot de passe par défaut codé en dur si',
    '    ADMIN_PASSWORD n\'est pas définie).',
    '  - Le fichier ADMIN_ACCESS.md généré à la racine du projet contient ces',
    '    informations en clair : ne le committez jamais (déjà exclu via',
    '    .gitignore) et supprimez-le si vous partagez ce dossier.',
    '========================================================================',
  ].join('\n');

  console.log(banner);

  const fileContent = `# Accès administrateur

**Généré automatiquement au démarrage du serveur — ne pas committer ce fichier.**

- **URL du portail secret :** ${ADMIN_PORTAL_URL}
- **Mot de passe :** \`${ADMIN_PASSWORD}\`

## Fonctionnalités du portail

- Génération de clés de licence (durée d'expiration + modules autorisés parmi WhatsApp, Facebook, Telegram, Studio Auto-Publication).
- Vue d'ensemble des clés actives/désactivées.
- Surveillance de la consommation (nombre de requêtes) et du nombre d'utilisateurs actuellement connectés.

## Sécurité

- Ne partagez cette URL et ce mot de passe avec personne.
- Changez \`ADMIN_PASSWORD\` en variable d'environnement dès que possible — la valeur ci-dessus est un mot de passe par défaut codé en dur si \`ADMIN_PASSWORD\` n'est pas définie côté serveur.
- Ce fichier est exclu de Git via \`.gitignore\`. Supprimez-le si vous partagez ce dossier avec quelqu'un d'autre.
- Si \`PUBLIC_BASE_URL\` n'est pas définie, l'URL ci-dessus pointe vers \`localhost\` et ne sera valide que sur cette machine.
`;

  try {
    fs.writeFileSync(path.join(__dirname, 'ADMIN_ACCESS.md'), fileContent, 'utf8');
  } catch (err) {
    console.error('Impossible d\'écrire ADMIN_ACCESS.md :', err.message);
  }
}

app.use(express.json());

// Accès admin strict : réservé au panneau de gestion des licences.
function requireAdmin(req, res, next) {
  const provided = req.get('x-admin-password') || req.query.password;

  if (provided && provided === ADMIN_PASSWORD) {
    req.isAdmin = true;
    return next();
  }

  return res.status(401).json({ error: 'Accès administrateur requis.' });
}

// Accès aux fonctionnalités du dashboard (WhatsApp/Facebook/Telegram/Studio) :
// accepté soit avec le mot de passe administrateur (accès total, sans
// restriction de module), soit avec une clé de licence valide, active et non
// expirée — dans ce cas req.allowedModules porte la liste des modules
// autorisés pour cette clé, vérifiée ensuite par requireModule().
async function requireAccess(req, res, next) {
  const providedPassword = req.get('x-admin-password') || req.query.password;

  if (providedPassword && providedPassword === ADMIN_PASSWORD) {
    req.isAdmin = true;
    req.allowedModules = null; // null = pas de restriction (admin)
    return next();
  }

  const providedKey = req.get('x-license-key') || req.query.licenseKey;
  const deviceId = req.get('x-device-id') || req.query.deviceId;

  if (providedKey) {
    const result = await licenses.verifyKey(providedKey, deviceId);
    if (result.valid) {
      req.isAdmin = false;
      req.licenseKey = providedKey;
      req.allowedModules = result.license.allowedModules;
      licenses.recordUsage(providedKey);
      return next();
    }
    if (result.reason === 'DEVICE_MISMATCH') {
      return res.status(403).json({
        error: 'Cette clé de licence est déjà utilisée sur un autre appareil. Chaque appareil nécessite sa propre clé.',
      });
    }
  }

  return res.status(401).json({
    error: 'Authentification requise (mot de passe administrateur ou clé de licence valide).',
  });
}

// À utiliser après requireAccess sur les routes propres à un module
// (whatsapp/facebook/telegram/studio_video) : bloque avec 403 si la clé de
// licence utilisée n'inclut pas ce module. Sans effet pour l'admin
// (req.allowedModules === null signifie "aucune restriction").
function requireModule(moduleName) {
  return (req, res, next) => {
    if (req.allowedModules === null || req.allowedModules === undefined) {
      return next();
    }
    if (Array.isArray(req.allowedModules) && req.allowedModules.includes(moduleName)) {
      return next();
    }
    return res.status(403).json({
      error: `Votre clé de licence n'inclut pas le module "${moduleName}".`,
    });
  };
}

// ---------- Anti-CSRF pour les flux OAuth (Google/TikTok/Facebook) ----------
// Le paramètre "state" standard OAuth : généré au moment où l'utilisateur
// clique sur "Se connecter", vérifié quand le fournisseur redirige vers notre
// callback (qui ne peut pas porter nos en-têtes d'auth habituels puisque
// c'est une navigation top-level initiée par le fournisseur, pas un fetch).
const oauthStates = new Map(); // state -> expiresAt (ms)
const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

function createOAuthState() {
  const state = crypto.randomBytes(16).toString('hex');
  oauthStates.set(state, Date.now() + OAUTH_STATE_TTL_MS);
  return state;
}

function consumeOAuthState(state) {
  const expiresAt = oauthStates.get(state);
  oauthStates.delete(state);
  return Boolean(expiresAt) && expiresAt > Date.now();
}

function replaceVariables(template, row) {
  return String(template).replace(/{(\w+)}/g, (match, key) => (
    row[key] !== undefined && row[key] !== null ? String(row[key]) : match
  ));
}

function normalizeJid(telephone) {
  const raw = String(telephone).trim();
  if (raw.includes('@')) {
    return raw;
  }
  const digits = raw.replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

// Délai non-bloquant : setTimeout laisse la boucle d'événements de Node
// libre pendant l'attente, donc le serveur reste réactif (health checks,
// heartbeat WebSocket de Baileys, autres requêtes HTTP) même en pleine campagne.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

let currentCampaign = null;

async function interruptibleSleep(ms, shouldStop) {
  const tickMs = 300;
  let elapsed = 0;
  while (elapsed < ms) {
    if (shouldStop()) return;
    const step = Math.min(tickMs, ms - elapsed);
    await sleep(step);
    elapsed += step;
  }
}

function markRemainingInterrupted(campaign, recipients, fromIndex) {
  for (let j = fromIndex; j < recipients.length; j += 1) {
    campaign.results.push({
      to: normalizeJid(recipients[j]),
      status: 'interrupted',
      timestamp: new Date().toISOString(),
    });
  }
  campaign.status = 'stopped';
  campaign.paused = false;
  campaign.finishedAt = new Date().toISOString();
}

// En cas de coupure réseau/Baileys en pleine campagne, on ne marque pas les
// destinataires restants comme échoués : on met la campagne en pause (le
// statut public reste "running" pour ne pas casser le suivi côté client) et
// on attend que la connexion revienne avant de reprendre l'envoi.
async function waitForConnection(campaign) {
  if (whatsapp.isConnected()) {
    return;
  }

  campaign.paused = true;
  console.log('Campagne: mise en pause — connexion WhatsApp perdue, en attente de reconnexion...');

  while (!whatsapp.isConnected() && !campaign.stopRequested) {
    await sleep(1000);
  }

  campaign.paused = false;
  if (!campaign.stopRequested) {
    console.log('Campagne: reprise après reconnexion WhatsApp.');
  }
}

async function runCampaignQueue(campaign, recipients, message, options = {}) {
  const { delaySeconds, batchSize, media } = options;
  const batch = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : recipients.length;

  for (let i = 0; i < recipients.length; i += 1) {
    if (campaign.stopRequested) {
      markRemainingInterrupted(campaign, recipients, i);
      console.log('Campagne: interrompue par l\'utilisateur.');
      return;
    }

    await waitForConnection(campaign);

    if (campaign.stopRequested) {
      markRemainingInterrupted(campaign, recipients, i);
      console.log('Campagne: interrompue par l\'utilisateur.');
      return;
    }

    const to = normalizeJid(recipients[i]);
    let status = 'failed';

    try {
      if (media) {
        await whatsapp.sendMedia(to, { ...media, caption: message });
      } else {
        await whatsapp.sendMessage(to, message);
      }
      status = 'delivered';
      campaign.success += 1;
      console.log(`Campagne: message envoyé à ${to} (${i + 1}/${recipients.length}).`);
    } catch (err) {
      campaign.failed += 1;
      console.error(`Campagne: échec de l'envoi à ${to}:`, err);
    }

    campaign.sent += 1;
    campaign.results.push({ to, status, timestamp: new Date().toISOString() });

    if (i < recipients.length - 1 && !campaign.stopRequested) {
      const baseDelayMs = delaySeconds ? delaySeconds * 1000 : randomDelay(8000, 15000);
      const endOfBatch = (i + 1) % batch === 0;
      const delayMs = endOfBatch ? baseDelayMs * 3 : baseDelayMs;
      await interruptibleSleep(delayMs, () => campaign.stopRequested);
    }
  }

  if (campaign.status === 'running') {
    campaign.status = 'completed';
    campaign.finishedAt = new Date().toISOString();
  }

  console.log('Campagne: terminée.');
}

function startCampaign(recipients, message, options = {}) {
  if (currentCampaign && currentCampaign.status === 'running') {
    throw new Error('CAMPAIGN_IN_PROGRESS');
  }

  currentCampaign = {
    total: recipients.length,
    sent: 0,
    success: 0,
    failed: 0,
    status: 'running',
    paused: false,
    stopRequested: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    results: [],
  };

  const campaign = currentCampaign;

  runCampaignQueue(campaign, recipients, message, options).catch((err) => {
    console.error('Erreur pendant la campagne:', err);
    campaign.status = 'stopped';
    campaign.paused = false;
    campaign.finishedAt = new Date().toISOString();
  });

  return campaign;
}

// Campagne de messages directs Telegram vers une liste de contacts importée
// (usernames et/ou numéros de téléphone), distincte de currentCampaign
// (WhatsApp) et de la diffusion groupe/canal existante (/api/telegram/queue)
// : ici chaque destinataire est résolu individuellement via
// telegram.resolveRecipient avant l'envoi. Même modèle stoppable que la
// campagne WhatsApp (pause/stop, suivi de progression).
let currentTelegramDmCampaign = null;

// Fenêtre de délai imposée entre deux envois individuels — non contournable
// depuis le frontend, qui ne peut que choisir un délai fixe ou aléatoire à
// l'intérieur de cette fenêtre (recommandation explicite de l'utilisateur
// pour rester dans un usage raisonnable de l'API Telegram).
const TELEGRAM_DM_MIN_DELAY_MS = 30_000;
const TELEGRAM_DM_MAX_DELAY_MS = 60_000;

function clampTelegramDmDelayMs(ms) {
  if (!Number.isFinite(ms)) return null;
  return Math.min(Math.max(ms, TELEGRAM_DM_MIN_DELAY_MS), TELEGRAM_DM_MAX_DELAY_MS);
}

async function waitForTelegramConnection(campaign) {
  if (telegram.isConnected()) {
    return;
  }

  campaign.paused = true;
  console.log('Campagne Telegram: mise en pause — connexion perdue, en attente de reconnexion...');

  while (!telegram.isConnected() && !campaign.stopRequested) {
    await sleep(1000);
  }

  campaign.paused = false;
  if (!campaign.stopRequested) {
    console.log('Campagne Telegram: reprise après reconnexion.');
  }
}

function markTelegramDmRemainingInterrupted(campaign, recipients, fromIndex) {
  for (let j = fromIndex; j < recipients.length; j += 1) {
    campaign.results.push({ to: recipients[j], status: 'interrupted', timestamp: new Date().toISOString() });
  }
  campaign.status = 'stopped';
  campaign.paused = false;
  campaign.finishedAt = new Date().toISOString();
}

async function runTelegramDmQueue(campaign, recipients, message, options = {}) {
  const { minDelayMs, maxDelayMs, media } = options;

  for (let i = 0; i < recipients.length; i += 1) {
    if (campaign.stopRequested) {
      markTelegramDmRemainingInterrupted(campaign, recipients, i);
      console.log('Campagne Telegram: interrompue par l\'utilisateur.');
      return;
    }

    await waitForTelegramConnection(campaign);

    if (campaign.stopRequested) {
      markTelegramDmRemainingInterrupted(campaign, recipients, i);
      console.log('Campagne Telegram: interrompue par l\'utilisateur.');
      return;
    }

    const identifier = recipients[i];
    let status = 'failed';
    let errorReason = null;

    try {
      const entity = await telegram.resolveRecipient(identifier);
      if (media) {
        await telegram.sendMedia(entity, { ...media, caption: message });
      } else {
        await telegram.sendMessage(entity, message);
      }
      status = 'delivered';
      campaign.success += 1;
      console.log(`Campagne Telegram: message envoyé à ${identifier} (${i + 1}/${recipients.length}).`);
    } catch (err) {
      campaign.failed += 1;
      errorReason = err.message || String(err);
      console.error(`Campagne Telegram: échec de l'envoi à ${identifier}:`, errorReason);
    }

    campaign.sent += 1;
    campaign.results.push({ to: identifier, status, error: errorReason, timestamp: new Date().toISOString() });

    if (i < recipients.length - 1 && !campaign.stopRequested) {
      const delayMs = randomDelay(minDelayMs, maxDelayMs);
      await interruptibleSleep(delayMs, () => campaign.stopRequested);
    }
  }

  if (campaign.status === 'running') {
    campaign.status = 'completed';
    campaign.finishedAt = new Date().toISOString();
  }

  console.log('Campagne Telegram: terminée.');
}

function startTelegramDmCampaign(recipients, message, options = {}) {
  if (currentTelegramDmCampaign && currentTelegramDmCampaign.status === 'running') {
    throw new Error('CAMPAIGN_IN_PROGRESS');
  }

  const { maxPerCycle, media } = options;
  const limitedRecipients = Number.isInteger(maxPerCycle) && maxPerCycle > 0
    ? recipients.slice(0, maxPerCycle)
    : recipients;

  const minDelayMs = clampTelegramDmDelayMs(options.minDelayMs) || TELEGRAM_DM_MIN_DELAY_MS;
  const maxDelayMs = Math.max(clampTelegramDmDelayMs(options.maxDelayMs) || TELEGRAM_DM_MAX_DELAY_MS, minDelayMs);

  currentTelegramDmCampaign = {
    total: limitedRecipients.length,
    truncated: limitedRecipients.length < recipients.length,
    sent: 0,
    success: 0,
    failed: 0,
    status: 'running',
    paused: false,
    stopRequested: false,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    results: [],
  };

  const campaign = currentTelegramDmCampaign;

  runTelegramDmQueue(campaign, limitedRecipients, message, { minDelayMs, maxDelayMs, media }).catch((err) => {
    console.error('Erreur pendant la campagne Telegram:', err);
    campaign.status = 'stopped';
    campaign.paused = false;
    campaign.finishedAt = new Date().toISOString();
  });

  return campaign;
}

async function findGroupByName(name) {
  const groups = await whatsapp.getGroups();
  const needle = name.trim().toLowerCase();
  return groups.find((g) => (g.subject || '').toLowerCase().includes(needle));
}

async function handleNaturalMessage(message) {
  const text = message.trim();
  const lowered = text.toLowerCase();

  if (/liste\s+mes\s+groupes|affiche\s+(les\s+)?groupes|montre\s+(moi\s+)?(les\s+)?groupes|quels?\s+sont\s+mes\s+groupes/.test(lowered)) {
    const groups = await whatsapp.getGroups();
    if (groups.length === 0) {
      return 'Aucun groupe trouvé. Le compte WhatsApp est peut-être encore en cours de synchronisation.';
    }
    const lines = groups.map((g, i) => `${i + 1}. ${g.subject || '(sans nom)'} — ${g.id}`);
    return `Voici vos ${groups.length} groupe(s) :\n${lines.join('\n')}`;
  }

  const participantsMatch = text.match(
    /(?:montre(?:[- ]moi)?\s+les\s+membres\s+du\s+groupe\s+|membres\s+du\s+groupe\s+|participants\s+(?:du\s+groupe\s+|de\s+))(.+)/i,
  );
  if (participantsMatch) {
    const groupName = participantsMatch[1].replace(/[?.!]+$/, '').trim();
    const group = await findGroupByName(groupName);
    if (!group) {
      return `Aucun groupe correspondant à "${groupName}" n'a été trouvé.`;
    }
    const participants = await whatsapp.getGroupParticipants(group.id);
    if (!participants || participants.length === 0) {
      return `Aucun participant trouvé pour le groupe "${group.subject}".`;
    }
    const lines = participants.map((p, i) => `${i + 1}. ${(p.id || '').split('@')[0]}`);
    return `Membres de "${group.subject}" (${participants.length}) :\n${lines.join('\n')}`;
  }

  const campaignMatch = text.match(
    /^envoie\s+(.+?)\s+au\s+groupe\s+(.+?)(?:\s+avec\s+un\s+délai\s+de\s+(\d+)\s*(?:secondes?|s)?)?[.!]?$/i,
  );
  if (campaignMatch) {
    const [, campaignMessage, groupNameRaw, delaySecondsRaw] = campaignMatch;
    const groupName = groupNameRaw.replace(/[?.!]+$/, '').trim();
    const group = await findGroupByName(groupName);
    if (!group) {
      return `Aucun groupe correspondant à "${groupName}" n'a été trouvé.`;
    }
    const participants = await whatsapp.getGroupParticipants(group.id);
    if (!participants || participants.length === 0) {
      return `Le groupe "${group.subject}" ne contient aucun participant à contacter.`;
    }

    const recipients = participants.map((p) => p.id);
    const delaySeconds = delaySecondsRaw ? parseFloat(delaySecondsRaw) : undefined;

    try {
      startCampaign(recipients, campaignMessage.trim(), { delaySeconds });
    } catch (err) {
      if (err.message === 'CAMPAIGN_IN_PROGRESS') {
        return 'Une campagne est déjà en cours. Attendez sa fin ou interrompez-la avant d\'en lancer une nouvelle.';
      }
      throw err;
    }

    const delayLabel = delaySeconds ? `${delaySeconds}s fixe` : '8-15s aléatoire';
    return `🚀 Campagne lancée sur le groupe "${group.subject}" (${recipients.length} membre(s)). Délai entre chaque envoi : ${delayLabel}.`;
  }

  return 'Je n\'ai pas compris cette demande. Essayez par exemple : "liste mes groupes", "participants du groupe Famille", ou "envoie Bonjour ! au groupe Famille avec un délai de 10 secondes".';
}

async function runCampaign(contacts, minDelayMs, maxDelayMs) {
  for (let i = 0; i < contacts.length; i += 1) {
    const row = contacts[i];

    if (!row.telephone || !row.message) {
      console.warn(`Campagne: ligne ${i + 1} ignorée (champs "telephone" et "message" requis).`);
      continue;
    }

    const to = normalizeJid(row.telephone);
    const text = replaceVariables(row.message, row);

    try {
      await whatsapp.sendMessage(to, text);
      console.log(`Campagne: message envoyé à ${to} (${i + 1}/${contacts.length}).`);
    } catch (err) {
      console.error(`Campagne: échec de l'envoi à ${to}:`, err);
    }

    if (i < contacts.length - 1) {
      const delay = randomDelay(minDelayMs, maxDelayMs);
      console.log(`Campagne: attente de ${Math.round(delay / 1000)}s avant le prochain envoi...`);
      await sleep(delay);
    }
  }

  console.log('Campagne: terminée.');
}

let currentPublishJob = null;

function createPublishJob(platforms) {
  currentPublishJob = {
    startedAt: new Date().toISOString(),
    finishedAt: null,
    platforms: platforms.reduce((acc, p) => {
      acc[p] = { status: 'pending', message: 'En attente...', result: null, error: null };
      return acc;
    }, {}),
  };
  return currentPublishJob;
}

function isPublishJobActive(job) {
  return Boolean(job) && Object.values(job.platforms).some((p) => p.status === 'pending' || p.status === 'in_progress');
}

async function runPublishTask(job, platform, taskFn) {
  const track = job.platforms[platform];
  try {
    const result = await taskFn((message) => {
      track.status = 'in_progress';
      track.message = message;
    });
    track.status = 'done';
    track.result = result;
  } catch (err) {
    track.status = 'error';
    track.message = `Échec : ${err.message || err}`;
    track.error = err.message || String(err);
    console.error(`Publication ${platform}: échec:`, err?.response?.data || err.message || err);
  }
}

async function runPublishJob(job, { buffer, mimetype, title, caption, scheduleAt }, platforms) {
  const tasks = [];

  if (platforms.includes('youtube')) {
    tasks.push(runPublishTask(job, 'youtube', (onStatus) => (
      mediaPublisher.publishYouTubeShort({ buffer, title, description: caption, scheduleAt }, onStatus)
    )));
  }

  if (platforms.includes('instagram')) {
    tasks.push(runPublishTask(job, 'instagram', (onStatus) => {
      const token = mediaPublisher.registerTempVideo(buffer, mimetype);
      return mediaPublisher.publishInstagramReel({ token, caption, scheduleAt }, onStatus);
    }));
  }

  if (platforms.includes('tiktok')) {
    tasks.push(runPublishTask(job, 'tiktok', (onStatus) => (
      mediaPublisher.publishTikTokVideo({ buffer, title, scheduleAt }, onStatus)
    )));
  }

  await Promise.allSettled(tasks);
  job.finishedAt = new Date().toISOString();
}

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.get(['/', '/dashboard'], (req, res) => {
  res.sendFile(DASHBOARD_PATH);
});

// Route volontairement non référencée dans la navigation du dashboard client
// ("portail caché") — protégée par mot de passe côté page ET par requireAdmin
// sur chaque appel API qu'elle déclenche. Sert le fichier explicitement, sans
// aucune redirection : la page elle-même affiche son propre écran de
// connexion si aucun jeton admin valide n'est présent côté client.
app.get(['/admin-secret-portal', '/admin'], (req, res) => {
  res.sendFile(ADMIN_PORTAL_PATH);
});

app.post('/api/login', (req, res) => {
  const { password } = req.body || {};

  if (password && password === ADMIN_PASSWORD) {
    return res.status(200).json({ success: true, role: 'admin', allowedModules: null });
  }

  return res.status(401).json({ error: 'Mot de passe incorrect.' });
});

// Endpoint de connexion dédié au portail admin isolé (distinct de /api/login
// utilisé par le dashboard client), même logique de vérification.
app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};

  if (password && password === ADMIN_PASSWORD) {
    return res.status(200).json({ success: true });
  }

  return res.status(401).json({ error: 'Mot de passe incorrect.' });
});

app.post('/api/auth/verify-key', async (req, res) => {
  const { key, deviceId } = req.body || {};
  const result = await licenses.verifyKey(key, deviceId);

  if (!result.valid) {
    const messages = {
      MISSING_KEY: 'Clé de licence manquante.',
      NOT_FOUND: 'Clé de licence inconnue.',
      INACTIVE: 'Cette clé de licence a été désactivée.',
      EXPIRED: 'Cette clé de licence a expiré.',
      MISSING_DEVICE_ID: 'Identifiant d\'appareil manquant — rechargez la page et réessayez.',
      DEVICE_MISMATCH: 'Cette clé est déjà utilisée sur un autre appareil. Chaque appareil nécessite sa propre clé — contactez l\'administrateur si besoin.',
    };
    return res.status(401).json({ error: messages[result.reason] || 'Clé de licence invalide.' });
  }

  res.status(200).json({
    success: true,
    role: 'license',
    expiresAt: result.license.expiresAt,
    allowedModules: result.license.allowedModules,
  });
});

app.get('/api/admin/licenses', requireAdmin, (req, res) => {
  res.status(200).json(licenses.listLicensesWithUsage());
});

app.get('/api/admin/storage-status', requireAdmin, (req, res) => {
  res.status(200).json({
    licenses: licenses.getStorageStatus(),
    whatsapp: whatsapp.getStorageStatus(),
  });
});

app.get('/api/admin/overview', requireAdmin, (req, res) => {
  res.status(200).json(licenses.getOverview());
});

// Permet à l'exploitant de renseigner les identifiants d'application OAuth
// (Client ID/Secret) depuis le portail admin plutôt que de devoir les
// définir comme variables d'environnement Render. Ne renvoie jamais les
// secrets en retour (uniquement un booléen "configuré ou non"), pour ne pas
// les réafficher en clair dans le navigateur une fois saisis.
app.get('/api/admin/oauth-config', requireAdmin, (req, res) => {
  res.status(200).json(oauthConfig.getStatus());
});

app.post('/api/admin/oauth-config/google', requireAdmin, (req, res) => {
  const { clientId, clientSecret } = req.body || {};
  if (!clientId || !clientSecret) {
    return res.status(400).json({ error: 'Les champs "clientId" et "clientSecret" sont requis.' });
  }
  oauthConfig.set('google', { clientId, clientSecret });
  res.status(200).json({ success: true });
});

app.post('/api/admin/oauth-config/facebook', requireAdmin, (req, res) => {
  const { appId, appSecret } = req.body || {};
  if (!appId || !appSecret) {
    return res.status(400).json({ error: 'Les champs "appId" et "appSecret" sont requis.' });
  }
  oauthConfig.set('facebook', { appId, appSecret });
  res.status(200).json({ success: true });
});

app.post('/api/admin/oauth-config/tiktok', requireAdmin, (req, res) => {
  const { clientKey, clientSecret } = req.body || {};
  if (!clientKey || !clientSecret) {
    return res.status(400).json({ error: 'Les champs "clientKey" et "clientSecret" sont requis.' });
  }
  oauthConfig.set('tiktok', { clientKey, clientSecret });
  res.status(200).json({ success: true });
});

app.post('/api/admin/licenses', requireAdmin, async (req, res) => {
  const { expiresAt, note, allowedModules } = req.body || {};

  if (expiresAt && Number.isNaN(new Date(expiresAt).getTime())) {
    return res.status(400).json({ error: 'Date d\'expiration invalide.' });
  }

  const license = await licenses.createLicense({ expiresAt: expiresAt || null, note, allowedModules });
  res.status(201).json(license);
});

app.post('/api/admin/licenses/:key/toggle', requireAdmin, async (req, res) => {
  const { active } = req.body || {};

  try {
    const license = await licenses.setLicenseActive(req.params.key, Boolean(active));
    res.status(200).json(license);
  } catch (err) {
    if (err.message === 'LICENSE_NOT_FOUND') {
      return res.status(404).json({ error: 'Clé de licence introuvable.' });
    }
    console.error('Erreur lors de la mise à jour de la licence :', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// Libère la clé de son appareil actuel : le client pourra la réutiliser sur
// un nouvel appareil (perte/changement de téléphone, etc.) sans devoir en
// racheter une.
app.post('/api/admin/licenses/:key/unbind-device', requireAdmin, async (req, res) => {
  try {
    const license = await licenses.unbindDevice(req.params.key);
    res.status(200).json(license);
  } catch (err) {
    if (err.message === 'LICENSE_NOT_FOUND') {
      return res.status(404).json({ error: 'Clé de licence introuvable.' });
    }
    console.error('Erreur lors de la libération de l\'appareil :', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

// Suppression définitive d'une clé générée par erreur ou dont le client a
// été remboursé — contrairement au toggle actif/inactif, elle disparaît de
// la liste.
app.delete('/api/admin/licenses/:key', requireAdmin, async (req, res) => {
  try {
    const license = await licenses.deleteLicense(req.params.key);
    res.status(200).json(license);
  } catch (err) {
    if (err.message === 'LICENSE_NOT_FOUND') {
      return res.status(404).json({ error: 'Clé de licence introuvable.' });
    }
    console.error('Erreur lors de la suppression de la licence :', err);
    res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
});

app.get('/api/status', requireAccess, requireModule('whatsapp'), async (req, res) => {
  const connected = whatsapp.isConnected();
  const response = { connected };

  if (!connected) {
    const qr = whatsapp.getQRCode();
    if (qr) {
      try {
        response.qr = await QRCode.toDataURL(qr);
      } catch (err) {
        console.error('Erreur lors de la génération du QR code pour /api/status:', err);
      }
    }
  }

  res.status(200).json(response);
});

app.post('/api/pairing-code', requireAccess, requireModule('whatsapp'), async (req, res) => {
  const { phoneNumber } = req.body || {};

  if (!phoneNumber || !String(phoneNumber).replace(/\D/g, '')) {
    return res.status(400).json({ error: 'Le champ "phoneNumber" est requis (indicatif pays inclus, ex: 225xxxxxxxxx).' });
  }

  try {
    const code = await whatsapp.requestPairingCode(phoneNumber);
    res.status(200).json({ code });
  } catch (err) {
    if (err.message === 'ALREADY_REGISTERED') {
      return res.status(409).json({ error: 'Cet appareil est déjà connecté à WhatsApp.' });
    }
    console.error('Erreur lors de la génération du code d\'association:', err);
    res.status(500).json({ error: 'Échec de la génération du code d\'association.' });
  }
});

app.post('/api/messages', requireAccess, requireModule('whatsapp'), async (req, res) => {
  const { to, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: 'Les champs "to" et "message" sont requis.' });
  }

  try {
    await whatsapp.sendMessage(to, message);
    res.status(200).json({ status: 'sent' });
  } catch (err) {
    console.error('Erreur lors de l\'envoi du message:', err);
    res.status(500).json({ error: 'Échec de l\'envoi du message.' });
  }
});

app.get('/api/groups', requireAccess, requireModule('whatsapp'), async (req, res) => {
  try {
    const groups = await whatsapp.getGroups();
    res.status(200).json(groups);
  } catch (err) {
    console.error('Erreur lors de la récupération des groupes:', err);
    res.status(500).json({ error: 'Échec de la récupération des groupes.' });
  }
});

app.get('/api/groups/:id/participants', requireAccess, requireModule('whatsapp'), async (req, res) => {
  try {
    const participants = await whatsapp.getGroupParticipants(req.params.id);
    res.status(200).json(participants);
  } catch (err) {
    console.error('Erreur lors de la récupération des participants:', err);
    res.status(500).json({ error: 'Échec de la récupération des participants.' });
  }
});

app.post('/api/messages/queue', requireAccess, requireModule('whatsapp'), upload.single('media'), async (req, res) => {
  const { message, groupId, delaySeconds, batchSize } = req.body;
  let { recipients, groupIds } = req.body;

  if (typeof recipients === 'string') {
    try {
      recipients = JSON.parse(recipients);
    } catch (err) {
      recipients = recipients.split(/[,\n]/).map((n) => n.trim()).filter(Boolean);
    }
  }

  if (typeof groupIds === 'string') {
    try {
      groupIds = JSON.parse(groupIds);
    } catch (err) {
      groupIds = groupIds.split(',').map((n) => n.trim()).filter(Boolean);
    }
  }

  const targetGroupIds = Array.isArray(groupIds) && groupIds.length > 0
    ? groupIds
    : (groupId ? [groupId] : []);

  if ((!Array.isArray(recipients) || recipients.length === 0) && targetGroupIds.length > 0) {
    try {
      const merged = new Set();
      for (const gId of targetGroupIds) {
        const participants = await whatsapp.getGroupParticipants(gId);
        (participants || []).forEach((p) => merged.add(p.id));
      }
      recipients = Array.from(merged);
    } catch (err) {
      console.error('Erreur lors de la récupération des participants des groupes cibles:', err);
      return res.status(400).json({ error: 'Impossible de récupérer les participants des groupes cibles.' });
    }
  }

  if (!Array.isArray(recipients) || recipients.length === 0 || !message) {
    return res.status(400).json({
      error: 'Fournissez "recipients" (tableau ou liste), "groupId" ou "groupIds", ainsi qu\'un "message".',
    });
  }

  const fixedDelaySeconds = delaySeconds !== undefined && delaySeconds !== '' ? parseFloat(delaySeconds) : undefined;
  const parsedBatchSize = batchSize !== undefined && batchSize !== '' ? parseInt(batchSize, 10) : undefined;
  const media = req.file
    ? { buffer: req.file.buffer, mimetype: req.file.mimetype, filename: req.file.originalname }
    : null;

  let campaign;
  try {
    campaign = startCampaign(recipients, message, {
      delaySeconds: fixedDelaySeconds,
      batchSize: parsedBatchSize,
      media,
    });
  } catch (err) {
    if (err.message === 'CAMPAIGN_IN_PROGRESS') {
      return res.status(409).json({
        error: 'Une campagne est déjà en cours. Attendez sa fin ou interrompez-la (STOP) avant d\'en lancer une nouvelle.',
      });
    }
    throw err;
  }

  res.status(202).json({
    status: 'campaign_started',
    total: campaign.total,
    delaySeconds: fixedDelaySeconds || '8-15 (aléatoire)',
    batchSize: parsedBatchSize || recipients.length,
    media: media ? media.filename : null,
  });
});

app.post('/api/messages/stop', requireAccess, requireModule('whatsapp'), (req, res) => {
  if (!currentCampaign || currentCampaign.status !== 'running') {
    return res.status(400).json({ error: 'Aucune campagne en cours à interrompre.' });
  }

  currentCampaign.stopRequested = true;
  res.status(200).json({ status: 'stop_requested' });
});

app.get('/api/messages/status', requireAccess, requireModule('whatsapp'), (req, res) => {
  if (!currentCampaign) {
    return res.status(200).json({ exists: false });
  }

  res.status(200).json({ exists: true, ...currentCampaign });
});

app.post('/api/contacts/import', requireAccess, requireModule('whatsapp'), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier fourni (champ "file").' });
  }

  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet);

    const contacts = rows
      .map((row) => ({
        telephone: String(row.telephone || row.Telephone || row.phone || row.Phone || row.numero || row.Numero || '').trim(),
        prenom: String(row.prenom || row.Prenom || row.name || row.Name || '').trim(),
      }))
      .filter((c) => c.telephone);

    res.status(200).json({ contacts, total: contacts.length });
  } catch (err) {
    console.error('Erreur lors de l\'import du fichier de contacts:', err);
    res.status(400).json({ error: 'Fichier invalide. Utilisez un fichier .xlsx ou .csv avec une colonne "telephone".' });
  }
});

app.post('/api/chat-natural', requireAccess, requireModule('whatsapp'), async (req, res) => {
  const { message } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Le champ "message" (texte) est requis.' });
  }

  try {
    const reply = await handleNaturalMessage(message);
    res.status(200).json({ reply });
  } catch (err) {
    console.error('Erreur lors du traitement du message en langage naturel:', err);
    res.status(500).json({ reply: 'Une erreur est survenue lors du traitement de votre demande.' });
  }
});

app.post('/api/campaign/excel', requireAccess, requireModule('whatsapp'), upload.single('file'), async (req, res) => {
  let contacts;

  try {
    if (req.file) {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      contacts = XLSX.utils.sheet_to_json(sheet);
    } else if (Array.isArray(req.body?.contacts)) {
      contacts = req.body.contacts;
    } else {
      return res.status(400).json({
        error: 'Fournissez un fichier Excel (champ "file") ou un tableau JSON "contacts" avec les colonnes telephone, prenom, message.',
      });
    }
  } catch (err) {
    console.error('Erreur lors de la lecture du fichier Excel:', err);
    return res.status(400).json({ error: 'Fichier Excel invalide.' });
  }

  if (!Array.isArray(contacts) || contacts.length === 0) {
    return res.status(400).json({ error: 'Aucun contact à traiter.' });
  }

  const minDelaySeconds = parseFloat(req.body?.minDelaySeconds) || 8;
  const maxDelaySeconds = parseFloat(req.body?.maxDelaySeconds) || 15;

  res.status(202).json({
    status: 'campaign_started',
    total: contacts.length,
    minDelaySeconds,
    maxDelaySeconds,
  });

  runCampaign(contacts, minDelaySeconds * 1000, maxDelaySeconds * 1000).catch((err) => {
    console.error('Erreur pendant l\'exécution de la campagne:', err);
  });
});

// Vue d'ensemble pratique des 3 connexions OAuth (Facebook/Google/TikTok) en
// un seul appel — mêmes booléens que /api/facebook/status et
// /api/media/status, juste regroupés. N'importe quel utilisateur authentifié
// (admin ou licence) peut la lire : ce ne sont que des booléens de
// disponibilité, jamais les identifiants eux-mêmes.
app.get('/api/oauth/status', requireAccess, (req, res) => {
  res.status(200).json({
    facebook: { configured: facebook.isConfigured(), connectAvailable: facebook.isConnectAvailable() },
    google: { configured: mediaPublisher.isYoutubeConfigured(), connectAvailable: mediaPublisher.isYoutubeConnectAvailable() },
    tiktok: { configured: mediaPublisher.isTikTokConfigured(), connectAvailable: mediaPublisher.isTikTokConnectAvailable() },
  });
});

app.get('/api/facebook/status', requireAccess, requireModule('facebook'), async (req, res) => {
  const status = await facebook.checkConnection();
  res.status(200).json({ configured: facebook.isConfigured(), connectAvailable: facebook.isConnectAvailable(), ...status });
});

// Déclenchée par une navigation top-level (clic sur "Se connecter avec
// Facebook"), pas par fetch/XHR : le mot de passe/la clé de licence arrive
// donc en paramètre de requête (déjà supporté par requireAccess), jamais en
// en-tête personnalisé impossible à poser sur une redirection de navigateur.
app.get('/api/facebook/connect', requireAccess, requireModule('facebook'), (req, res) => {
  if (!facebook.isConnectAvailable()) {
    return res.status(503).json({
      error: 'Connexion Facebook indisponible : FB_APP_ID/FB_APP_SECRET non configurés côté serveur.',
    });
  }
  const redirectUri = `${PUBLIC_BASE_URL}/api/facebook/callback`;
  const state = createOAuthState();
  res.redirect(facebook.getAuthUrl(redirectUri, state));
});

// Route publique par nature : Meta y redirige le navigateur directement,
// sans pouvoir transmettre nos en-têtes d'authentification. Sécurisée par le
// paramètre "state" à usage unique (voir createOAuthState/consumeOAuthState).
app.get('/api/facebook/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error || !code || !state || !consumeOAuthState(state)) {
    return res.redirect('/dashboard?fbConnect=error');
  }

  try {
    const redirectUri = `${PUBLIC_BASE_URL}/api/facebook/callback`;
    await facebook.handleOAuthCallback(code, redirectUri);
    res.redirect('/dashboard?fbConnect=success');
  } catch (err) {
    console.error('Erreur lors de la connexion Facebook (callback OAuth):', err?.response?.data || err.message);
    res.redirect('/dashboard?fbConnect=error');
  }
});

app.get('/api/facebook/groups', requireAccess, requireModule('facebook'), async (req, res) => {
  if (!facebook.isConfigured()) {
    return res.status(503).json({
      error: 'Intégration Facebook Messenger non configurée (variable FB_PAGE_ACCESS_TOKEN manquante).',
    });
  }

  try {
    const conversations = await facebook.getConversations();
    res.status(200).json(conversations);
  } catch (err) {
    console.error('Erreur lors de la récupération des conversations Facebook:', err?.response?.data || err.message);
    res.status(500).json({ error: 'Échec de la récupération des conversations Facebook Messenger.' });
  }
});

app.post('/api/facebook/queue', requireAccess, requireModule('facebook'), upload.single('media'), async (req, res) => {
  if (!facebook.isConfigured()) {
    return res.status(503).json({
      error: 'Intégration Facebook Messenger non configurée (variable FB_PAGE_ACCESS_TOKEN manquante).',
    });
  }

  const { message, delaySeconds, batchSize } = req.body;
  let { recipients } = req.body;

  if (typeof recipients === 'string') {
    try {
      recipients = JSON.parse(recipients);
    } catch (err) {
      recipients = recipients.split(/[,\n]/).map((n) => n.trim()).filter(Boolean);
    }
  }

  if (!Array.isArray(recipients) || recipients.length === 0 || !message) {
    return res.status(400).json({
      error: 'Fournissez "recipients" (tableau des destinataires Messenger) et un "message".',
    });
  }

  const fixedDelaySeconds = delaySeconds !== undefined && delaySeconds !== '' ? parseFloat(delaySeconds) : undefined;
  const parsedBatchSize = batchSize !== undefined && batchSize !== '' ? parseInt(batchSize, 10) : undefined;
  const media = req.file
    ? { buffer: req.file.buffer, mimetype: req.file.mimetype, filename: req.file.originalname }
    : null;

  res.status(202).json({
    status: 'fb_queue_started',
    total: recipients.length,
    delaySeconds: fixedDelaySeconds || '10-15 (aléatoire)',
    batchSize: parsedBatchSize || recipients.length,
    media: media ? media.filename : null,
  });

  facebook.sendBulk(recipients, message, {
    delaySeconds: fixedDelaySeconds,
    batchSize: parsedBatchSize,
    media,
  }).then((results) => {
    const success = results.filter((r) => r.status === 'delivered').length;
    console.log(`Facebook Messenger: campagne terminée (${success}/${results.length} réussite(s)).`);
  }).catch((err) => {
    console.error('Erreur pendant la campagne Facebook Messenger:', err);
  });
});

app.get('/api/telegram/status', requireAccess, requireModule('telegram'), (req, res) => {
  res.status(200).json({
    configured: telegram.isConfigured(),
    connected: telegram.isConnected(),
  });
});

app.post('/api/telegram/login/start', requireAccess, requireModule('telegram'), async (req, res) => {
  const { phoneNumber } = req.body || {};

  if (!phoneNumber || !String(phoneNumber).replace(/\D/g, '')) {
    return res.status(400).json({ error: 'Le champ "phoneNumber" est requis (indicatif pays inclus).' });
  }

  if (!telegram.isConfigured()) {
    return res.status(503).json({
      error: 'Intégration Telegram non configurée (variables TELEGRAM_API_ID / TELEGRAM_API_HASH manquantes).',
    });
  }

  try {
    const step = await telegram.startLogin(phoneNumber);
    res.status(200).json({ step, error: step === 'error' ? telegram.getLoginError() : null });
  } catch (err) {
    console.error('Erreur lors du démarrage de la connexion Telegram:', err);
    res.status(500).json({ error: 'Échec du démarrage de la connexion Telegram.' });
  }
});

app.post('/api/telegram/login/code', requireAccess, requireModule('telegram'), async (req, res) => {
  const { code } = req.body || {};

  if (!code) {
    return res.status(400).json({ error: 'Le champ "code" est requis.' });
  }

  try {
    const step = await telegram.submitCode(code);
    res.status(200).json({ step, error: step === 'error' ? telegram.getLoginError() : null });
  } catch (err) {
    if (err.message === 'NO_PENDING_CODE_REQUEST') {
      return res.status(409).json({ error: 'Aucune demande de code en attente. Relancez /api/telegram/login/start.' });
    }
    console.error('Erreur lors de la validation du code Telegram:', err);
    res.status(500).json({ error: 'Échec de la validation du code.' });
  }
});

app.post('/api/telegram/login/password', requireAccess, requireModule('telegram'), async (req, res) => {
  const { password } = req.body || {};

  if (!password) {
    return res.status(400).json({ error: 'Le champ "password" est requis.' });
  }

  try {
    const step = await telegram.submitPassword(password);
    res.status(200).json({ step, error: step === 'error' ? telegram.getLoginError() : null });
  } catch (err) {
    if (err.message === 'NO_PENDING_PASSWORD_REQUEST') {
      return res.status(409).json({ error: 'Aucune demande de mot de passe 2FA en attente.' });
    }
    console.error('Erreur lors de la validation du mot de passe Telegram:', err);
    res.status(500).json({ error: 'Échec de la validation du mot de passe.' });
  }
});

app.get('/api/telegram/groups', requireAccess, requireModule('telegram'), async (req, res) => {
  if (!telegram.isConnected()) {
    return res.status(409).json({ error: 'Telegram non connecté. Connectez-vous via l\'onglet Telegram avant de lister les groupes.' });
  }

  try {
    const groups = await telegram.getGroups();
    res.status(200).json(groups);
  } catch (err) {
    console.error('Erreur lors de la récupération des groupes Telegram:', err);
    res.status(500).json({ error: 'Échec de la récupération des groupes Telegram.' });
  }
});

app.post('/api/telegram/queue', requireAccess, requireModule('telegram'), upload.single('media'), async (req, res) => {
  if (!telegram.isConnected()) {
    return res.status(409).json({ error: 'Telegram non connecté. Connectez-vous via l\'onglet Telegram avant d\'envoyer.' });
  }

  const { message, delaySeconds, batchSize } = req.body;
  let { recipients } = req.body;

  if (typeof recipients === 'string') {
    try {
      recipients = JSON.parse(recipients);
    } catch (err) {
      recipients = recipients.split(/[,\n]/).map((n) => n.trim()).filter(Boolean);
    }
  }

  if (!Array.isArray(recipients) || recipients.length === 0 || !message) {
    return res.status(400).json({
      error: 'Fournissez "recipients" (tableau des identifiants de groupes/canaux Telegram) et un "message".',
    });
  }

  const fixedDelaySeconds = delaySeconds !== undefined && delaySeconds !== '' ? parseFloat(delaySeconds) : undefined;
  const parsedBatchSize = batchSize !== undefined && batchSize !== '' ? parseInt(batchSize, 10) : undefined;
  const media = req.file
    ? { buffer: req.file.buffer, mimetype: req.file.mimetype, filename: req.file.originalname }
    : null;

  res.status(202).json({
    status: 'tg_queue_started',
    total: recipients.length,
    delaySeconds: fixedDelaySeconds || '10-15 (aléatoire)',
    batchSize: parsedBatchSize || recipients.length,
    media: media ? media.filename : null,
  });

  telegram.sendBulk(recipients, message, {
    delaySeconds: fixedDelaySeconds,
    batchSize: parsedBatchSize,
    media,
  }).then((results) => {
    const success = results.filter((r) => r.status === 'delivered').length;
    console.log(`Telegram: campagne terminée (${success}/${results.length} réussite(s)).`);
  }).catch((err) => {
    console.error('Erreur pendant la campagne Telegram:', err);
  });
});

// Import d'une liste de contacts (usernames et/ou numéros de téléphone)
// depuis un fichier CSV/Excel, ou directement un tableau JSON — même
// pattern que /api/contacts/import (WhatsApp), colonnes acceptées :
// username/telegram/contact/identifiant pour l'identifiant, prenom/nom/name
// pour le nom affiché. Ne persiste rien côté serveur : le frontend garde la
// liste importée en mémoire le temps de composer et lancer l'envoi.
app.post('/api/telegram/contacts/import', requireAccess, requireModule('telegram'), upload.single('file'), async (req, res) => {
  let rows;

  try {
    if (req.file) {
      const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet);
    } else if (Array.isArray(req.body?.contacts)) {
      rows = req.body.contacts;
    } else {
      return res.status(400).json({
        error: 'Fournissez un fichier CSV/Excel (champ "file") ou un tableau JSON "contacts".',
      });
    }
  } catch (err) {
    console.error('Erreur lors de la lecture du fichier de contacts Telegram:', err);
    return res.status(400).json({ error: 'Fichier invalide. Utilisez un fichier .csv ou .xlsx.' });
  }

  const contacts = rows
    .map((row) => ({
      identifier: String(
        row.identifiant || row.username || row.Username || row.telegram || row.Telegram
        || row.contact || row.Contact || row.telephone || row.Telephone || row.phone || row.Phone || '',
      ).trim(),
      name: String(row.prenom || row.Prenom || row.nom || row.Nom || row.name || row.Name || '').trim(),
    }))
    .filter((c) => c.identifier);

  res.status(200).json({ contacts, total: contacts.length });
});

app.post('/api/telegram/dm/queue', requireAccess, requireModule('telegram'), upload.single('media'), async (req, res) => {
  if (!telegram.isConnected()) {
    return res.status(409).json({ error: 'Telegram non connecté. Connectez-vous via l\'onglet Telegram avant d\'envoyer.' });
  }

  const { message, minDelaySeconds, maxDelaySeconds, maxPerCycle } = req.body;
  let { recipients } = req.body;

  if (typeof recipients === 'string') {
    try {
      recipients = JSON.parse(recipients);
    } catch (err) {
      recipients = recipients.split(/[,\n]/).map((n) => n.trim()).filter(Boolean);
    }
  }

  if (!Array.isArray(recipients) || recipients.length === 0 || !message) {
    return res.status(400).json({
      error: 'Fournissez "recipients" (tableau de usernames/numéros importés) et un "message".',
    });
  }

  const media = req.file
    ? { buffer: req.file.buffer, mimetype: req.file.mimetype, filename: req.file.originalname }
    : null;

  let campaign;
  try {
    campaign = startTelegramDmCampaign(recipients, message, {
      minDelayMs: minDelaySeconds !== undefined && minDelaySeconds !== '' ? parseFloat(minDelaySeconds) * 1000 : undefined,
      maxDelayMs: maxDelaySeconds !== undefined && maxDelaySeconds !== '' ? parseFloat(maxDelaySeconds) * 1000 : undefined,
      maxPerCycle: maxPerCycle !== undefined && maxPerCycle !== '' ? parseInt(maxPerCycle, 10) : undefined,
      media,
    });
  } catch (err) {
    if (err.message === 'CAMPAIGN_IN_PROGRESS') {
      return res.status(409).json({
        error: 'Une campagne Telegram est déjà en cours. Attendez sa fin ou interrompez-la (Pause/Arrêt) avant d\'en lancer une nouvelle.',
      });
    }
    throw err;
  }

  res.status(202).json({
    status: 'tg_dm_campaign_started',
    total: campaign.total,
    truncated: campaign.truncated,
  });
});

app.post('/api/telegram/dm/stop', requireAccess, requireModule('telegram'), (req, res) => {
  if (!currentTelegramDmCampaign || currentTelegramDmCampaign.status !== 'running') {
    return res.status(400).json({ error: 'Aucune campagne Telegram en cours à interrompre.' });
  }

  currentTelegramDmCampaign.stopRequested = true;
  res.status(200).json({ status: 'stop_requested' });
});

app.get('/api/telegram/dm/status', requireAccess, requireModule('telegram'), (req, res) => {
  if (!currentTelegramDmCampaign) {
    return res.status(200).json({ exists: false });
  }

  res.status(200).json({ exists: true, ...currentTelegramDmCampaign });
});

// Doit rester PUBLIQUE et sans authentification : c'est Meta (Instagram) qui
// télécharge la vidéo depuis ce serveur pendant la création du conteneur
// media_type=REELS, et ses serveurs ne peuvent pas envoyer notre en-tête
// x-admin-password / x-license-key. Le jeton (32 caractères hex) fait office
// de protection : personne ne peut deviner l'URL sans l'avoir reçue, et elle
// expire après 30 minutes (voir MediaPublisherAdapter.registerTempVideo).
app.get('/api/media/temp/:token', (req, res) => {
  const entry = mediaPublisher.getTempVideo(req.params.token);

  if (!entry) {
    return res.status(404).send('Vidéo introuvable ou expirée.');
  }

  res.set('Content-Type', entry.mimetype || 'video/mp4');
  res.send(entry.buffer);
});

app.get('/api/media/status', requireAccess, requireModule('studio_video'), (req, res) => {
  res.status(200).json({
    youtube: { configured: mediaPublisher.isYoutubeConfigured(), connectAvailable: mediaPublisher.isYoutubeConnectAvailable() },
    instagram: { configured: mediaPublisher.isInstagramConfigured() },
    tiktok: { configured: mediaPublisher.isTikTokConfigured(), connectAvailable: mediaPublisher.isTikTokConnectAvailable() },
  });
});

app.get('/api/media/youtube/connect', requireAccess, requireModule('studio_video'), (req, res) => {
  if (!mediaPublisher.isYoutubeConnectAvailable()) {
    return res.status(503).json({
      error: 'Connexion YouTube indisponible : GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET ou PUBLIC_BASE_URL non configurés côté serveur.',
    });
  }
  const redirectUri = `${PUBLIC_BASE_URL}/api/media/youtube/callback`;
  const state = createOAuthState();
  res.redirect(mediaPublisher.getYoutubeAuthUrl(redirectUri, state));
});

app.get('/api/media/youtube/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error || !code || !state || !consumeOAuthState(state)) {
    return res.redirect('/dashboard?youtubeConnect=error');
  }

  try {
    const redirectUri = `${PUBLIC_BASE_URL}/api/media/youtube/callback`;
    await mediaPublisher.handleYoutubeCallback(code, redirectUri);
    res.redirect('/dashboard?youtubeConnect=success');
  } catch (err) {
    console.error('Erreur lors de la connexion YouTube (callback OAuth):', err?.response?.data || err.message);
    res.redirect('/dashboard?youtubeConnect=error');
  }
});

app.get('/api/media/tiktok/connect', requireAccess, requireModule('studio_video'), (req, res) => {
  if (!mediaPublisher.isTikTokConnectAvailable()) {
    return res.status(503).json({
      error: 'Connexion TikTok indisponible : TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET ou PUBLIC_BASE_URL non configurés côté serveur.',
    });
  }
  const redirectUri = `${PUBLIC_BASE_URL}/api/media/tiktok/callback`;
  const state = createOAuthState();
  res.redirect(mediaPublisher.getTiktokAuthUrl(redirectUri, state));
});

app.get('/api/media/tiktok/callback', async (req, res) => {
  const { code, state, error } = req.query;

  if (error || !code || !state || !consumeOAuthState(state)) {
    return res.redirect('/dashboard?tiktokConnect=error');
  }

  try {
    const redirectUri = `${PUBLIC_BASE_URL}/api/media/tiktok/callback`;
    await mediaPublisher.handleTiktokCallback(code, redirectUri);
    res.redirect('/dashboard?tiktokConnect=success');
  } catch (err) {
    console.error('Erreur lors de la connexion TikTok (callback OAuth):', err?.response?.data || err.message);
    res.redirect('/dashboard?tiktokConnect=error');
  }
});

app.post('/api/media/publish-all', requireAccess, requireModule('studio_video'), videoUpload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Fichier vidéo requis (champ "video", MP4 ou MOV).' });
  }

  const { title, caption, scheduleAt } = req.body;
  let { platforms } = req.body;

  if (typeof platforms === 'string') {
    try {
      platforms = JSON.parse(platforms);
    } catch (err) {
      platforms = platforms.split(',').map((p) => p.trim()).filter(Boolean);
    }
  }

  const validPlatforms = ['youtube', 'instagram', 'tiktok'];
  platforms = Array.isArray(platforms) ? platforms.filter((p) => validPlatforms.includes(p)) : [];

  if (platforms.length === 0) {
    return res.status(400).json({
      error: 'Sélectionnez au moins un réseau cible valide ("platforms": youtube, instagram, tiktok).',
    });
  }

  if (isPublishJobActive(currentPublishJob)) {
    return res.status(409).json({
      error: 'Une publication est déjà en cours. Attendez sa fin avant d\'en lancer une nouvelle.',
    });
  }

  if (scheduleAt && Number.isNaN(new Date(scheduleAt).getTime())) {
    return res.status(400).json({ error: 'Date de programmation invalide.' });
  }

  const job = createPublishJob(platforms);

  res.status(202).json({ status: 'publish_started', platforms: job.platforms });

  runPublishJob(job, {
    buffer: req.file.buffer,
    mimetype: req.file.mimetype,
    title: title || '',
    caption: caption || '',
    scheduleAt: scheduleAt || null,
  }, platforms).catch((err) => {
    console.error('Erreur pendant la publication multi-plateformes:', err);
  });
});

app.get('/api/media/publish-status', requireAccess, requireModule('studio_video'), (req, res) => {
  if (!currentPublishJob) {
    return res.status(200).json({ exists: false });
  }

  res.status(200).json({ exists: true, ...currentPublishJob });
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    return res.status(400).json({ error: `Erreur de téléversement : ${err.message}` });
  }
  if (err && err.message === 'INVALID_VIDEO_TYPE') {
    return res.status(400).json({ error: 'Format vidéo invalide : seuls les fichiers MP4 ou MOV sont acceptés.' });
  }
  if (err) {
    console.error('Erreur non gérée:', err);
    return res.status(500).json({ error: 'Erreur interne du serveur.' });
  }
  return next();
});

licenses
  .initFromRemote()
  .catch((err) => {
    console.error('Erreur lors de la restauration des licences depuis GitHub :', err);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
      printAndWriteAdminAccessInstructions();
    });
  });

whatsapp
  .restoreSessionFromRemote()
  .catch((err) => {
    console.error('Erreur lors de la restauration de la session WhatsApp depuis GitHub :', err);
  })
  .finally(() => {
    whatsapp.connect().catch((err) => {
      console.error('Erreur lors de l\'initialisation de l\'adaptateur WhatsApp:', err);
    });
  });

telegram.init().catch((err) => {
  console.error('Erreur lors de l\'initialisation de l\'adaptateur Telegram:', err);
});
