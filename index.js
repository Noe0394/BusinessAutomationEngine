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
const axios = require('axios');
const whatsapp = require('./adapters/whatsapp');
const FacebookMessengerAdapter = require('./adapters/facebook');
const TelegramAdapter = require('./adapters/telegram');
const MediaPublisherAdapter = require('./adapters/media_publisher');
const videoCompressor = require('./adapters/videoCompressor');
const licenses = require('./licenses');
const oauthConfig = require('./oauth_config');
const scheduledMessages = require('./queues/scheduled_messages');
const contactsStore = require('./models/contact');
const keywordRules = require('./models/keyword_rules');

const app = express();
const PORT = process.env.PORT || 10000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '@CYRUS2026';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
// Une campagne WhatsApp peut joindre une vidéo bien plus lourde que 16 Mo
// (compressée automatiquement avant l'envoi, voir buildWhatsappMediaStep) :
// instance multer dédiée, limite plus large. Reste en mémoire
// (multer.memoryStorage) comme le reste de l'app : à surveiller sur une
// instance Render à faible RAM avec plusieurs grosses vidéos jointes à la
// même campagne (jusqu'à 10 fichiers par envoi).
const whatsappMediaUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });
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
const PRIVACY_POLICY_PATH = path.join(__dirname, 'public', 'legal', 'privacy.html');
const TERMS_OF_SERVICE_PATH = path.join(__dirname, 'public', 'legal', 'terms.html');
const DATA_DELETION_PATH = path.join(__dirname, 'public', 'legal', 'data-deletion.html');
const facebook = new FacebookMessengerAdapter();
const telegram = new TelegramAdapter();
const mediaPublisher = new MediaPublisherAdapter();

// Fichiers média joints à une programmation multi-canal (module Programmation
// / Planning) : sauvegardés ici plutôt que gardés en mémoire, puisqu'une
// programmation peut attendre plusieurs jours avant son envoi. Même limite
// que les autres dossiers de données locales sur Render : effacé à chaque
// redéploiement/redémarrage sauf disque persistant monté sur ce chemin.
const SCHEDULED_MEDIA_DIR = process.env.SCHEDULED_MEDIA_DIR || path.join(__dirname, 'scheduled_media');
fs.mkdirSync(SCHEDULED_MEDIA_DIR, { recursive: true });

// Même principe pour les médias joints aux règles de mots-clés du module de
// Capture Automatique de Prospects (voir plus bas, handleFacebookFeedChange/
// handleFacebookMessagingEvent).
const KEYWORD_MEDIA_DIR = process.env.KEYWORD_MEDIA_DIR || path.join(__dirname, 'keyword_media');
fs.mkdirSync(KEYWORD_MEDIA_DIR, { recursive: true });

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

// verify: capture le corps brut pour la vérification de signature HMAC des
// webhooks Meta (X-Hub-Signature-256, voir POST /api/facebook/webhook) sans
// ajouter un second parseur JSON dédié sur cette seule route.
app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));

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
    // "facebook" et "studio_video" (YouTube/TikTok) sont forcés disponibles
    // pour toute clé, sans passer par allowedModules : licenses.js exclut ces
    // modules de la vente/attribution (ALL_MODULES = ['whatsapp', 'telegram'])
    // depuis leur retrait du système de licences, ce qui bloquerait ces
    // routes pour toute clé existante — y compris celles déjà émises — tant
    // qu'ils n'y sont pas réintégrés.
    if (moduleName === 'facebook' || moduleName === 'studio_video') {
      return next();
    }
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

// Variables de personnalisation ({nom}, etc.) : une clé absente ou nulle est
// remplacée par une chaîne vide plutôt que de laisser le texte "{nom}" tel
// quel ou d'y insérer le mot "null" — un message "Bonjour {nom}," sans nom
// connu doit devenir "Bonjour," et non un texte visiblement cassé.
function replaceVariables(template, row) {
  return String(template).replace(/{(\w+)}/g, (match, key) => {
    const value = row[key];
    return value !== undefined && value !== null ? String(value) : '';
  });
}

function normalizeJid(telephone) {
  const raw = String(telephone).trim();
  if (raw.includes('@')) {
    return raw;
  }
  const digits = raw.replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

// Format E.164 (ex: +2250700000000) à partir d'un JID WhatsApp
// (2250700000000@s.whatsapp.net) — utilisé pour l'export Excel. Les JID au
// format @lid (identité anonyme récente de WhatsApp, sans numéro réel
// exploitable) ne portent pas un vrai numéro : les chiffres qui précèdent
// "@lid" ne sont pas un numéro de téléphone valide, mais on les renvoie quand
// même préfixés d'un "+" plutôt que de faire échouer l'export pour ces
// quelques participants.
function jidToE164(jid) {
  const digits = String(jid || '').split('@')[0].replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

// Représentation normalisée d'un destinataire WhatsApp pour l'envoi : un JID
// résolu ("to") et un nom de personnalisation ("nom", jamais undefined/null).
// Accepte soit un identifiant simple (chaîne — résolution de groupe, ou liste
// importée à l'ancien format), soit un contact enrichi { telephone, nom }
// (liste importée avec colonne "nom", voir /api/contacts/import). Dans le
// premier cas, on retombe sur le cache opportuniste de noms publics
// (pushName/notify) constitué par l'adaptateur au fil des messages/contacts
// vus — qui peut rester vide si ce contact n'a jamais été "rencontré".
function normalizeRecipientEntry(recipient) {
  if (recipient && typeof recipient === 'object') {
    const telephone = recipient.telephone || recipient.to || recipient.phone || '';
    const to = normalizeJid(telephone);
    return { to, nom: recipient.nom || recipient.prenom || whatsapp.getContactName(to) || '' };
  }
  const to = normalizeJid(recipient);
  return { to, nom: whatsapp.getContactName(to) || '' };
}

// Convertit un fichier "média" issu de multer en étape prête à l'envoi
// WhatsApp, en compressant automatiquement une vidéo trop lourde (voir
// adapters/videoCompressor.js — cible 15 Mo, résolution 720p/480p) avant de
// l'attacher. Appelé une seule fois par fichier au moment de l'upload (pas à
// chaque destinataire) : le résultat (buffer déjà compressé le cas échéant)
// est réutilisé tel quel pour toute la campagne.
async function buildWhatsappMediaStep(file) {
  if (file.mimetype && file.mimetype.startsWith('video/') && file.buffer.length > videoCompressor.MAX_SIZE_BYTES) {
    const result = await videoCompressor.compressVideoIfNeeded(file.buffer, file.originalname);
    return {
      type: 'media',
      buffer: result.buffer,
      mimetype: result.forceDocument ? file.mimetype : result.mimetype,
      filename: file.originalname,
      forceDocument: result.forceDocument,
    };
  }
  return { type: 'media', buffer: file.buffer, mimetype: file.mimetype, filename: file.originalname };
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
      to: normalizeRecipientEntry(recipients[j]).to,
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

// sequence (tableau) porte la campagne à envoyer : chaque étape est soit
// { type: 'text', text } soit { type: 'media', buffer, mimetype, filename },
// envoyée dans l'ordre à chaque destinataire avec un court délai (2-5s par
// défaut, paramétrable) entre chaque étape — pour simuler une frappe
// naturelle, distinct du délai (8-15s) appliqué entre deux destinataires.
async function runCampaignQueue(campaign, recipients, options = {}) {
  const { delaySeconds, batchSize, sequence, sequenceDelayMinMs, sequenceDelayMaxMs } = options;
  const batch = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : recipients.length;
  const seqMinMs = Number.isFinite(sequenceDelayMinMs) ? sequenceDelayMinMs : 2000;
  const seqMaxMs = Number.isFinite(sequenceDelayMaxMs) ? Math.max(seqMinMs, sequenceDelayMaxMs) : Math.max(seqMinMs, 5000);

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

    const { to, nom } = normalizeRecipientEntry(recipients[i]);
    let status = 'failed';

    try {
      for (let s = 0; s < sequence.length; s += 1) {
        const step = sequence[s];
        if (step.type === 'media') {
          await whatsapp.sendMedia(to, step);
        } else {
          await whatsapp.sendMessage(to, replaceVariables(step.text, { nom }));
        }
        if (s < sequence.length - 1) {
          await sleep(randomDelay(seqMinMs, seqMaxMs));
        }
      }
      status = 'delivered';
      campaign.success += 1;
      console.log(`Campagne: séquence envoyée à ${to} (${i + 1}/${recipients.length}).`);
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

function startCampaign(recipients, options = {}) {
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

  runCampaignQueue(campaign, recipients, options).catch((err) => {
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

// Gère à la fois la pause volontaire (boutons Pause/Reprendre) et la perte
// de connexion (auto-pause le temps que Telegram se reconnecte) — les deux
// cas se traduisent de la même façon pour la file d'attente : on attend
// avant de continuer, sans marquer les destinataires restants comme échoués.
async function waitWhileTelegramCampaignBlocked(campaign) {
  if (!campaign.userPaused && telegram.isConnected()) {
    return;
  }

  campaign.paused = true;
  if (campaign.userPaused) {
    console.log('Campagne Telegram: en pause (demandée par l\'utilisateur).');
  } else {
    console.log('Campagne Telegram: mise en pause — connexion perdue, en attente de reconnexion...');
  }

  while (!campaign.stopRequested && (campaign.userPaused || !telegram.isConnected())) {
    await sleep(1000);
  }

  campaign.paused = false;
  if (!campaign.stopRequested) {
    console.log('Campagne Telegram: reprise.');
  }
}

// Comme interruptibleSleep (WhatsApp), mais réagit aussi à une pause
// utilisateur déclenchée en pleine attente entre deux envois : le délai ne
// continue pas à s'écouler pendant la pause.
async function telegramDmInterruptibleSleep(ms, campaign) {
  const tickMs = 300;
  let elapsed = 0;
  while (elapsed < ms) {
    if (campaign.stopRequested) return;
    if (campaign.userPaused) {
      campaign.paused = true;
      await sleep(tickMs);
      continue;
    }
    campaign.paused = false;
    const step = Math.min(tickMs, ms - elapsed);
    await sleep(step);
    elapsed += step;
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

    await waitWhileTelegramCampaignBlocked(campaign);

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
      await telegramDmInterruptibleSleep(delayMs, campaign);
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
    userPaused: false,
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

// ---------- Programmation multi-canal (module Programmation / Planning) ----------
// Contrairement aux campagnes interactives ci-dessus (currentCampaign,
// currentTelegramDmCampaign — un seul créneau global partagé avec le
// dashboard), une programmation est indépendante : elle doit pouvoir
// s'exécuter sans écraser une campagne manuelle en cours, ni en être bloquée.
// Chaque canal a donc sa propre boucle d'envoi séquentielle ici plutôt que de
// réutiliser les créneaux interactifs existants.

// mediaUrl vaut soit un lien externe (http/https, fourni par l'exploitant),
// soit "local:<nom de fichier>" pour un média envoyé depuis un formulaire du
// dashboard et sauvegardé dans mediaDir (SCHEDULED_MEDIA_DIR ou
// KEYWORD_MEDIA_DIR selon l'appelant) — pas d'endpoint HTTP public exposé
// pour ces fichiers, ils ne sont lus que côté serveur au moment de l'envoi.
// Fonction générique réutilisée par la programmation multi-canal
// (resolveScheduledMedia) et par les règles de mots-clés de la Capture
// Automatique de Prospects (resolveKeywordRuleMedia).
async function resolveMediaReference(ref, mediaDir) {
  if (!ref || !ref.mediaUrl) {
    return null;
  }

  if (ref.mediaUrl.startsWith('local:')) {
    const fileName = ref.mediaUrl.slice('local:'.length);
    const filePath = path.join(mediaDir, fileName);
    const buffer = fs.readFileSync(filePath);
    return {
      buffer,
      mimetype: ref.mediaMimetype || 'application/octet-stream',
      filename: ref.mediaFilename || fileName,
    };
  }

  const res = await axios.get(ref.mediaUrl, {
    responseType: 'arraybuffer',
    maxContentLength: 200 * 1024 * 1024,
    timeout: 30000,
  });
  const mimetype = res.headers['content-type'] || ref.mediaMimetype || 'application/octet-stream';
  let filename = ref.mediaFilename;
  if (!filename) {
    try {
      filename = path.basename(new URL(ref.mediaUrl).pathname) || 'fichier';
    } catch (err) {
      filename = 'fichier';
    }
  }
  return { buffer: Buffer.from(res.data), mimetype, filename };
}

// entry.media (tableau, voir queues/scheduled_messages.js) porte une ou
// plusieurs pièces jointes — WhatsApp est le seul canal à toutes les envoyer
// (voir dispatchScheduledWhatsapp) ; les autres canaux ne consomment que le
// premier élément du tableau retourné ici.
async function resolveScheduledMediaList(entry) {
  const items = Array.isArray(entry.media) && entry.media.length > 0
    ? entry.media
    : (entry.mediaUrl ? [{ mediaUrl: entry.mediaUrl, mediaMimetype: entry.mediaMimetype, mediaFilename: entry.mediaFilename }] : []);

  const resolved = [];
  for (const item of items) {
    const media = await resolveMediaReference(item, SCHEDULED_MEDIA_DIR);
    if (media) resolved.push({ ...media, forceDocument: Boolean(item.forceDocument) });
  }
  return resolved;
}

function resolveKeywordRuleMedia(rule) {
  return resolveMediaReference(rule, KEYWORD_MEDIA_DIR);
}

// entry.sequence (tableau, voir queues/scheduled_messages.js et
// runCampaignQueue pour l'équivalent côté envoi immédiat) : résout chaque
// étape média en buffer, en conservant l'ordre et les étapes texte telles
// quelles. Retourne null si l'entrée ne porte pas de séquence (programmation
// classique message + médias, voir resolveScheduledMediaList).
async function resolveScheduledSequence(entry) {
  if (!Array.isArray(entry.sequence) || entry.sequence.length === 0) {
    return null;
  }

  const resolved = [];
  for (const step of entry.sequence) {
    if (step.type === 'media') {
      const media = await resolveMediaReference(step, SCHEDULED_MEDIA_DIR);
      if (media) resolved.push({ ...media, type: 'media', forceDocument: Boolean(step.forceDocument) });
    } else {
      resolved.push({ type: 'text', text: step.text });
    }
  }
  return resolved;
}

async function dispatchScheduledWhatsapp(entry, mediaList) {
  let recipients = entry.recipients;

  if (entry.recipientType === 'groups') {
    const merged = new Set();
    for (const groupId of entry.recipients) {
      const participants = await whatsapp.getGroupParticipants(groupId);
      (participants || []).forEach((p) => merged.add(p.id));
    }
    recipients = Array.from(merged);
  }

  const sequence = await resolveScheduledSequence(entry);
  const seqMinMs = Math.max(1, entry.sequenceDelayMinSeconds || 2) * 1000;
  const seqMaxMs = Math.max(seqMinMs, (entry.sequenceDelayMaxSeconds || 5) * 1000);

  const results = [];
  for (let i = 0; i < recipients.length; i += 1) {
    const { to, nom } = normalizeRecipientEntry(recipients[i]);
    try {
      if (sequence) {
        // Séquençage / Envoi Multi-Messages : chaque étape part comme un
        // message distinct, dans l'ordre choisi, avec un court délai entre
        // deux étapes pour simuler une frappe naturelle.
        for (let s = 0; s < sequence.length; s += 1) {
          const step = sequence[s];
          if (step.type === 'media') {
            await whatsapp.sendMedia(to, step);
          } else {
            await whatsapp.sendMessage(to, replaceVariables(step.text, { nom }));
          }
          if (s < sequence.length - 1) {
            await sleep(randomDelay(seqMinMs, seqMaxMs));
          }
        }
      } else if (Array.isArray(mediaList) && mediaList.length > 0) {
        // Rafale de pièces jointes au même destinataire (voir
        // runCampaignQueue pour la même logique côté envoi immédiat) : la
        // légende n'est portée que par la première.
        const caption = replaceVariables(entry.message, { nom });
        for (let m = 0; m < mediaList.length; m += 1) {
          await whatsapp.sendMedia(to, { ...mediaList[m], caption: m === 0 ? caption : undefined });
        }
      } else {
        await whatsapp.sendMessage(to, replaceVariables(entry.message, { nom }));
      }
      results.push({ to, status: 'delivered' });
    } catch (err) {
      results.push({ to, status: 'failed', error: err.message || String(err) });
    }
    if (i < recipients.length - 1) {
      await sleep(randomDelay(8000, 15000));
    }
  }
  return results;
}

async function dispatchScheduledTelegram(entry, media) {
  const targets = entry.recipients;
  const results = [];

  for (let i = 0; i < targets.length; i += 1) {
    try {
      // 'contacts' : identifiants importés (username/téléphone) à résoudre —
      // voir resolveRecipient(). 'groups' : identifiants de groupes/canaux
      // déjà connus (getGroups()), utilisables directement.
      const destination = entry.recipientType === 'contacts'
        ? await telegram.resolveRecipient(targets[i])
        : targets[i];

      if (media) {
        await telegram.sendMedia(destination, { ...media, caption: entry.message });
      } else {
        await telegram.sendMessage(destination, entry.message);
      }
      results.push({ to: String(targets[i]), status: 'delivered' });
    } catch (err) {
      results.push({ to: String(targets[i]), status: 'failed', error: err.message || String(err) });
    }
    if (i < targets.length - 1) {
      await sleep(randomDelay(10000, 15000));
    }
  }
  return results;
}

async function dispatchScheduledFacebookPage(entry, media) {
  const pageResult = await facebook.publishPost({
    message: entry.message,
    mediaBuffer: media ? media.buffer : null,
    mediaMimetype: media ? media.mimetype : null,
    mediaFilename: media ? media.filename : null,
  });

  const groupResults = [];
  const groupIds = Array.isArray(entry.recipients) ? entry.recipients : [];
  for (let i = 0; i < groupIds.length; i += 1) {
    try {
      await facebook.publishToGroup(groupIds[i], {
        message: entry.message,
        mediaBuffer: media ? media.buffer : null,
        mediaMimetype: media ? media.mimetype : null,
        mediaFilename: media ? media.filename : null,
      });
      groupResults.push({ to: groupIds[i], status: 'published' });
    } catch (err) {
      groupResults.push({ to: groupIds[i], status: 'failed', error: err.message || String(err) });
    }
    if (i < groupIds.length - 1) {
      await sleep(randomDelay(10000, 15000));
    }
  }

  return { page: pageResult, groups: groupResults };
}

let scheduledMessagesTickRunning = false;

// Cycle périodique (toutes les 60s) : repère les programmations "pending"
// dont la date est atteinte et déclenche leur envoi via le contrôleur du
// canal concerné. Un échec (compteur "attempts") est retenté au cycle
// suivant jusqu'à MAX_ATTEMPTS, puis marqué "failed" définitivement.
async function runScheduledMessagesTick() {
  if (scheduledMessagesTickRunning) {
    return;
  }
  scheduledMessagesTickRunning = true;

  try {
    const due = scheduledMessages.getDuePending();

    for (const entry of due) {
      scheduledMessages.update(entry.id, { status: 'sending' });

      try {
        const mediaList = await resolveScheduledMediaList(entry);
        let result;

        if (entry.channel === 'whatsapp') {
          result = await dispatchScheduledWhatsapp(entry, mediaList);
        } else if (entry.channel === 'telegram') {
          result = await dispatchScheduledTelegram(entry, mediaList[0] || null);
        } else if (entry.channel === 'facebook_page') {
          result = await dispatchScheduledFacebookPage(entry, mediaList[0] || null);
        } else {
          throw new Error(`Canal de programmation inconnu : ${entry.channel}`);
        }

        scheduledMessages.update(entry.id, {
          status: 'sent',
          sentAt: new Date().toISOString(),
          result,
          lastError: null,
        });
        console.log(`Programmation ${entry.id} (${entry.channel}) : envoyée.`);
      } catch (err) {
        const attempts = (entry.attempts || 0) + 1;
        const failed = attempts >= scheduledMessages.MAX_ATTEMPTS;
        scheduledMessages.update(entry.id, {
          status: failed ? 'failed' : 'pending',
          attempts,
          lastError: err.message || String(err),
        });
        console.error(
          `Programmation ${entry.id} (${entry.channel}) : échec (tentative ${attempts}/${scheduledMessages.MAX_ATTEMPTS}) —`,
          err.message || err,
        );
      }
    }
  } finally {
    scheduledMessagesTickRunning = false;
  }
}

const SCHEDULED_MESSAGES_TICK_MS = 60 * 1000;
const scheduledMessagesInterval = setInterval(() => {
  runScheduledMessagesTick().catch((err) => {
    console.error('Erreur pendant le cycle de programmation multi-canal:', err);
  });
}, SCHEDULED_MESSAGES_TICK_MS);
// Ne bloque jamais l'arrêt propre du process (même principe que les autres
// setInterval de ce fichier/des adaptateurs).
if (scheduledMessagesInterval.unref) scheduledMessagesInterval.unref();

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
      startCampaign(recipients, { sequence: [{ type: 'text', text: campaignMessage.trim() }], delaySeconds });
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

// Route ultra-légère dédiée au keep-alive (auto-ping interne + surveillance
// externe) : aucune lecture disque/réseau, aucune authentification, réponse
// immédiate — ne doit jamais devenir un goulot d'étranglement même appelée
// très fréquemment.
app.get('/ping', (req, res) => {
  res.status(200).json({ status: 'active', timestamp: Date.now() });
});

app.get(['/', '/dashboard'], (req, res) => {
  res.sendFile(DASHBOARD_PATH);
});

// Pages légales publiques (Politique de confidentialité, CGU, suppression des
// données) requises pour la configuration de l'app Meta for Developers
// (Réglages > Général) et pour toute demande d'Accès avancé (App Review).
// Aucune authentification : Meta doit pouvoir y accéder librement.
app.get('/legal/privacy', (req, res) => {
  res.sendFile(PRIVACY_POLICY_PATH);
});

app.get('/legal/terms', (req, res) => {
  res.sendFile(TERMS_OF_SERVICE_PATH);
});

app.get('/legal/data-deletion', (req, res) => {
  res.sendFile(DATA_DELETION_PATH);
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
    telegram: telegram.getStorageStatus(),
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
    // requestPairingCode purge et relance une connexion fraîche en interne si
    // besoin (voir adapters/whatsapp.js) — une demande explicite de code ne
    // doit jamais rester bloquée par un état "déjà connecté".
    const code = await whatsapp.requestPairingCode(phoneNumber);
    res.status(200).json({ code });
  } catch (err) {
    console.error('Erreur lors de la génération du code d\'association:', err);
    res.status(500).json({ error: 'Échec de la génération du code d\'association.' });
  }
});

// Déconnexion manuelle, ou réinitialisation de secours si la session semble
// bloquée (bouton "Réinitialiser / Se déconnecter de WhatsApp" du dashboard,
// toujours accessible quel que soit le statut affiché) : ferme le socket,
// purge la session locale et distante, puis relance une connexion fraîche.
app.post('/api/whatsapp/logout', requireAccess, requireModule('whatsapp'), async (req, res) => {
  try {
    await whatsapp.logout();
    res.status(200).json({ status: 'logged_out' });
  } catch (err) {
    console.error('Erreur lors de la déconnexion WhatsApp:', err);
    res.status(500).json({ error: 'Échec de la déconnexion WhatsApp.' });
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

// Extraction consolidée des membres d'un ou plusieurs groupes sélectionnés
// vers un unique fichier Excel téléchargeable (module de gestion des
// contacts) : un même membre présent dans plusieurs groupes cochés n'apparaît
// qu'une fois, avec la liste de ces groupes en colonne "groupes".
app.post('/api/groups/export-members', requireAccess, requireModule('whatsapp'), async (req, res) => {
  let { groupIds } = req.body || {};
  if (typeof groupIds === 'string') {
    try {
      groupIds = JSON.parse(groupIds);
    } catch (err) {
      groupIds = groupIds.split(',').map((id) => id.trim()).filter(Boolean);
    }
  }

  if (!Array.isArray(groupIds) || groupIds.length === 0) {
    return res.status(400).json({ error: 'Fournissez "groupIds" (tableau d\'identifiants de groupes sélectionnés).' });
  }

  try {
    // Un même membre présent dans plusieurs groupes cochés n'apparaît qu'une
    // fois (Map indexée par le vrai JID téléphone). "telephone" est extrait
    // de participant.jid, PAS participant.id : pour un participant ayant
    // activé la confidentialité WhatsApp "masquer mon numéro", .id porte un
    // identifiant anonyme (@lid) sans rapport avec son numéro réel — voir
    // extractGroupMetadata() dans Baileys (lib/Socket/groups.js), qui
    // distingue explicitement .id (adressage, peut être un @lid) de .jid (le
    // vrai numéro, dérivé de l'attribut phone_number quand .id est un @lid).
    // Un participant dont le numéro réel reste indérivable (confidentialité +
    // jamais "rencontré" par ce compte) est omis du fichier plutôt que d'y
    // laisser une ligne avec un téléphone vide ou erroné.
    //
    // "nom" vient du cache opportuniste de noms publics (pushName/notify)
    // constitué par l'adaptateur au fil des messages/contacts déjà vus par ce
    // compte (voir adapters/whatsapp.js#getContactName), cherché sous le JID
    // téléphone puis, à défaut, sous le @lid observé pour ce même
    // participant — WhatsApp n'expose aucune API pour récupérer le nom
    // public d'un numéro qu'on n'a jamais "rencontré", donc ce champ peut
    // rester vide.
    const merged = new Map(); // phoneJid -> lidJid (repli pour la recherche du nom)
    for (const groupId of groupIds) {
      const participants = await whatsapp.getGroupParticipants(groupId);
      (participants || []).forEach((p) => {
        const phoneJid = p.jid && !p.jid.endsWith('@lid')
          ? p.jid
          : (p.id && !p.id.endsWith('@lid') ? p.id : null);
        if (phoneJid) {
          merged.set(phoneJid, p.lid || (p.id !== phoneJid ? p.id : null));
        }
      });
    }

    const rows = Array.from(merged.entries()).map(([phoneJid, lidJid]) => ({
      telephone: jidToE164(phoneJid),
      nom: whatsapp.getContactName(phoneJid) || (lidJid ? whatsapp.getContactName(lidJid) : '') || '',
    }));

    const sheet = XLSX.utils.json_to_sheet(rows);

    // Force la colonne "telephone" (A) en TEXTE (format '@') : sans ça,
    // Excel peut réinterpréter un numéro à 11-12 chiffres comme un nombre et
    // l'afficher en notation scientifique (ex: "1,92595E+14") — les chiffres
    // affichés sont alors tronqués/arrondis à l'écran (pas les données du
    // fichier lui-même, mais c'est trompeur pour quiconque relit ou recopie
    // cette valeur).
    if (sheet['!ref']) {
      const range = XLSX.utils.decode_range(sheet['!ref']);
      for (let r = range.s.r + 1; r <= range.e.r; r += 1) {
        const cellRef = XLSX.utils.encode_cell({ r, c: 0 });
        const cell = sheet[cellRef];
        if (cell) {
          cell.t = 's';
          cell.z = '@';
          cell.v = String(cell.v);
        }
      }
    }

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Membres');
    const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="membres_groupes_whatsapp.xlsx"');
    res.status(200).send(buffer);
  } catch (err) {
    console.error('Erreur lors de l\'extraction des membres des groupes:', err);
    res.status(500).json({ error: 'Échec de l\'extraction des membres des groupes sélectionnés.' });
  }
});

app.post('/api/messages/queue', requireAccess, requireModule('whatsapp'), whatsappMediaUpload.array('media', 10), async (req, res) => {
  const { message, groupId, delaySeconds, batchSize, sequenceDelayMin, sequenceDelayMax } = req.body;
  let { recipients, groupIds, sequence } = req.body;

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

  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({
      error: 'Fournissez "recipients" (tableau ou liste), "groupId" ou "groupIds".',
    });
  }

  if (typeof sequence === 'string') {
    try {
      sequence = JSON.parse(sequence);
    } catch (err) {
      sequence = null;
    }
  }

  const files = req.files || [];

  // sequence (tableau, voir Séquençage / Envoi Multi-Messages) décrit l'ordre
  // exact des étapes ({type:'text', text} ou {type:'media'}) ; les étapes
  // média consomment les fichiers téléversés dans le même ordre. Sans
  // "sequence" fournie, on retombe sur l'ancien comportement (un seul texte +
  // pièces jointes envoyées à la suite), pour ne rien casser côté appelants
  // existants.
  let resolvedSequence;
  if (Array.isArray(sequence) && sequence.length > 0) {
    resolvedSequence = [];
    let fileIdx = 0;
    for (const step of sequence) {
      if (step && step.type === 'media') {
        const file = files[fileIdx];
        fileIdx += 1;
        if (!file) {
          return res.status(400).json({
            error: 'Le nombre de fichiers envoyés ne correspond pas au nombre d\'étapes média de la séquence.',
          });
        }
        resolvedSequence.push(await buildWhatsappMediaStep(file));
      } else {
        resolvedSequence.push({ type: 'text', text: String((step && step.text) || '') });
      }
    }
    if (fileIdx !== files.length) {
      return res.status(400).json({
        error: 'Le nombre de fichiers envoyés ne correspond pas au nombre d\'étapes média de la séquence.',
      });
    }
  } else {
    resolvedSequence = [];
    if (message) resolvedSequence.push({ type: 'text', text: message });
    for (const file of files) {
      resolvedSequence.push(await buildWhatsappMediaStep(file));
    }
  }

  if (resolvedSequence.length === 0) {
    return res.status(400).json({ error: 'Fournissez au moins un message texte ou un média dans la séquence.' });
  }

  const fixedDelaySeconds = delaySeconds !== undefined && delaySeconds !== '' ? parseFloat(delaySeconds) : undefined;
  const parsedBatchSize = batchSize !== undefined && batchSize !== '' ? parseInt(batchSize, 10) : undefined;
  // Délai court entre les messages d'une même séquence (2-5s par défaut,
  // pour simuler une frappe naturelle) — distinct du délai plus long
  // (delaySeconds, 8-15s) appliqué entre deux destinataires différents.
  const seqDelayMinMs = Math.max(1, parseFloat(sequenceDelayMin) || 2) * 1000;
  const seqDelayMaxMs = Math.max(seqDelayMinMs, (parseFloat(sequenceDelayMax) || 5) * 1000);

  let campaign;
  try {
    campaign = startCampaign(recipients, {
      delaySeconds: fixedDelaySeconds,
      batchSize: parsedBatchSize,
      sequence: resolvedSequence,
      sequenceDelayMinMs: seqDelayMinMs,
      sequenceDelayMaxMs: seqDelayMaxMs,
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
    steps: resolvedSequence.length,
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

    // "nom" (variable de personnalisation {nom}, voir replaceVariables) est
    // reconnu depuis une colonne "nom"/"Nom" dédiée (produite par
    // /api/groups/export-members) et, à défaut, depuis les mêmes colonnes que
    // "prenom" (rétrocompatibilité avec d'anciens fichiers importés) —
    // "prenom" reste renseigné séparément pour ne rien casser côté appelants
    // existants qui le lisent encore.
    const contacts = rows
      .map((row) => {
        const prenom = String(row.prenom || row.Prenom || row.name || row.Name || '').trim();
        return {
          telephone: String(row.telephone || row.Telephone || row.phone || row.Phone || row.numero || row.Numero || '').trim(),
          prenom,
          nom: String(row.nom || row.Nom || prenom || '').trim(),
        };
      })
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

// Déconnexion dédiée à Facebook (bouton "Se déconnecter de Facebook" du
// dashboard) — indépendante des autres canaux : n'affecte ni WhatsApp ni
// Telegram. Voir facebook.disconnect() : si un jeton est aussi configuré en
// variable d'environnement sur Render, il reprend le relais automatiquement
// (envTokenStillActive dans la réponse) — ce bouton ne peut couper qu'un
// jeton obtenu via OAuth.
app.post('/api/facebook/logout', requireAccess, requireModule('facebook'), (req, res) => {
  const result = facebook.disconnect();
  res.status(200).json({ status: 'logged_out', ...result });
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

// Renommée depuis /api/facebook/groups (nom trompeur : ceci renvoie les
// conversations Messenger de la Page, pas des Groupes Facebook) — cette
// route entrait en collision avec le GET /api/facebook/groups des Groupes
// gérés plus bas, qu'elle masquait silencieusement (Express retient le
// premier handler enregistré sur un chemin donné). Non utilisée par le
// frontend actuel, conservée par compatibilité au cas où un appelant externe
// l'utiliserait encore.
app.get('/api/facebook/conversations', requireAccess, requireModule('facebook'), async (req, res) => {
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

  const { message, delaySeconds, minDelaySeconds, maxDelaySeconds, batchSize } = req.body;
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
  // Fenêtre de temporisation par défaut : 5 à 10s aléatoires entre chaque
  // envoi (cf. cahier des charges), surchageable via minDelaySeconds/
  // maxDelaySeconds, ou fixée précisément via delaySeconds.
  const parsedMinDelay = minDelaySeconds !== undefined && minDelaySeconds !== '' ? parseFloat(minDelaySeconds) : 5;
  const parsedMaxDelay = maxDelaySeconds !== undefined && maxDelaySeconds !== '' ? parseFloat(maxDelaySeconds) : 10;
  const parsedBatchSize = batchSize !== undefined && batchSize !== '' ? parseInt(batchSize, 10) : undefined;
  const media = req.file
    ? { buffer: req.file.buffer, mimetype: req.file.mimetype, filename: req.file.originalname }
    : null;

  res.status(202).json({
    status: 'fb_queue_started',
    total: recipients.length,
    delaySeconds: fixedDelaySeconds || `${parsedMinDelay}-${parsedMaxDelay} (aléatoire)`,
    batchSize: parsedBatchSize || recipients.length,
    media: media ? media.filename : null,
  });

  facebook.sendBulk(recipients, message, {
    delaySeconds: fixedDelaySeconds,
    minDelaySeconds: fixedDelaySeconds ? undefined : parsedMinDelay,
    maxDelaySeconds: fixedDelaySeconds ? undefined : parsedMaxDelay,
    batchSize: parsedBatchSize,
    media,
  }).then((results) => {
    const success = results.filter((r) => r.status === 'delivered').length;
    console.log(`Facebook Messenger: campagne terminée (${success}/${results.length} réussite(s)).`);
  }).catch((err) => {
    console.error('Erreur pendant la campagne Facebook Messenger:', err);
  });
});

// ---------- Publication automatique sur la Page (feed), avec diffusion
// optionnelle vers les Groupes gérés ----------
app.post('/api/facebook/publish', requireAccess, requireModule('facebook'), upload.single('media'), async (req, res) => {
  if (!facebook.isConfigured()) {
    return res.status(503).json({
      error: 'Intégration Facebook non configurée (variable FB_PAGE_ACCESS_TOKEN manquante).',
    });
  }

  const { message, link, scheduledPublishTime, broadcastToGroups } = req.body;
  if (!message && !req.file) {
    return res.status(400).json({ error: 'Fournissez un "message" et/ou un média (champ "media") à publier.' });
  }
  if (req.file && req.file.mimetype === 'application/pdf') {
    return res.status(400).json({
      error: 'L\'API Graph de Meta ne permet pas de déposer un document PDF sur une publication de Page (seuls '
        + 'texte/lien, photo et vidéo sont supportés). Hébergez le PDF ailleurs et partagez son lien dans le message.',
    });
  }

  const shouldBroadcast = broadcastToGroups === 'true' || broadcastToGroups === true;
  if (shouldBroadcast && facebook.getManagedGroups().length === 0) {
    return res.status(400).json({ error: 'Aucun Groupe géré. Ajoutez-en avant d\'activer la diffusion vers les Groupes.' });
  }
  if (shouldBroadcast && !facebook.getUserAccessToken()) {
    return res.status(503).json({
      error: 'Diffusion vers les Groupes indisponible : reconnectez-vous via "Se connecter avec Facebook" '
        + '(nécessite un jeton utilisateur) et vérifiez que la permission publish_to_groups a été accordée par Meta.',
    });
  }

  let result;
  try {
    result = await facebook.publishPost({
      message,
      link,
      scheduledPublishTime,
      mediaBuffer: req.file ? req.file.buffer : null,
      mediaMimetype: req.file ? req.file.mimetype : null,
      mediaFilename: req.file ? req.file.originalname : null,
    });
  } catch (err) {
    console.error('Erreur lors de la publication Facebook:', err?.response?.data || err.message);
    return res.status(500).json({ error: 'Échec de la publication sur la Page Facebook.' });
  }

  if (!shouldBroadcast) {
    return res.status(200).json({ page: result, groupBroadcast: null });
  }

  const groups = facebook.getManagedGroups();
  res.status(200).json({
    page: result,
    groupBroadcast: { status: 'started', total: groups.length, delaySeconds: '10-15 (aléatoire)' },
  });

  // Diffusion vers les Groupes lancée en arrière-plan, indépendamment de la
  // programmation éventuelle du post de Page (voir cahier des charges :
  // "publie sur la Page puis programme l'envoi vers les groupes").
  facebook.publishToManagedGroups({
    message,
    mediaBuffer: req.file ? req.file.buffer : null,
    mediaMimetype: req.file ? req.file.mimetype : null,
    mediaFilename: req.file ? req.file.originalname : null,
    minDelaySeconds: 10,
    maxDelaySeconds: 15,
  }).then((results) => {
    const success = results.filter((r) => r.status === 'published').length;
    console.log(`Facebook: diffusion sur les groupes (depuis la publication de Page) terminée (${success}/${results.length} réussite(s)).`);
  }).catch((err) => {
    console.error('Erreur pendant la diffusion sur les groupes Facebook (depuis la publication de Page):', err);
  });
});

// ---------- Gestion des commentaires (modération) ----------
app.get('/api/facebook/posts/:postId/comments', requireAccess, requireModule('facebook'), async (req, res) => {
  if (!facebook.isConfigured()) {
    return res.status(503).json({
      error: 'Intégration Facebook non configurée (variable FB_PAGE_ACCESS_TOKEN manquante).',
    });
  }

  try {
    const comments = await facebook.getPostComments(req.params.postId);
    res.status(200).json(comments);
  } catch (err) {
    console.error('Erreur lors de la récupération des commentaires Facebook:', err?.response?.data || err.message);
    res.status(500).json({ error: 'Échec de la récupération des commentaires.' });
  }
});

app.post('/api/facebook/comments/:commentId/reply', requireAccess, requireModule('facebook'), async (req, res) => {
  if (!facebook.isConfigured()) {
    return res.status(503).json({
      error: 'Intégration Facebook non configurée (variable FB_PAGE_ACCESS_TOKEN manquante).',
    });
  }

  const { message } = req.body;
  if (!message) {
    return res.status(400).json({ error: 'Le champ "message" est requis.' });
  }

  try {
    const result = await facebook.replyToComment(req.params.commentId, message);
    res.status(200).json(result);
  } catch (err) {
    console.error('Erreur lors de la réponse au commentaire Facebook:', err?.response?.data || err.message);
    res.status(500).json({ error: 'Échec de la réponse au commentaire.' });
  }
});

app.post('/api/facebook/comments/:commentId/moderate', requireAccess, requireModule('facebook'), async (req, res) => {
  if (!facebook.isConfigured()) {
    return res.status(503).json({
      error: 'Intégration Facebook non configurée (variable FB_PAGE_ACCESS_TOKEN manquante).',
    });
  }

  try {
    const result = await facebook.moderateComment(req.params.commentId, { hide: req.body.hide !== false });
    res.status(200).json(result);
  } catch (err) {
    console.error('Erreur lors de la modération du commentaire Facebook:', err?.response?.data || err.message);
    res.status(500).json({ error: 'Échec de la modération du commentaire.' });
  }
});

app.delete('/api/facebook/comments/:commentId', requireAccess, requireModule('facebook'), async (req, res) => {
  if (!facebook.isConfigured()) {
    return res.status(503).json({
      error: 'Intégration Facebook non configurée (variable FB_PAGE_ACCESS_TOKEN manquante).',
    });
  }

  try {
    const result = await facebook.deleteComment(req.params.commentId);
    res.status(200).json(result);
  } catch (err) {
    console.error('Erreur lors de la suppression du commentaire Facebook:', err?.response?.data || err.message);
    res.status(500).json({ error: 'Échec de la suppression du commentaire.' });
  }
});

// ---------- Webhooks Meta : Capture Automatique de Prospects ----------
// Validation initiale de l'abonnement (Meta App Dashboard > Webhooks).
// FB_WEBHOOK_VERIFY_TOKEN est une chaîne arbitraire choisie par l'exploitant,
// à saisir aussi côté Meta lors de la configuration du webhook.
app.get('/api/facebook/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token && token === process.env.FB_WEBHOOK_VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

// Heuristique simple "prénom nom" à partir d'un nom complet — utilisée pour
// les commentaires, dont le webhook "feed" fournit directement from.name
// (pas de champs prénom/nom séparés côté Meta pour un commentateur).
function splitDisplayName(fullName) {
  if (!fullName) return { firstName: null, lastName: null };
  const parts = String(fullName).trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: null };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// Envoie la réponse automatique (texte via réponse privée + média éventuel
// en message Messenger de suivi) associée à une règle de mot-clé détectée
// sur un commentaire, puis marque le contact comme "répondu".
async function autoReplyToComment(rule, contact, commentId, psid) {
  if (rule.replyMessage) {
    await facebook.sendPrivateReply(commentId, rule.replyMessage);
  }
  if (rule.mediaUrl) {
    const media = await resolveKeywordRuleMedia(rule);
    if (media) {
      await facebook.sendMedia(psid, media);
    }
  }
  contactsStore.markAutoReplied(contact.id);
  console.log(`Prospect: réponse automatique envoyée (commentaire, mot-clé "${rule.keyword}") à PSID ${psid}.`);
}

// Même chose pour un message Messenger entrant contenant un mot-clé — pas de
// réponse privée nécessaire ici, la conversation est déjà ouverte.
async function autoReplyToMessage(rule, contact, psid) {
  if (rule.replyMessage) {
    await facebook.sendMessage(psid, rule.replyMessage);
  }
  if (rule.mediaUrl) {
    const media = await resolveKeywordRuleMedia(rule);
    if (media) {
      await facebook.sendMedia(psid, media);
    }
  }
  contactsStore.markAutoReplied(contact.id);
  console.log(`Prospect: réponse automatique envoyée (message, mot-clé "${rule.keyword}") à PSID ${psid}.`);
}

// Nouveau commentaire sur un post/pub de la Page (abonnement "feed", champ
// "feed", value.item === "comment"). Capture le contact puis, si le texte
// contient un mot-clé configuré, déclenche la réponse automatique.
async function handleFacebookFeedChange(value) {
  if (value.item !== 'comment' || value.verb !== 'add') {
    return;
  }

  const psid = value.from && value.from.id;
  if (!psid) {
    return;
  }

  const commentText = value.message || '';
  const { firstName, lastName } = splitDisplayName(value.from.name);
  const rule = keywordRules.findMatch(commentText);

  const contact = contactsStore.upsertFromLead({
    psid,
    firstName,
    lastName,
    name: value.from.name,
    source: 'comment',
    sourceText: commentText,
    postId: value.post_id || null,
    keyword: rule ? rule.keyword : null,
  });

  if (!rule) {
    return;
  }

  try {
    await autoReplyToComment(rule, contact, value.comment_id, psid);
  } catch (err) {
    console.error(`Prospect: échec de la réponse automatique (commentaire) pour PSID ${psid}:`, err?.response?.data || err.message);
  }
}

// Message Messenger entrant (entry.messaging[], pas entry.changes[]).
async function handleFacebookMessagingEvent(event) {
  const psid = event.sender && event.sender.id;
  const text = event.message && event.message.text;
  if (!psid || !text) {
    return;
  }

  const rule = keywordRules.findMatch(text);
  const profile = await facebook.getUserProfile(psid);

  const contact = contactsStore.upsertFromLead({
    psid,
    firstName: profile.first_name || null,
    lastName: profile.last_name || null,
    name: profile.name || null,
    source: 'message',
    sourceText: text,
    postId: null,
    keyword: rule ? rule.keyword : null,
  });

  if (!rule) {
    return;
  }

  try {
    await autoReplyToMessage(rule, contact, psid);
  } catch (err) {
    console.error(`Prospect: échec de la réponse automatique (message) pour PSID ${psid}:`, err?.response?.data || err.message);
  }
}

// Réception des évènements. Le payload est déjà parsé par le express.json()
// global (voir plus haut) qui capture aussi req.rawBody pour la vérification
// de signature HMAC — indispensable ici puisque cette route est publique par
// nature (appelée par les serveurs de Meta, sans notre authentification).
app.post('/api/facebook/webhook', (req, res) => {
  const signature = req.get('x-hub-signature-256');
  if (!facebook.verifyWebhookSignature(req.rawBody, signature)) {
    return res.sendStatus(403);
  }

  // Accusé de réception immédiat (Meta exige une réponse rapide) : le
  // traitement de la capture/réponse automatique continue en arrière-plan.
  res.sendStatus(200);

  (req.body.entry || []).forEach((entry) => {
    (entry.changes || []).forEach((change) => {
      if (change.field === 'feed') {
        handleFacebookFeedChange(change.value).catch((err) => {
          console.error('Erreur lors du traitement d\'un évènement feed Facebook:', err);
        });
      }
    });

    (entry.messaging || []).forEach((event) => {
      handleFacebookMessagingEvent(event).catch((err) => {
        console.error('Erreur lors du traitement d\'un évènement Messenger:', err);
      });
    });
  });
});

// ---------- Règles de mots-clés (réponse automatique aux prospects) ----------
app.get('/api/facebook/keyword-rules', requireAccess, requireModule('facebook'), (req, res) => {
  res.status(200).json({ rules: keywordRules.list() });
});

app.post('/api/facebook/keyword-rules', requireAccess, requireModule('facebook'), upload.single('media'), (req, res) => {
  const { keyword, replyMessage, mediaUrl } = req.body;
  if (!keyword || !keyword.trim()) {
    return res.status(400).json({ error: 'Le champ "keyword" est requis.' });
  }
  if (!replyMessage && !req.file && !mediaUrl) {
    return res.status(400).json({ error: 'Fournissez un "replyMessage" et/ou un média (fichier joint ou "mediaUrl").' });
  }

  let storedMediaUrl = mediaUrl || null;
  let mediaMimetype = null;
  let mediaFilename = null;

  if (req.file) {
    const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    fs.writeFileSync(path.join(KEYWORD_MEDIA_DIR, safeName), req.file.buffer);
    storedMediaUrl = `local:${safeName}`;
    mediaMimetype = req.file.mimetype;
    mediaFilename = req.file.originalname;
  }

  const rule = keywordRules.create({
    keyword,
    replyMessage,
    mediaUrl: storedMediaUrl,
    mediaMimetype,
    mediaFilename,
  });
  res.status(201).json({ rule });
});

app.delete('/api/facebook/keyword-rules/:id', requireAccess, requireModule('facebook'), (req, res) => {
  const rules = keywordRules.remove(req.params.id);
  res.status(200).json({ rules });
});

// ---------- Prospects capturés (commentaires + messages Messenger) ----------
app.get('/api/facebook/prospects', requireAccess, requireModule('facebook'), (req, res) => {
  const { keyword, source } = req.query;
  res.status(200).json({ contacts: contactsStore.list({ keyword: keyword || undefined, source: source || undefined }) });
});

app.get('/api/facebook/prospects/export-excel', requireAccess, requireModule('facebook'), (req, res) => {
  const { keyword, source } = req.query;
  const contacts = contactsStore.list({ keyword: keyword || undefined, source: source || undefined });

  const sheet = XLSX.utils.json_to_sheet(
    contacts.map((c) => ({
      Prénom: c.firstName || '',
      Nom: c.lastName || '',
      'Nom complet': c.name || '',
      'PSID (Facebook)': c.psid,
      Source: c.source === 'comment' ? 'Commentaire' : 'Message Messenger',
      Thématique: c.keyword || '',
      'Dernier texte': c.lastText || '',
      'ID du post': c.postId || '',
      'Réponse automatique envoyée': c.autoReplied ? 'Oui' : 'Non',
      'Capturé le': c.createdAt,
      'Mis à jour le': c.updatedAt,
    })),
  );
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Prospects');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="prospects_facebook.xlsx"');
  res.send(buffer);
});

// ---------- Import du registre de contacts (.xlsx/.csv) ----------
// Ne renvoie comme destinataires exploitables (recipientId/matched=true) que
// les contacts déjà en conversation Messenger avec la Page — voir le
// commentaire de resolveRecipientsFromConversations() dans adapters/facebook.js
// pour la raison (règle des 24h/message tags de l'API Graph).
app.post('/api/facebook/contacts/import', requireAccess, requireModule('facebook'), upload.single('file'), async (req, res) => {
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
    console.error('Erreur lors de la lecture du fichier de contacts Facebook:', err);
    return res.status(400).json({ error: 'Fichier invalide. Utilisez un fichier .csv ou .xlsx.' });
  }

  const contacts = rows
    .map((row) => ({
      psid: String(row.psid || row.PSID || row.recipientId || row.id || '').trim() || null,
      name: String(row.prenom || row.Prenom || row.nom || row.Nom || row.name || row.Name || '').trim(),
    }))
    .filter((c) => c.psid || c.name);

  if (!facebook.isConfigured()) {
    return res.status(200).json({ contacts, total: contacts.length, matched: 0 });
  }

  try {
    const resolved = await facebook.resolveRecipientsFromConversations(contacts);
    res.status(200).json({
      contacts: resolved,
      total: resolved.length,
      matched: resolved.filter((c) => c.matched).length,
    });
  } catch (err) {
    console.error('Erreur lors de la résolution des contacts Facebook:', err?.response?.data || err.message);
    res.status(500).json({ error: 'Échec de la résolution des contacts par rapport aux conversations Messenger existantes.' });
  }
});

// ---------- Publication programmée sur les Groupes Facebook gérés ----------
// Voir le commentaire au-dessus de getManagedGroups() dans adapters/facebook.js :
// la liste des Groupes ciblés est administrée manuellement (pas d'endpoint
// Graph API pour les découvrir automatiquement à partir d'une Page).
app.get('/api/facebook/groups', requireAccess, requireModule('facebook'), (req, res) => {
  const groups = facebook.getManagedGroups().map((g) => ({ ...g, link: `https://www.facebook.com/groups/${g.id}` }));
  res.status(200).json({ groups });
});

// Publications récentes de la Page — utilisé par le module "Groupes /
// Partage" pour choisir quelle publication partager (voir
// getPagePosts() dans adapters/facebook.js).
// getPagePosts() (adapters/facebook.js) utilise getPageAccessToken(), pas
// getUserAccessToken() : lister les publications d'une Page est une action
// de Page normale, qui n'a jamais eu besoin du jeton utilisateur (celui-ci
// n'est nécessaire que pour publier dans un Groupe, une action au nom d'un
// utilisateur — voir publishToGroup). Le message d'erreur renvoyé ici
// inclut le détail brut retourné par Meta (err?.response?.data?.error?.message,
// ex : jeton expiré, permission manquante) plutôt qu'un message générique,
// pour rester diagnosticable sans avoir à lire les logs serveur — et ne
// fait jamais planter le process, seulement échouer cette requête.
app.get('/api/facebook/page-posts', requireAccess, requireModule('facebook'), async (req, res) => {
  if (!facebook.isConfigured()) {
    return res.status(503).json({
      error: 'Intégration Facebook non configurée (variable FB_PAGE_ACCESS_TOKEN manquante).',
    });
  }
  try {
    const posts = await facebook.getPagePosts({ limit: 20 });
    res.status(200).json({ posts });
  } catch (err) {
    const metaError = err?.response?.data?.error;
    console.error('Erreur lors de la récupération des publications de la Page:', err?.response?.data || err.message);

    // Code 10 = permission manquante côté Meta. Le scope peut être correct
    // (pages_read_engagement/pages_read_user_content demandés — voir
    // getAuthUrl) sans que Meta honore pour autant l'appel : ça arrive tant
    // que l'app n'est pas passée en App Review pour un "Advanced Access" sur
    // ces permissions, ce qu'aucun changement de code ne peut contourner —
    // d'où le message explicite plutôt qu'une erreur générique, et le mode
    // de secours côté dashboard (lien collé manuellement).
    if (metaError?.code === 10) {
      return res.status(502).json({
        error: 'Permission Facebook manquante ou pas encore approuvée par Meta (pages_read_engagement / '
          + 'pages_read_user_content). Reconnectez-vous via "Se connecter avec Facebook" pour accorder ces '
          + 'permissions ; si l\'erreur persiste, l\'app doit être validée par Meta (App Review) pour un accès '
          + '"Advanced Access" à ces permissions. En attendant, collez manuellement le lien de la publication '
          + 'ci-dessous.',
        code: 10,
      });
    }

    res.status(502).json({
      error: metaError?.message
        ? `Échec de la récupération des publications de la Page (Meta : "${metaError.message}").`
        : 'Échec de la récupération des publications récentes de la Page. Vérifiez que la connexion Facebook '
          + '(onglet Connexions) est active et que le jeton n\'a pas expiré.',
    });
  }
});

/**
 * Mode B ("message personnalisé") du module Groupes / Diffusion : la
 * fenêtre de partage officielle Facebook (sharer.php) a besoin d'une URL
 * réelle qu'elle puisse explorer pour générer son aperçu — un simple
 * fichier téléversé n'en a pas. On publie donc ce texte + média comme une
 * publication normale sur la Page (comme /api/facebook/publish), et on
 * réutilise son permalink_url comme lien à partager dans les Groupes —
 * exactement le même traitement qu'une publication existante choisie en
 * Mode A, une fois créée.
 */
app.post('/api/facebook/share/prepare-custom-post', requireAccess, requireModule('facebook'), upload.single('media'), async (req, res) => {
  if (!facebook.isConfigured()) {
    return res.status(503).json({
      error: 'Intégration Facebook non configurée (variable FB_PAGE_ACCESS_TOKEN manquante).',
    });
  }

  const { message } = req.body;
  if (!message && !req.file) {
    return res.status(400).json({ error: 'Fournissez un message et/ou un média à publier.' });
  }
  if (req.file && req.file.mimetype === 'application/pdf') {
    return res.status(400).json({
      error: 'L\'API Graph de Meta ne permet pas de joindre un PDF à une publication de Page. '
        + 'Hébergez le PDF ailleurs et collez son lien dans le message.',
    });
  }

  try {
    const created = await facebook.publishPost({
      message,
      mediaBuffer: req.file ? req.file.buffer : null,
      mediaMimetype: req.file ? req.file.mimetype : null,
      mediaFilename: req.file ? req.file.originalname : null,
    });
    // /me/feed renvoie directement {id}, mais /me/photos et /me/videos
    // renvoient l'id du média — post_id (photos) est l'identifiant du post
    // réel s'il est présent, sinon on retombe sur id. Ni l'un ni l'autre
    // endpoint ne renvoie permalink_url directement : un second appel est
    // nécessaire pour l'obtenir.
    const postId = created.post_id || created.id;
    const permalink = await facebook.getPostPermalink(postId);
    res.status(201).json({ post: { id: postId, permalink_url: permalink } });
  } catch (err) {
    const metaMessage = err?.response?.data?.error?.message;
    console.error('Erreur lors de la création du contenu personnalisé à partager:', err?.response?.data || err.message);
    res.status(502).json({
      error: metaMessage
        ? `Échec de la publication du contenu personnalisé (Meta : "${metaMessage}").`
        : 'Échec de la publication du contenu personnalisé sur la Page.',
    });
  }
});

app.post('/api/facebook/groups', requireAccess, requireModule('facebook'), (req, res) => {
  const { id, name } = req.body || {};
  if (!id) {
    return res.status(400).json({ error: 'Le champ "id" (identifiant du Groupe Facebook) est requis.' });
  }
  const groups = facebook.addManagedGroup(id, name);
  res.status(200).json({ groups });
});

app.delete('/api/facebook/groups/:id', requireAccess, requireModule('facebook'), (req, res) => {
  const groups = facebook.removeManagedGroup(req.params.id);
  res.status(200).json({ groups });
});

// Import en masse de Groupes depuis un fichier Excel/CSV — alimente la même
// liste persistée que l'ajout un par un ci-dessus (facebook_groups.json),
// pas un stockage "session" séparé : ce projet n'a pas de notion de session
// utilisateur (dashboard mono-opérateur, voir CLAUDE.md), et dupliquer la
// liste entre deux stockages aurait désynchronisé l'onglet Facebook et
// l'onglet Groupes / Partage. Colonnes attendues : "Nom du Groupe" et
// "Lien du Groupe" (l'identifiant est alors extrait du lien) ou "ID"
// directement.
app.post('/api/facebook/groups/upload', requireAccess, requireModule('facebook'), upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier fourni (champ "file").' });
  }

  let rows;
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet);
  } catch (err) {
    console.error('Erreur lors de la lecture du fichier de Groupes Facebook:', err);
    return res.status(400).json({ error: 'Fichier invalide. Utilisez un fichier .xlsx ou .csv.' });
  }

  let imported = 0;
  let skipped = 0;
  let groups = facebook.getManagedGroups();

  rows.forEach((row) => {
    const name = String(row['Nom du Groupe'] || row.Nom || row.nom || row.name || row.Name || '').trim();
    const link = String(row['Lien du Groupe'] || row.Lien || row.lien || row.link || row.Link || '').trim();
    const idColumn = String(row.ID || row.Id || row.id || '').trim();

    let id = idColumn;
    if (!id && link) {
      const match = link.match(/groups\/([^/?]+)/);
      id = match ? match[1] : '';
    }

    if (!id) {
      skipped += 1;
      return;
    }

    groups = facebook.addManagedGroup(id, name || id);
    imported += 1;
  });

  res.status(200).json({
    groups: groups.map((g) => ({ ...g, link: `https://www.facebook.com/groups/${g.id}` })),
    imported,
    skipped,
  });
});

app.post('/api/facebook/groups/publish', requireAccess, requireModule('facebook'), upload.single('media'), async (req, res) => {
  if (!facebook.getUserAccessToken()) {
    return res.status(503).json({
      error: 'Publication sur les Groupes indisponible : reconnectez-vous via "Se connecter avec Facebook" '
        + '(nécessite un jeton utilisateur, pas seulement le jeton de Page) et vérifiez que la permission '
        + 'publish_to_groups a été accordée par Meta.',
    });
  }

  const { message, minDelaySeconds, maxDelaySeconds } = req.body;
  const groups = facebook.getManagedGroups();

  if (!message && !req.file) {
    return res.status(400).json({ error: 'Fournissez un "message" et/ou un média (champ "media") à publier.' });
  }
  if (groups.length === 0) {
    return res.status(400).json({ error: 'Aucun Groupe géré. Ajoutez-en via POST /api/facebook/groups avant de publier.' });
  }
  if (req.file && req.file.mimetype === 'application/pdf') {
    return res.status(400).json({
      error: 'L\'API Graph de Meta ne permet pas de déposer un document PDF dans un Groupe (seuls texte/lien, '
        + 'photo et vidéo sont supportés). Hébergez le PDF ailleurs et partagez son lien dans le message.',
    });
  }

  const parsedMinDelay = minDelaySeconds !== undefined && minDelaySeconds !== '' ? parseFloat(minDelaySeconds) : 5;
  const parsedMaxDelay = maxDelaySeconds !== undefined && maxDelaySeconds !== '' ? parseFloat(maxDelaySeconds) : 10;

  res.status(202).json({
    status: 'fb_group_broadcast_started',
    total: groups.length,
    delaySeconds: `${parsedMinDelay}-${parsedMaxDelay} (aléatoire)`,
    media: req.file ? req.file.originalname : null,
  });

  facebook.publishToManagedGroups({
    message,
    mediaBuffer: req.file ? req.file.buffer : null,
    mediaMimetype: req.file ? req.file.mimetype : null,
    mediaFilename: req.file ? req.file.originalname : null,
    minDelaySeconds: parsedMinDelay,
    maxDelaySeconds: parsedMaxDelay,
  }).then((results) => {
    const success = results.filter((r) => r.status === 'published').length;
    console.log(`Facebook: diffusion sur les groupes terminée (${success}/${results.length} réussite(s)).`);
  }).catch((err) => {
    console.error('Erreur pendant la diffusion sur les groupes Facebook:', err);
  });
});

// Export de la liste des Groupes gérés au format Excel — mêmes données que
// GET /api/facebook/groups, mises en forme pour être partagées/archivées.
app.get('/api/facebook/groups/export-excel', requireAccess, requireModule('facebook'), (req, res) => {
  const groups = facebook.getManagedGroups();
  const sheet = XLSX.utils.json_to_sheet(
    groups.map((g) => ({
      Nom: g.name,
      Identifiant: g.id,
      'Ajouté le': g.addedAt || '',
    })),
  );
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, sheet, 'Groupes Facebook');
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="groupes_facebook.xlsx"');
  res.send(buffer);
});

app.get('/api/telegram/status', requireAccess, requireModule('telegram'), (req, res) => {
  res.status(200).json({
    configured: telegram.isConfigured(),
    connected: telegram.isConnected(),
  });
});

// Déconnexion dédiée à Telegram (bouton "Se déconnecter de Telegram" du
// dashboard) — indépendante des autres canaux : n'affecte ni WhatsApp ni
// Facebook. Repasse immédiatement en attente d'une nouvelle connexion (même
// numéro ou un autre) via POST /api/telegram/login/start.
app.post('/api/telegram/logout', requireAccess, requireModule('telegram'), async (req, res) => {
  try {
    await telegram.logout();
    res.status(200).json({ status: 'logged_out' });
  } catch (err) {
    console.error('Erreur lors de la déconnexion Telegram:', err);
    res.status(500).json({ error: 'Échec de la déconnexion Telegram.' });
  }
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

app.post('/api/telegram/campaign/send', requireAccess, requireModule('telegram'), upload.single('media'), async (req, res) => {
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
    status: 'tg_campaign_started',
    total: campaign.total,
    truncated: campaign.truncated,
  });
});

app.post('/api/telegram/campaign/pause', requireAccess, requireModule('telegram'), (req, res) => {
  if (!currentTelegramDmCampaign || currentTelegramDmCampaign.status !== 'running') {
    return res.status(400).json({ error: 'Aucune campagne Telegram en cours à mettre en pause.' });
  }

  currentTelegramDmCampaign.userPaused = true;
  res.status(200).json({ status: 'pause_requested' });
});

app.post('/api/telegram/campaign/resume', requireAccess, requireModule('telegram'), (req, res) => {
  if (!currentTelegramDmCampaign || currentTelegramDmCampaign.status !== 'running') {
    return res.status(400).json({ error: 'Aucune campagne Telegram en cours à reprendre.' });
  }

  currentTelegramDmCampaign.userPaused = false;
  res.status(200).json({ status: 'resume_requested' });
});

app.post('/api/telegram/campaign/stop', requireAccess, requireModule('telegram'), (req, res) => {
  if (!currentTelegramDmCampaign || currentTelegramDmCampaign.status !== 'running') {
    return res.status(400).json({ error: 'Aucune campagne Telegram en cours à interrompre.' });
  }

  currentTelegramDmCampaign.stopRequested = true;
  currentTelegramDmCampaign.userPaused = false;
  res.status(200).json({ status: 'stop_requested' });
});

app.get('/api/telegram/campaign/status', requireAccess, requireModule('telegram'), (req, res) => {
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

// ---------- Programmation multi-canal (module Programmation / Planning) ----------
// Accessible sans requireModule() statique : le canal choisi n'est connu
// qu'au moment de la requête (corps du formulaire), donc la vérification se
// fait à la main ci-dessous, avec la même règle que requireModule('...') —
// 'facebook_page' toujours autorisé, 'telegram'/'whatsapp' soumis à
// allowedModules pour une clé de licence restreinte.
function channelAllowed(req, channel) {
  if (channel === 'facebook_page') return true;
  if (req.allowedModules === null || req.allowedModules === undefined) return true;
  return Array.isArray(req.allowedModules) && req.allowedModules.includes(channel);
}

app.get('/api/scheduled-messages', requireAccess, (req, res) => {
  const all = scheduledMessages.list();
  const visible = req.allowedModules === null || req.allowedModules === undefined
    ? all
    : all.filter((m) => channelAllowed(req, m.channel));
  res.status(200).json({ messages: visible });
});

function clampSeqDelaySeconds(value, fallback) {
  const n = parseFloat(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 30) : fallback;
}

app.post(
  '/api/scheduled-messages',
  requireAccess,
  whatsappMediaUpload.array('media', 10),
  async (req, res) => {
    const {
      channel, recipientType, message, mediaUrl, scheduledAt,
      sequenceDelayMin, sequenceDelayMax,
    } = req.body;
    let { recipients, sequence } = req.body;
    const files = req.files || [];

    if (typeof recipients === 'string') {
      try {
        recipients = JSON.parse(recipients);
      } catch (err) {
        recipients = recipients.split(/[,\n]/).map((r) => r.trim()).filter(Boolean);
      }
    }
    if (typeof sequence === 'string') {
      try {
        sequence = JSON.parse(sequence);
      } catch (err) {
        sequence = null;
      }
    }

    if (!['telegram', 'facebook_page', 'whatsapp'].includes(channel)) {
      return res.status(400).json({ error: 'Le champ "channel" doit valoir "telegram", "facebook_page" ou "whatsapp".' });
    }
    if (!channelAllowed(req, channel)) {
      return res.status(403).json({ error: `Votre clé de licence n'inclut pas le module "${channel}".` });
    }
    if (!scheduledAt || Number.isNaN(new Date(scheduledAt).getTime())) {
      return res.status(400).json({ error: 'Le champ "scheduledAt" (date/heure d\'envoi ISO) est requis et doit être une date valide.' });
    }
    if (channel !== 'facebook_page' && (!Array.isArray(recipients) || recipients.length === 0)) {
      return res.status(400).json({ error: 'Fournissez "recipients" (destinataires ou groupes ciblés) pour ce canal.' });
    }

    // Séquençage / Envoi Multi-Messages (voir queues/scheduled_messages.js) :
    // une suite ordonnée de textes/médias, réservée à WhatsApp — Telegram et
    // Facebook restent sur le modèle classique (un message + médias)
    // ci-dessous.
    const hasSequence = Array.isArray(sequence) && sequence.length > 0;
    if (hasSequence && channel !== 'whatsapp') {
      return res.status(400).json({
        error: 'La séquence multi-messages n\'est prise en charge que pour le canal WhatsApp.',
      });
    }

    let sequenceItems = null;
    let mediaItems = [];

    if (hasSequence) {
      sequenceItems = [];
      let fileIdx = 0;
      for (const step of sequence) {
        if (step && step.type === 'media') {
          const file = files[fileIdx];
          fileIdx += 1;
          if (!file) {
            return res.status(400).json({
              error: 'Le nombre de fichiers envoyés ne correspond pas au nombre d\'étapes média de la séquence.',
            });
          }
          // Canal garanti "whatsapp" ici (voir la garde hasSequence ci-dessus)
          // : compression vidéo automatique avant de persister sur disque.
          const built = await buildWhatsappMediaStep(file);
          const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${built.filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
          fs.writeFileSync(path.join(SCHEDULED_MEDIA_DIR, safeName), built.buffer);
          sequenceItems.push({
            type: 'media',
            mediaUrl: `local:${safeName}`,
            mediaMimetype: built.mimetype,
            mediaFilename: built.filename,
            forceDocument: built.forceDocument || false,
          });
        } else {
          sequenceItems.push({ type: 'text', text: String((step && step.text) || '') });
        }
      }
      if (fileIdx !== files.length) {
        return res.status(400).json({
          error: 'Le nombre de fichiers envoyés ne correspond pas au nombre d\'étapes média de la séquence.',
        });
      }
    } else {
      if (!message && files.length === 0 && !mediaUrl) {
        return res.status(400).json({ error: 'Fournissez un "message" et/ou un média (fichier(s) joint(s) ou "mediaUrl").' });
      }
      // Plusieurs pièces jointes combinées en un seul envoi (image + vidéo +
      // PDF...) : seul WhatsApp sait aujourd'hui les envoyer toutes (voir
      // dispatchScheduledWhatsapp) — Telegram/Facebook n'utiliseraient que la
      // première, ce qui surprendrait silencieusement l'utilisateur.
      if (files.length > 1 && channel !== 'whatsapp') {
        return res.status(400).json({
          error: 'Plusieurs pièces jointes en un seul envoi ne sont prises en charge que pour le canal WhatsApp.',
        });
      }
      if (files.some((f) => f.mimetype === 'application/pdf') && channel === 'facebook_page') {
        return res.status(400).json({
          error: 'L\'API Graph de Meta ne permet pas de joindre un PDF à une publication de Page ou de Groupe. '
            + 'Hébergez le PDF ailleurs et partagez son lien dans le message.',
        });
      }

      if (files.length > 0) {
        mediaItems = [];
        for (const file of files) {
          // Compression vidéo uniquement pour WhatsApp (voir
          // buildWhatsappMediaStep) : la limite de 15 Mo visée ne concerne
          // pas Telegram/Facebook, qui acceptent des fichiers plus lourds.
          const built = channel === 'whatsapp' ? await buildWhatsappMediaStep(file) : null;
          const buffer = built ? built.buffer : file.buffer;
          const mimetype = built ? built.mimetype : file.mimetype;
          const filename = built ? built.filename : file.originalname;
          const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
          fs.writeFileSync(path.join(SCHEDULED_MEDIA_DIR, safeName), buffer);
          mediaItems.push({
            mediaUrl: `local:${safeName}`,
            mediaMimetype: mimetype,
            mediaFilename: filename,
            forceDocument: built ? (built.forceDocument || false) : false,
          });
        }
      } else if (mediaUrl) {
        mediaItems = [{ mediaUrl, mediaMimetype: null, mediaFilename: null }];
      }
    }

    const entry = scheduledMessages.create({
      channel,
      recipientType: recipientType || null,
      recipients: Array.isArray(recipients) ? recipients : [],
      message,
      media: mediaItems,
      sequence: sequenceItems,
      sequenceDelayMinSeconds: hasSequence ? clampSeqDelaySeconds(sequenceDelayMin, 2) : undefined,
      sequenceDelayMaxSeconds: hasSequence ? clampSeqDelaySeconds(sequenceDelayMax, 5) : undefined,
      scheduledAt: new Date(scheduledAt).toISOString(),
    });

    res.status(201).json({ message: entry });
  },
);

app.delete('/api/scheduled-messages/:id', requireAccess, (req, res) => {
  const entry = scheduledMessages.get(req.params.id);
  if (!entry) {
    return res.status(404).json({ error: 'Programmation introuvable.' });
  }
  if (!channelAllowed(req, entry.channel)) {
    return res.status(403).json({ error: `Votre clé de licence n'inclut pas le module "${entry.channel}".` });
  }

  try {
    const cancelled = scheduledMessages.cancel(req.params.id);
    res.status(200).json({ message: cancelled });
  } catch (err) {
    if (err.message === 'ONLY_PENDING_CAN_BE_CANCELLED') {
      return res.status(409).json({ error: 'Seule une programmation "en attente" peut être annulée.' });
    }
    throw err;
  }
});

// ---------- Programmation de Contenu sur la Page Facebook ----------
// Sous-ensemble dédié de la Programmation multi-canal ci-dessus : mêmes
// modèle (queues/scheduled_messages.js) et cycle d'envoi toutes les 60s
// (runScheduledMessagesTick/dispatchScheduledFacebookPage) — un moteur
// séparé aurait dupliqué toute la logique de publication déjà en place
// (POST /{page-id}/feed|photos|videos) sans rien apporter de plus. Ces
// routes ne font qu'imposer channel="facebook_page" et n'exposer que ce
// sous-ensemble, avec l'étiquette "keyword" en plus.
//
// À noter pour choisir entre ce module et "Publication & Programmation sur
// la Page" (POST /api/facebook/publish, plus haut) : celui-ci utilise la
// programmation native de Meta (scheduled_publish_time), gérée par les
// serveurs de Facebook eux-mêmes — fiable même si ce serveur est hors ligne
// au moment prévu. Le module ci-dessous dépend au contraire de ce process
// Node (cycle toutes les 60s) : si le serveur est arrêté ou redémarre au
// mauvais moment, l'envoi est simplement retardé au prochain cycle après
// redémarrage, jamais perdu (statut "pending" persisté), mais moins
// immédiat que la programmation native. Son intérêt : un tableau
// récapitulatif unifié, l'étiquette mot-clé, et la diffusion combinée vers
// des Groupes au même moment que la Page.
app.get('/api/facebook/schedule-post', requireAccess, requireModule('facebook'), (req, res) => {
  res.status(200).json({ posts: scheduledMessages.list({ channel: 'facebook_page' }) });
});

app.post('/api/facebook/schedule-post', requireAccess, requireModule('facebook'), upload.single('media'), (req, res) => {
  const { message, mediaUrl, scheduledAt, keyword } = req.body;
  let { recipients } = req.body;

  if (typeof recipients === 'string') {
    try {
      recipients = JSON.parse(recipients);
    } catch (err) {
      recipients = recipients.split(/[,\n]/).map((r) => r.trim()).filter(Boolean);
    }
  }

  if (!scheduledAt || Number.isNaN(new Date(scheduledAt).getTime())) {
    return res.status(400).json({ error: 'Le champ "scheduledAt" (date/heure de diffusion ISO) est requis et doit être une date valide.' });
  }
  if (!message && !req.file && !mediaUrl) {
    return res.status(400).json({ error: 'Fournissez un "message" et/ou un média (fichier joint ou "mediaUrl").' });
  }
  if (req.file && req.file.mimetype === 'application/pdf') {
    return res.status(400).json({
      error: 'L\'API Graph de Meta ne permet pas de joindre un PDF à une publication de Page. '
        + 'Hébergez le PDF ailleurs et partagez son lien dans le message.',
    });
  }

  let storedMediaUrl = mediaUrl || null;
  let mediaMimetype = null;
  let mediaFilename = null;

  if (req.file) {
    const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
    fs.writeFileSync(path.join(SCHEDULED_MEDIA_DIR, safeName), req.file.buffer);
    storedMediaUrl = `local:${safeName}`;
    mediaMimetype = req.file.mimetype;
    mediaFilename = req.file.originalname;
  }

  const entry = scheduledMessages.create({
    channel: 'facebook_page',
    recipients: Array.isArray(recipients) ? recipients : [],
    message,
    mediaUrl: storedMediaUrl,
    mediaMimetype,
    mediaFilename,
    keyword,
    scheduledAt: new Date(scheduledAt).toISOString(),
  });

  res.status(201).json({ post: entry });
});

app.delete('/api/facebook/schedule-post/:id', requireAccess, requireModule('facebook'), (req, res) => {
  const entry = scheduledMessages.get(req.params.id);
  if (!entry || entry.channel !== 'facebook_page') {
    return res.status(404).json({ error: 'Publication programmée introuvable.' });
  }

  try {
    const cancelled = scheduledMessages.cancel(req.params.id);
    res.status(200).json({ post: cancelled });
  } catch (err) {
    if (err.message === 'ONLY_PENDING_CAN_BE_CANCELLED') {
      return res.status(409).json({ error: 'Seule une programmation "en attente" peut être annulée.' });
    }
    throw err;
  }
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

telegram
  .restoreSessionFromRemote()
  .catch((err) => {
    console.error('Erreur lors de la restauration de la session Telegram depuis GitHub :', err);
  })
  .finally(() => {
    telegram.init().catch((err) => {
      console.error('Erreur lors de l\'initialisation de l\'adaptateur Telegram:', err);
    });
  });

// Auto-ping interne : sur le plan gratuit Render, le service se met en
// veille après ~15 min sans requête entrante, ce qui coupe aussi les
// connexions WhatsApp/Telegram actives. Un ping périodique vers sa propre
// URL publique (donc une vraie requête HTTP entrante du point de vue de
// Render, pas un appel interne) maintient le service éveillé. Écrit pour ne
// jamais faire planter le process : erreur réseau ignorée, juste journalisée.
const PING_INTERVAL_MS = 10 * 60 * 1000;

function startKeepAliveHeartbeat() {
  const pingTimer = setInterval(() => {
    axios.get(`${PUBLIC_BASE_URL}/ping`, { timeout: 15000 }).catch((err) => {
      console.warn('Auto-ping keep-alive: échec (probablement sans conséquence) —', err.message);
    });
  }, PING_INTERVAL_MS);
  // Ne bloque jamais l'arrêt propre du process (redéploiement, etc.).
  if (pingTimer.unref) pingTimer.unref();
}

startKeepAliveHeartbeat();
