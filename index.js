// Charge .env dans process.env AVANT tout autre require (plusieurs modules,
// ex. lib/media/videoAiEngine.js, lisent des variables d'environnement dès
// leur chargement, au niveau racine du fichier) — sur Render, les variables
// sont injectées directement par la plateforme et .env n'existe pas
// (config() échoue silencieusement, sans erreur ni effet, voir la doc
// dotenv) ; en local, c'est le seul mécanisme qui rend le fichier .env
// réellement effectif (voir CLAUDE.md : "tous les identifiants sont lus
// depuis le fichier .env local" — jusqu'ici vrai seulement si l'on
// sourçait .env manuellement avant `node index.js`).
// quiet: true supprime les "tips" promotionnels que dotenv >= 17 affiche
// aléatoirement au chargement (fonctionnalité officielle du package, pas un
// souci de sécurité — juste du bruit dans les logs de production).
require('dotenv').config({ quiet: true });

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
const whatsappManager = require('./adapters/whatsappManager');
const FacebookMessengerAdapter = require('./adapters/facebook');
const telegramManager = require('./adapters/telegramManager');
const sessionRegulator = require('./adapters/sessionRegulator');
const MediaPublisherAdapter = require('./adapters/media_publisher');
const videoCompressor = require('./adapters/videoCompressor');
const licenses = require('./licenses');
const oauthConfig = require('./oauth_config');
const scheduledMessages = require('./queues/scheduled_messages');
const campaignEngineModule = require('./queues/campaignEngine');
const telegramCampaignEngineModule = require('./queues/telegramCampaignEngine');
const contactsStore = require('./models/contact');
const keywordRules = require('./models/keyword_rules');
const scrapedNumbers = require('./models/scrapedNumbers');
const groupScraper = require('./lib/groupScraper');
const { replaceVariables, normalizeJid, jidToE164 } = require('./lib/whatsappRecipients');
const aiStudioStore = require('./lib/aiStudioStore');
const copywriterEngine = require('./lib/ai/localCopywriterEngine');
const llmFallbackEngine = require('./lib/ai/llmFallbackEngine');
const imageLinkStore = require('./lib/media/imageLinkStore');
const videoAiEngine = require('./lib/media/videoAiEngine');
const imageAiEngine = require('./lib/media/imageAiEngine');
const posterTemplateEngine = require('./lib/media/posterTemplateEngine');
const storyboardEngine = require('./lib/media/storyboardEngine');
const videoMixerEngine = require('./lib/media/videoMixerEngine');
const messageHistory = require('./lib/messageHistory');
const { personalizeMessage, buildPersonalizationVars } = require('./lib/personalization');
const ebookGenerator = require('./lib/pdf/ebookGenerator');

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
// Obscurcissement Frontend : sert la version obscurcie (voir
// scripts/build-dashboard.js, "npm run build") quand elle a été générée,
// retombe sur la source lisible sinon (développement local sans build) —
// jamais l'inverse.
const DASHBOARD_BUILT_PATH = path.join(__dirname, 'public', 'dist', 'dashboard.html');
const DASHBOARD_SOURCE_PATH = path.join(__dirname, 'public', 'dashboard.html');
const DASHBOARD_PATH = fs.existsSync(DASHBOARD_BUILT_PATH) ? DASHBOARD_BUILT_PATH : DASHBOARD_SOURCE_PATH;
const ADMIN_PORTAL_PATH = path.join(__dirname, 'public', 'admin.html');
const PRIVACY_POLICY_PATH = path.join(__dirname, 'public', 'legal', 'privacy.html');
const TERMS_OF_SERVICE_PATH = path.join(__dirname, 'public', 'legal', 'terms.html');
const DATA_DELETION_PATH = path.join(__dirname, 'public', 'legal', 'data-deletion.html');
const facebook = new FacebookMessengerAdapter();
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
    '  ACCES ADMINISTRATEUR — CYRUS SUPER ASSISTANT',
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

// ---------- Verrouillage CORS (protection de l'API / de la propriété intellectuelle) ----------
// N'autorise que l'origine du Dashboard officiel à lire les réponses de
// cette API depuis un navigateur — une page web tierce qui tenterait
// d'appeler ces routes via fetch()/XHR depuis le navigateur d'un client (en
// s'appuyant sur une session déjà ouverte) reçoit un 403 avant d'atteindre
// la moindre route métier. DASHBOARD_ORIGIN permet d'ajouter d'autres
// origines de confiance (domaine personnalisé, environnement local) sous
// forme d'une liste séparée par des virgules ; à défaut, seule l'origine de
// déploiement (PUBLIC_BASE_URL) est autorisée. Sans en-tête Origin (appel
// serveur-à-serveur, webhook Meta, client non-navigateur authentifié par
// clé de licence) : CORS ne s'applique pas, la requête suit son cours
// normalement (l'authentification applicative reste gérée par requireAccess/
// requireAdmin plus loin, indépendamment de cette origine).
// BUG CORRIGÉ (constaté en production : le portail admin, servi depuis
// PUBLIC_BASE_URL, recevait "Origine non autorisée" dès que DASHBOARD_ORIGIN
// était configuré) : `DASHBOARD_ORIGIN || PUBLIC_BASE_URL` REMPLAÇAIT
// PUBLIC_BASE_URL au lieu de l'AJOUTER dès que DASHBOARD_ORIGIN était
// défini, malgré le commentaire ci-dessus qui documentait bien l'intention
// inverse ("permet d'AJOUTER d'autres origines"). Les deux sont désormais
// toujours combinées.
const ALLOWED_DASHBOARD_ORIGINS = [PUBLIC_BASE_URL, ...(process.env.DASHBOARD_ORIGIN || '').split(',')]
  .map((o) => o.trim().replace(/\/$/, ''))
  .filter(Boolean);

function lockCorsToOfficialDashboard(req, res, next) {
  const origin = req.get('origin');

  if (!origin) {
    return next();
  }

  if (!ALLOWED_DASHBOARD_ORIGINS.includes(origin.replace(/\/$/, ''))) {
    return res.status(403).json({ error: 'Origine non autorisée.' });
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-admin-password,x-license-key,x-device-id');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  return next();
}

app.use(lockCorsToOfficialDashboard);

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
    // "facebook" (YouTube/TikTok) reste hors du système de licences — accès
    // libre pour toute clé (voir licenses.js#ALL_MODULES). "studio_video" a
    // été réintégré (verrouillage du Studio IA) : les clés déjà émises AVANT
    // cette réintégration ont été migrées pour le conserver (voir
    // licenses.js#migrateStudioVideoModule) — seules les clés créées après
    // sans ce module sélectionné sont désormais réellement bloquées ci-dessous.
    if (moduleName === 'facebook') {
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

// getSessionForRequest() peut lever sessionRegulator.SessionLimitError si le
// plafond de sessions simultanées (voir adapters/sessionRegulator.js) est
// atteint et qu'aucune session (WhatsApp ou Telegram, tous tenants confondus)
// n'est éligible à l'éviction — répond alors 503 avec un message clair pour
// l'interface plutôt que de faire planter la requête ou le process.
function respondSessionLimitReached(res, err) {
  if (err instanceof sessionRegulator.SessionLimitError) {
    res.status(503).json({ error: err.message });
    return true;
  }
  return false;
}

// À utiliser après requireAccess (et requireModule('whatsapp')) sur toute
// route WhatsApp : attache l'instance isolée du tenant courant (admin ou clé
// de licence — voir adapters/whatsappManager.js) à req.whatsapp/req.campaign,
// pour qu'aucun handler ne puisse jamais toucher, même par erreur, au socket
// ou aux données d'un autre tenant.
function attachWhatsapp(req, res, next) {
  let entry;
  try {
    entry = whatsappManager.getSessionForRequest(req);
  } catch (err) {
    if (respondSessionLimitReached(res, err)) return;
    throw err;
  }
  req.whatsapp = entry.session;
  req.campaignEngine = entry.campaignEngine;
  next();
}

// Même principe qu'attachWhatsapp, pour Telegram (voir
// adapters/telegramManager.js) : isolation stricte par tenant, aucun état
// partagé entre deux clés de licence.
function attachTelegram(req, res, next) {
  let entry;
  try {
    entry = telegramManager.getSessionForRequest(req);
  } catch (err) {
    if (respondSessionLimitReached(res, err)) return;
    throw err;
  }
  req.telegram = entry.session;
  req.telegramCampaignEngine = entry.campaignEngine;
  next();
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

// replaceVariables/normalizeJid/jidToE164 : voir lib/whatsappRecipients.js
// (partagées avec queues/campaignEngine.js — normalizeRecipientEntry, qui y
// reste, n'est plus utilisée ici depuis que dispatchScheduledWhatsapp injecte
// directement ses destinataires bruts dans le Queue Engine principal).

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

// La campagne WhatsApp interactive (pause/stop/reprise, persistance,
// isolation par tenant) vit maintenant entièrement dans
// queues/campaignEngine.js (une instance par tenant, voir
// adapters/whatsappManager.js) — plus aucun état de campagne global ici.

// La campagne de messages directs Telegram (pause/stop/reprise, persistance,
// isolation par tenant) vit maintenant entièrement dans
// queues/telegramCampaignEngine.js (une instance par tenant, voir
// adapters/telegramManager.js) — plus aucun état de campagne global ici,
// sur le même principe que la campagne WhatsApp ci-dessus.

// ---------- Programmation multi-canal (module Programmation / Planning) ----------
// Contrairement aux campagnes interactives ci-dessus (un moteur par tenant
// pour WhatsApp comme pour Telegram — un seul créneau à la fois par tenant,
// partagé avec le dashboard), une programmation est indépendante : elle doit
// pouvoir
// s'exécuter sans écraser une campagne manuelle en cours, ni en être bloquée.
// Chaque canal a donc sa propre boucle d'envoi séquentielle ici plutôt que de
// réutiliser les créneaux interactifs existants. Note : cette programmation
// n'a pas de notion de tenant (voir dispatchScheduledWhatsapp) — hors du
// périmètre de l'isolation par clé mise en place pour les campagnes
// interactives.

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
// queues/campaignEngine.js pour l'équivalent côté envoi immédiat) : résout chaque
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

// La programmation multi-canal (voir queues/scheduled_messages.js) n'a
// aujourd'hui aucune notion de tenant/propriétaire (accessible via
// /api/scheduled-messages par n'importe quelle clé valide) : hors du
// périmètre de cette refonte (isolation de l'instance WhatsApp interactive,
// des campagnes et de contactNames). En attendant une éventuelle isolation
// complète de ce module, les envois programmés WhatsApp passent par
// l'instance du tenant admin plutôt que par une session partagée fantôme.
//
// L'envoi lui-même est désormais injecté directement dans le Queue Engine
// principal (queues/campaignEngine.js) plutôt que dans une boucle d'envoi
// dédiée : une programmation bénéficie ainsi exactement des mêmes
// protections qu'une campagne interactive (Spintax, séquencement
// Texte/Média, Circuit Breaker anti-surcharge et persistance sur disque
// résistante à un redéploiement Render), au prix d'un seul créneau d'envoi
// partagé entre campagnes interactives et programmations pour ce tenant (voir
// CampaignEngine#start, qui refuse un second lancement concurrent —
// remontée telle quelle par runScheduledMessagesTick, qui retentera cette
// programmation au cycle suivant).
async function dispatchScheduledWhatsapp(entry, mediaList) {
  const { session, campaignEngine } = whatsappManager.getOrCreate(whatsappManager.ADMIN_TENANT_ID);
  let recipients = entry.recipients;

  if (entry.recipientType === 'groups') {
    const merged = new Set();
    for (const groupId of entry.recipients) {
      const participants = await session.getGroupParticipants(groupId);
      (participants || []).forEach((p) => merged.add(p.id));
    }
    recipients = Array.from(merged);
  }

  // Séquence Texte/Média à injecter dans le moteur : celle déjà définie pour
  // cette programmation (Séquençage / Envoi Multi-Messages) si présente,
  // sinon une séquence dérivée du message/média classique — média(s) d'abord,
  // texte ensuite (le moteur envoie chaque étape séparément, sans légende
  // combinée, voir queues/campaignEngine.js#_run).
  let sequence = await resolveScheduledSequence(entry);
  if (!sequence) {
    sequence = [];
    if (Array.isArray(mediaList) && mediaList.length > 0) {
      mediaList.forEach((media) => sequence.push({ type: 'media', ...media }));
      if (entry.message) sequence.push({ type: 'text', text: entry.message });
    } else {
      sequence.push({ type: 'text', text: entry.message || '' });
    }
  }

  await campaignEngine.start(recipients, {
    sequence,
    sequenceDelayMinMs: Math.max(1, entry.sequenceDelayMinSeconds || 2) * 1000,
    sequenceDelayMaxMs: Math.max(1, entry.sequenceDelayMaxSeconds || 5) * 1000,
  });

  const finalStatus = await waitForCampaignCompletion(campaignEngine);
  return (finalStatus && finalStatus.results) || [];
}

// Comme dispatchScheduledWhatsapp ci-dessus : la programmation multi-canal
// n'a aujourd'hui aucune notion de tenant/propriétaire, donc les envois
// programmés Telegram passent par l'instance du tenant admin plutôt que par
// une session partagée fantôme — et sont désormais injectés dans le Queue
// Engine Telegram (queues/telegramCampaignEngine.js) pour les mêmes raisons
// que côté WhatsApp ci-dessus.
async function dispatchScheduledTelegram(entry, media) {
  const { campaignEngine } = telegramManager.getOrCreate(telegramManager.ADMIN_TENANT_ID);

  await campaignEngine.start(entry.recipients, entry.message, {
    media,
    // 'contacts' : identifiants importés (username/téléphone) à résoudre par
    // le moteur avant l'envoi. 'groups' : identifiants de groupes/canaux déjà
    // connus (getGroups()), utilisables directement.
    recipientType: entry.recipientType === 'groups' ? 'groups' : 'contacts',
  });

  const finalStatus = await waitForCampaignCompletion(campaignEngine);
  return (finalStatus && finalStatus.results) || [];
}

// Attend la fin (complétée ou interrompue) d'une campagne tout juste lancée
// sur l'un des deux moteurs de file d'attente (CampaignEngine ou
// TelegramCampaignEngine, tous deux exposant getStatus().status) — utilisé
// par la programmation multi-canal ci-dessus, qui doit rendre la main à
// runScheduledMessagesTick avec le résultat final plutôt qu'avec une
// campagne encore en cours.
function waitForCampaignCompletion(engine) {
  const POLL_INTERVAL_MS = 500;
  return new Promise((resolve) => {
    const check = () => {
      const status = engine.getStatus();
      if (!status || status.status !== 'running') {
        resolve(status);
        return;
      }
      setTimeout(check, POLL_INTERVAL_MS);
    };
    check();
  });
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

// Purge automatique des campagnes WhatsApp/Telegram abandonnées (voir
// queues/campaignEngine.js#purgeStaleCampaigns et son équivalent Telegram) :
// n'annule QUE les campagnes dont aucun process n'a donné signe de vie
// depuis plus de CAMPAIGN_STALE_HOURS (48h par défaut, configurable) —
// jamais une campagne activement suivie (en cours d'envoi, ou en pause
// manuelle/réseau/FLOOD_WAIT en cours de plusieurs heures à plusieurs jours,
// voir le "battement de cœur" des moteurs de campagne), conformément à la
// demande explicite de ne jamais annuler une campagne juste parce que du
// temps a passé. Un cycle par heure suffit largement pour un seuil mesuré en
// jours.
const CAMPAIGN_PURGE_TICK_MS = 60 * 60 * 1000;
const campaignPurgeInterval = setInterval(() => {
  try {
    campaignEngineModule.purgeStaleCampaigns();
  } catch (err) {
    console.error('Erreur pendant la purge des campagnes WhatsApp abandonnées:', err.message);
  }
  try {
    telegramCampaignEngineModule.purgeStaleCampaigns();
  } catch (err) {
    console.error('Erreur pendant la purge des campagnes Telegram abandonnées:', err.message);
  }
}, CAMPAIGN_PURGE_TICK_MS);
if (campaignPurgeInterval.unref) campaignPurgeInterval.unref();

async function findGroupByName(session, name) {
  const groups = await session.getGroups();
  const needle = name.trim().toLowerCase();
  return groups.find((g) => (g.subject || '').toLowerCase().includes(needle));
}

// session/campaignEngine : instance isolée du tenant qui a envoyé le message
// (voir attachWhatsapp) — jamais celles d'un autre tenant.
async function handleNaturalMessage(message, session, campaignEngine) {
  const text = message.trim();
  const lowered = text.toLowerCase();

  if (/liste\s+mes\s+groupes|affiche\s+(les\s+)?groupes|montre\s+(moi\s+)?(les\s+)?groupes|quels?\s+sont\s+mes\s+groupes/.test(lowered)) {
    const groups = await session.getGroups();
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
    const group = await findGroupByName(session, groupName);
    if (!group) {
      return `Aucun groupe correspondant à "${groupName}" n'a été trouvé.`;
    }
    const participants = await session.getGroupParticipants(group.id);
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
    const group = await findGroupByName(session, groupName);
    if (!group) {
      return `Aucun groupe correspondant à "${groupName}" n'a été trouvé.`;
    }
    const participants = await session.getGroupParticipants(group.id);
    if (!participants || participants.length === 0) {
      return `Le groupe "${group.subject}" ne contient aucun participant à contacter.`;
    }

    const recipients = participants.map((p) => p.id);
    const delaySeconds = delaySecondsRaw ? parseFloat(delaySecondsRaw) : undefined;

    try {
      await campaignEngine.start(recipients, { sequence: [{ type: 'text', text: campaignMessage.trim() }], delaySeconds });
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

async function runCampaign(session, contacts, minDelayMs, maxDelayMs) {
  for (let i = 0; i < contacts.length; i += 1) {
    const row = contacts[i];

    if (!row.telephone || !row.message) {
      console.warn(`Campagne: ligne ${i + 1} ignorée (champs "telephone" et "message" requis).`);
      continue;
    }

    const to = normalizeJid(row.telephone);
    const text = replaceVariables(row.message, row);

    try {
      await session.sendMessage(to, text);
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

// Manifest PWA + icône + service worker (voir public/manifest.json,
// public/icon.svg, public/sw.js) : aucune authentification, le navigateur
// doit pouvoir les récupérer librement pour proposer "Ajouter à l'écran
// d'accueil" sous le nom CYRUS SUPER ASSISTANT.
app.get('/manifest.json', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'manifest.json'));
});
app.get('/icon.svg', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'icon.svg'));
});
app.get('/sw.js', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
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
    whatsapp: whatsappManager.getStorageStatus(),
    telegram: telegramManager.getStorageStatus(),
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

app.get('/api/status', requireAccess, requireModule('whatsapp'), attachWhatsapp, async (req, res) => {
  const connected = req.whatsapp.isConnected();
  const response = { connected };

  if (!connected) {
    const qr = req.whatsapp.getQRCode();
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

app.post('/api/pairing-code', requireAccess, requireModule('whatsapp'), attachWhatsapp, async (req, res) => {
  const { phoneNumber } = req.body || {};

  if (!phoneNumber || !String(phoneNumber).replace(/\D/g, '')) {
    return res.status(400).json({ error: 'Le champ "phoneNumber" est requis (indicatif pays inclus, ex: 225xxxxxxxxx).' });
  }

  try {
    // requestPairingCode purge et relance une connexion fraîche en interne si
    // besoin (voir adapters/whatsapp.js) — une demande explicite de code ne
    // doit jamais rester bloquée par un état "déjà connecté".
    const code = await req.whatsapp.requestPairingCode(phoneNumber);
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
app.post('/api/whatsapp/logout', requireAccess, requireModule('whatsapp'), attachWhatsapp, async (req, res) => {
  try {
    await req.whatsapp.logout();
    res.status(200).json({ status: 'logged_out' });
  } catch (err) {
    console.error('Erreur lors de la déconnexion WhatsApp:', err);
    res.status(500).json({ error: 'Échec de la déconnexion WhatsApp.' });
  }
});

app.post('/api/messages', requireAccess, requireModule('whatsapp'), attachWhatsapp, async (req, res) => {
  const { to, message } = req.body;

  if (!to || !message) {
    return res.status(400).json({ error: 'Les champs "to" et "message" sont requis.' });
  }

  try {
    await req.whatsapp.sendMessage(to, message);
    res.status(200).json({ status: 'sent' });
  } catch (err) {
    console.error('Erreur lors de l\'envoi du message:', err);
    res.status(500).json({ error: 'Échec de l\'envoi du message.' });
  }
});

// "rate-overlimit" : WhatsApp applique une limite temporaire sur les
// requêtes de métadonnées de groupe (groupMetadata, utilisée par
// getGroupParticipants) — observé en particulier sur un appareil qui vient
// tout juste d'être lié (période de "mise en confiance" côté WhatsApp, de
// quelques minutes à quelques heures). Ce n'est ni un bug ni une action
// bloquée définitivement : WhatsApp répond juste "réessayez plus tard" à ce
// type d'appel précis (l'envoi de messages directs n'est pas concerné, lui
// n'appelle jamais groupMetadata). Le message d'erreur reflète ça plutôt
// qu'un échec générique, pour éviter de faire chercher un bug qui n'existe
// pas côté serveur.
function describeGroupQueryError(err) {
  if (err && err.message === 'rate-overlimit') {
    return 'WhatsApp limite temporairement les requêtes sur les groupes pour ce compte (fréquent juste après une nouvelle liaison d\'appareil). Réessayez dans quelques minutes à quelques heures — l\'envoi de messages directs n\'est pas affecté par cette limite.';
  }
  return null;
}

app.get('/api/groups', requireAccess, requireModule('whatsapp'), attachWhatsapp, async (req, res) => {
  try {
    const groups = await req.whatsapp.getGroups();
    res.status(200).json(groups);
  } catch (err) {
    console.error('Erreur lors de la récupération des groupes:', err);
    res.status(500).json({ error: describeGroupQueryError(err) || 'Échec de la récupération des groupes.' });
  }
});

app.get('/api/groups/:id/participants', requireAccess, requireModule('whatsapp'), attachWhatsapp, async (req, res) => {
  try {
    const participants = await req.whatsapp.getGroupParticipants(req.params.id);
    res.status(200).json(participants);
  } catch (err) {
    console.error('Erreur lors de la récupération des participants:', err);
    res.status(500).json({ error: describeGroupQueryError(err) || 'Échec de la récupération des participants.' });
  }
});

// Extraction consolidée des membres d'un ou plusieurs groupes sélectionnés
// vers un unique fichier Excel téléchargeable (module de gestion des
// contacts) : un même membre présent dans plusieurs groupes cochés n'apparaît
// qu'une fois, avec la liste de ces groupes en colonne "groupes".
app.post('/api/groups/export-members', requireAccess, requireModule('whatsapp'), attachWhatsapp, async (req, res) => {
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

  // Group Scraper (voir lib/groupScraper.js) : sur une grosse sélection de
  // groupes, traite par tranches de 20, avec une pause de 3s (non bloquante)
  // entre la lecture de chaque groupe, et écrit les numéros extraits sur
  // disque groupe par groupe plutôt que de tout garder en mémoire vive le
  // temps de toute l'extraction — évite la saturation RAM et les timeouts
  // réseau sur une instance Render à faible mémoire. Un groupe en échec (ex:
  // rate-overlimit WhatsApp) est consigné puis on passe au suivant, sans
  // jamais interrompre le reste de l'extraction.
  let runId;
  try {
    // extractRows() : "telephone" est extrait de participant.jid, PAS
    // participant.id : pour un participant ayant activé la confidentialité
    // WhatsApp "masquer mon numéro", .id porte un identifiant anonyme (@lid)
    // sans rapport avec son numéro réel — voir extractGroupMetadata() dans
    // Baileys (lib/Socket/groups.js), qui distingue explicitement .id
    // (adressage, peut être un @lid) de .jid (le vrai numéro, dérivé de
    // l'attribut phone_number quand .id est un @lid). Un participant dont le
    // numéro réel reste indérivable (confidentialité + jamais "rencontré" par
    // ce compte) est omis du fichier plutôt que d'y laisser une ligne avec un
    // téléphone vide ou erroné.
    //
    // "nom" vient du cache opportuniste de noms publics (pushName/notify)
    // constitué par l'adaptateur au fil des messages/contacts déjà vus par ce
    // compte (voir adapters/whatsapp.js#getContactName), cherché sous le JID
    // téléphone puis, à défaut, sous le @lid observé pour ce même
    // participant — WhatsApp n'expose aucune API pour récupérer le nom
    // public d'un numéro qu'on n'a jamais "rencontré", donc ce champ peut
    // rester vide. Un même membre présent dans plusieurs groupes cochés
    // n'apparaît qu'une fois (dédoublonné par phoneJid dans le run persisté,
    // voir models/scrapedNumbers.js#appendRows).
    function extractRows(groupId, participants) {
      const rows = {};
      participants.forEach((p) => {
        const phoneJid = p.jid && !p.jid.endsWith('@lid')
          ? p.jid
          : (p.id && !p.id.endsWith('@lid') ? p.id : null);
        if (!phoneJid) return;
        const lidJid = p.lid || (p.id !== phoneJid ? p.id : null);
        rows[phoneJid] = {
          telephone: jidToE164(phoneJid),
          nom: req.whatsapp.getContactName(phoneJid) || (lidJid ? req.whatsapp.getContactName(lidJid) : '') || '',
        };
      });
      return rows;
    }

    const { runId: scrapeRunId, errors } = await groupScraper.scrapeGroupsToStore(
      groupIds,
      (groupId) => req.whatsapp.getGroupParticipants(groupId),
      extractRows,
    );
    runId = scrapeRunId;

    if (errors.length > 0) {
      res.setHeader('X-Group-Scraper-Errors', String(errors.length));
    }

    const rows = scrapedNumbers.listRun(runId);
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
    res.status(500).json({ error: describeGroupQueryError(err) || 'Échec de l\'extraction des membres des groupes sélectionnés.' });
  } finally {
    // Le run persisté (voir models/scrapedNumbers.js) n'est qu'un tampon de
    // travail pour cette requête : jamais conservé au-delà, qu'elle réussisse
    // ou échoue.
    if (runId) {
      scrapedNumbers.clearRun(runId);
    }
  }
});

app.post('/api/messages/queue', requireAccess, requireModule('whatsapp'), attachWhatsapp, whatsappMediaUpload.array('media', 10), async (req, res) => {
  const { message, groupId, delaySeconds, batchSize, batchPauseSeconds, sequenceDelayMin, sequenceDelayMax, duplicateWindowHours } = req.body;
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
        const participants = await req.whatsapp.getGroupParticipants(gId);
        (participants || []).forEach((p) => merged.add(p.id));
      }
      recipients = Array.from(merged);
    } catch (err) {
      console.error('Erreur lors de la récupération des participants des groupes cibles:', err);
      return res.status(400).json({ error: describeGroupQueryError(err) || 'Impossible de récupérer les participants des groupes cibles.' });
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
  const parsedBatchPauseSeconds = batchPauseSeconds !== undefined && batchPauseSeconds !== '' ? parseFloat(batchPauseSeconds) : undefined;
  // Délai court entre les messages d'une même séquence (média puis texte,
  // 2-5s par défaut) — distinct du délai fixe (delaySeconds, 15s par défaut)
  // appliqué entre deux destinataires différents.
  const seqDelayMinMs = Math.max(1, parseFloat(sequenceDelayMin) || 2) * 1000;
  const seqDelayMaxMs = Math.max(seqDelayMinMs, (parseFloat(sequenceDelayMax) || 5) * 1000);

  // enqueueIfBusy: true — Gestionnaire Multi-Campagnes : si une autre
  // campagne est déjà active sur cette session, celle-ci est stockée
  // "EN ATTENTE" (voir CampaignEngine#start) plutôt que de faire échouer la
  // requête ; l'utilisateur la démarre plus tard depuis la liste des
  // campagnes (bascule instantanée via /api/messages/campaigns/:id/play).
  const campaign = await req.campaignEngine.start(recipients, {
    name: req.body.name,
    delaySeconds: fixedDelaySeconds,
    batchSize: parsedBatchSize,
    batchPauseSeconds: parsedBatchPauseSeconds,
    sequence: resolvedSequence,
    sequenceDelayMinMs: seqDelayMinMs,
    sequenceDelayMaxMs: seqDelayMaxMs,
    duplicateWindowHours: duplicateWindowHours !== undefined && duplicateWindowHours !== '' ? parseFloat(duplicateWindowHours) : undefined,
    enqueueIfBusy: true,
  });

  res.status(202).json({
    status: campaign.status === 'queued' ? 'campaign_queued' : 'campaign_started',
    id: campaign.id,
    name: campaign.name,
    total: campaign.total,
    delaySeconds: fixedDelaySeconds || 15,
    batchSize: parsedBatchSize || recipients.length,
    batchPauseSeconds: parsedBatchPauseSeconds || (fixedDelaySeconds || 15) * 3,
    steps: resolvedSequence.length,
    duplicateWindowHours: campaign.duplicateWindowHours,
    skippedDuplicates: campaign.skippedDuplicates,
  });
});

// Pause manuelle (bouton "Mettre en Pause") : ne finalise rien, la
// progression et la liste des destinataires restants sont conservées pour
// une reprise via /api/messages/resume — voir CampaignEngine#pause.
// campaignId (body ou query, optionnel) : cible une campagne précise du
// Gestionnaire Multi-Campagnes — omis, agit sur la campagne "par défaut"
// (compat avec l'ancien dashboard mono-campagne).
app.post('/api/messages/pause', requireAccess, requireModule('whatsapp'), attachWhatsapp, (req, res) => {
  try {
    req.campaignEngine.pause(req.body.campaignId || req.query.campaignId);
    res.status(200).json({ status: 'pause_requested' });
  } catch (err) {
    if (err.message === 'NO_CAMPAIGN_RUNNING') {
      return res.status(400).json({ error: 'Aucune campagne en cours à mettre en pause.' });
    }
    throw err;
  }
});

// Reprend/lance une campagne (voir CampaignEngine#resume) — async car une
// bascule depuis une AUTRE campagne actuellement active attend que sa boucle
// d'envoi ait réellement quitté avant de démarrer celle-ci.
app.post('/api/messages/resume', requireAccess, requireModule('whatsapp'), attachWhatsapp, async (req, res) => {
  try {
    const campaign = await req.campaignEngine.resume(req.body.campaignId || req.query.campaignId);
    res.status(200).json({ status: 'resume_requested', campaign });
  } catch (err) {
    if (err.message === 'NO_CAMPAIGN_RUNNING') {
      return res.status(400).json({ error: 'Aucune campagne en cours à reprendre.' });
    }
    throw err;
  }
});

// Arrêt DÉFINITIF (bouton "Stopper définitivement") : voir
// CampaignEngine#stop, qui finalise la campagne de façon SYNCHRONE — le
// verrou est donc déjà libéré au moment où cette réponse part, permettant de
// lancer une nouvelle campagne sans attendre.
app.post('/api/messages/stop', requireAccess, requireModule('whatsapp'), attachWhatsapp, (req, res) => {
  try {
    req.campaignEngine.stop(req.body.campaignId || req.query.campaignId);
    res.status(200).json({ status: 'stop_requested' });
  } catch (err) {
    if (err.message === 'NO_CAMPAIGN_RUNNING') {
      return res.status(400).json({ error: 'Aucune campagne en cours à interrompre.' });
    }
    throw err;
  }
});

app.get('/api/messages/status', requireAccess, requireModule('whatsapp'), attachWhatsapp, (req, res) => {
  const status = req.campaignEngine.getStatus(req.query.campaignId);
  if (!status) {
    return res.status(200).json({ exists: false });
  }

  res.status(200).json({ exists: true, ...status });
});

// Gestionnaire Multi-Campagnes (dashboard) : liste TOUTES les campagnes du
// tenant (🔴 EN COURS / 🟡 EN PAUSE / 🟢 TERMINÉE / ⚪ EN ATTENTE), les plus
// récentes d'abord — voir CampaignEngine#listCampaigns.
app.get('/api/messages/campaigns', requireAccess, requireModule('whatsapp'), attachWhatsapp, (req, res) => {
  res.status(200).json({ campaigns: req.campaignEngine.listCampaigns() });
});

// Bascule instantanée : lance/reprend la campagne :id, mettant d'abord en
// pause celle actuellement active si elle est différente — voir
// CampaignEngine#resume.
app.post('/api/messages/campaigns/:id/play', requireAccess, requireModule('whatsapp'), attachWhatsapp, async (req, res) => {
  try {
    const campaign = await req.campaignEngine.resume(req.params.id);
    res.status(200).json({ status: 'resume_requested', campaign });
  } catch (err) {
    if (err.message === 'NO_CAMPAIGN_RUNNING') {
      return res.status(404).json({ error: 'Campagne introuvable ou déjà terminée.' });
    }
    throw err;
  }
});

app.post('/api/messages/campaigns/:id/pause', requireAccess, requireModule('whatsapp'), attachWhatsapp, (req, res) => {
  try {
    req.campaignEngine.pause(req.params.id);
    res.status(200).json({ status: 'pause_requested' });
  } catch (err) {
    if (err.message === 'NO_CAMPAIGN_RUNNING') {
      return res.status(400).json({ error: 'Cette campagne n\'est pas en cours d\'envoi.' });
    }
    throw err;
  }
});

app.post('/api/messages/campaigns/:id/stop', requireAccess, requireModule('whatsapp'), attachWhatsapp, (req, res) => {
  try {
    req.campaignEngine.stop(req.params.id);
    res.status(200).json({ status: 'stop_requested' });
  } catch (err) {
    if (err.message === 'NO_CAMPAIGN_RUNNING') {
      return res.status(404).json({ error: 'Campagne introuvable ou déjà arrêtée.' });
    }
    throw err;
  }
});

// Onglet dashboard "Relance Manuelle Express" (WhatsApp) : file d'attente
// des contacts encore 'pending'/'failed' de la campagne visée (campaignId en
// query, sinon la campagne "par défaut"), avec le message personnalisé prêt
// pour un deep link wa.me — voir CampaignEngine#getManualRelaunchQueue.
app.get('/api/messages/manual-queue', requireAccess, requireModule('whatsapp'), attachWhatsapp, (req, res) => {
  res.status(200).json({ items: req.campaignEngine.getManualRelaunchQueue(req.query.campaignId) });
});

// Trace l'ouverture manuelle d'un deep link WhatsApp pour un contact donné
// (statut 'sent_manual') — voir CampaignEngine#markManualSent.
app.post('/api/messages/manual-queue/:index/sent', requireAccess, requireModule('whatsapp'), attachWhatsapp, (req, res) => {
  const index = parseInt(req.params.index, 10);
  const result = req.campaignEngine.markManualSent(index, req.body.campaignId || req.query.campaignId);
  if (!result) {
    return res.status(404).json({ error: 'Contact introuvable dans la campagne en cours.' });
  }
  res.status(200).json({ status: 'sent_manual', result });
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

// ---------- Import direct d'un fichier Excel/CSV dans la Relance Manuelle Express ----------
// À la différence de /api/contacts/import (qui alimente une CAMPAGNE), ce
// point d'entrée sert directement la file d'attente de relance manuelle
// (public/dashboard.html#relanceLoadQueue) sans jamais créer ni démarrer de
// campagne (aucun risque d'envoi automatique) — mais applique EXACTEMENT le
// même Smart Screening anti-doublons que CampaignEngine#_buildInitialResults
// (même module lib/messageHistory.js, même fenêtre 48h par défaut) : un
// contact déjà destinataire de ce même modèle de message dans la fenêtre est
// marqué 'skipped_duplicate' au lieu de 'pending'.
app.post('/api/messages/manual-import', requireAccess, requireModule('whatsapp'), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier fourni (champ "file").' });
  }
  const template = String((req.body || {}).message || '').trim();

  let rows;
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet);
  } catch (err) {
    return res.status(400).json({ error: 'Fichier invalide. Utilisez un fichier .xlsx ou .csv avec une colonne "telephone".' });
  }

  const contacts = rows
    .map((row) => {
      const prenom = String(row.prenom || row.Prenom || row.name || row.Name || '').trim();
      return {
        telephone: String(row.telephone || row.Telephone || row.phone || row.Phone || row.numero || row.Numero || '').trim(),
        nom: String(row.nom || row.Nom || prenom || '').trim(),
      };
    })
    .filter((c) => c.telephone);

  const tenantId = resolveTenantId(req);
  const messageHash = messageHistory.hashTemplate([template]);
  const duplicateWindowHours = messageHistory.clampWindowHours((req.body || {}).duplicateWindowHours);
  const windowMs = duplicateWindowHours * 3_600_000;
  const historyEntries = await messageHistory.loadHistory('whatsapp', tenantId);

  const now = Date.now();
  const historySeen = new Set();
  historyEntries.forEach((entry) => {
    if (!entry || entry.messageHash !== messageHash) return;
    if (now - new Date(entry.sentAt).getTime() < windowMs) historySeen.add(entry.contactKey);
  });

  // Même comportement que CampaignEngine#getManualRelaunchQueue : un
  // doublon détecté n'apparaît PAS du tout dans la file (pas seulement
  // marqué) — jamais présenté comme un contact à traiter manuellement.
  const seenInThisImport = new Set();
  let skippedDuplicates = 0;
  const items = [];
  contacts.forEach((contact) => {
    const key = messageHistory.normalizeContactKey(contact.telephone);
    const isDuplicate = Boolean(key) && (historySeen.has(key) || seenInThisImport.has(key));
    if (key) seenInThisImport.add(key);
    if (isDuplicate) { skippedDuplicates += 1; return; }
    const vars = buildPersonalizationVars(contact.nom, contact.telephone);
    items.push({
      index: items.length,
      to: contact.telephone,
      phone: contact.telephone,
      name: contact.nom,
      message: personalizeMessage(template, vars),
      status: 'pending',
    });
  });

  res.status(200).json({ items, messageHash, total: items.length, skippedDuplicates });
});

// Trace un envoi effectué depuis la file importée ci-dessus dans le MÊME
// historique anti-doublons que les campagnes automatiques (voir
// CampaignEngine#_recordHistorySent) — sans ça, une relance manuelle
// n'ayant jamais transité par une vraie campagne resterait invisible du
// Smart Screening et pourrait se faire recontacter sans le savoir.
app.post('/api/messages/manual-import/sent', requireAccess, requireModule('whatsapp'), async (req, res) => {
  const to = String((req.body || {}).to || '').trim();
  const messageHash = String((req.body || {}).messageHash || '').trim();
  const contactKey = messageHistory.normalizeContactKey(to);
  if (!contactKey || !messageHash) {
    return res.status(400).json({ error: 'Paramètres "to" et "messageHash" requis.' });
  }

  const tenantId = resolveTenantId(req);
  const historyEntries = await messageHistory.loadHistory('whatsapp', tenantId);
  historyEntries.push({ contactKey, messageHash, sentAt: new Date().toISOString() });
  messageHistory.saveHistory('whatsapp', tenantId, historyEntries);

  res.status(200).json({ status: 'recorded' });
});

app.post('/api/chat-natural', requireAccess, requireModule('whatsapp'), attachWhatsapp, async (req, res) => {
  const { message } = req.body || {};

  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'Le champ "message" (texte) est requis.' });
  }

  try {
    const reply = await handleNaturalMessage(message, req.whatsapp, req.campaignEngine);
    res.status(200).json({ reply });
  } catch (err) {
    console.error('Erreur lors du traitement du message en langage naturel:', err);
    res.status(500).json({ reply: 'Une erreur est survenue lors du traitement de votre demande.' });
  }
});

app.post('/api/campaign/excel', requireAccess, requireModule('whatsapp'), attachWhatsapp, upload.single('file'), async (req, res) => {
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

  runCampaign(req.whatsapp, contacts, minDelaySeconds * 1000, maxDelaySeconds * 1000).catch((err) => {
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

app.get('/api/telegram/status', requireAccess, requireModule('telegram'), attachTelegram, (req, res) => {
  res.status(200).json({
    configured: req.telegram.isConfigured(),
    connected: req.telegram.isConnected(),
  });
});

// Déconnexion dédiée à Telegram (bouton "Se déconnecter de Telegram" du
// dashboard) — indépendante des autres canaux et des autres tenants : n'agit
// que sur l'instance isolée du tenant courant (voir attachTelegram).
app.post('/api/telegram/logout', requireAccess, requireModule('telegram'), attachTelegram, async (req, res) => {
  try {
    await req.telegram.logout();
    res.status(200).json({ status: 'logged_out' });
  } catch (err) {
    console.error('Erreur lors de la déconnexion Telegram:', err);
    res.status(500).json({ error: 'Échec de la déconnexion Telegram.' });
  }
});

app.post('/api/telegram/login/start', requireAccess, requireModule('telegram'), attachTelegram, async (req, res) => {
  const { phoneNumber } = req.body || {};

  if (!phoneNumber || !String(phoneNumber).replace(/\D/g, '')) {
    return res.status(400).json({ error: 'Le champ "phoneNumber" est requis (indicatif pays inclus).' });
  }

  if (!req.telegram.isConfigured()) {
    return res.status(503).json({
      error: 'Intégration Telegram non configurée (variables TELEGRAM_API_ID / TELEGRAM_API_HASH manquantes).',
    });
  }

  try {
    const step = await req.telegram.startLogin(phoneNumber);
    res.status(200).json({ step, error: step === 'error' ? req.telegram.getLoginError() : null });
  } catch (err) {
    console.error('Erreur lors du démarrage de la connexion Telegram:', err);
    res.status(500).json({ error: 'Échec du démarrage de la connexion Telegram.' });
  }
});

app.post('/api/telegram/login/code', requireAccess, requireModule('telegram'), attachTelegram, async (req, res) => {
  const { code } = req.body || {};

  if (!code) {
    return res.status(400).json({ error: 'Le champ "code" est requis.' });
  }

  try {
    const step = await req.telegram.submitCode(code);
    res.status(200).json({ step, error: step === 'error' ? req.telegram.getLoginError() : null });
  } catch (err) {
    if (err.message === 'NO_PENDING_CODE_REQUEST') {
      return res.status(409).json({ error: 'Aucune demande de code en attente. Relancez /api/telegram/login/start.' });
    }
    console.error('Erreur lors de la validation du code Telegram:', err);
    res.status(500).json({ error: 'Échec de la validation du code.' });
  }
});

app.post('/api/telegram/login/password', requireAccess, requireModule('telegram'), attachTelegram, async (req, res) => {
  const { password } = req.body || {};

  if (!password) {
    return res.status(400).json({ error: 'Le champ "password" est requis.' });
  }

  try {
    const step = await req.telegram.submitPassword(password);
    res.status(200).json({ step, error: step === 'error' ? req.telegram.getLoginError() : null });
  } catch (err) {
    if (err.message === 'NO_PENDING_PASSWORD_REQUEST') {
      return res.status(409).json({ error: 'Aucune demande de mot de passe 2FA en attente.' });
    }
    console.error('Erreur lors de la validation du mot de passe Telegram:', err);
    res.status(500).json({ error: 'Échec de la validation du mot de passe.' });
  }
});

app.get('/api/telegram/groups', requireAccess, requireModule('telegram'), attachTelegram, async (req, res) => {
  if (!req.telegram.isConnected()) {
    return res.status(409).json({ error: 'Telegram non connecté. Connectez-vous via l\'onglet Telegram avant de lister les groupes.' });
  }

  try {
    const groups = await req.telegram.getGroups();
    res.status(200).json(groups);
  } catch (err) {
    console.error('Erreur lors de la récupération des groupes Telegram:', err);
    res.status(500).json({ error: 'Échec de la récupération des groupes Telegram.' });
  }
});

// Diffusion vers des groupes/canaux Telegram sélectionnés — passe désormais
// par TelegramCampaignEngine (recipientType: 'groups', déjà supporté par le
// moteur : voir queues/telegramCampaignEngine.js#_runLoop, qui utilise
// l'identifiant de groupe/canal directement, sans resolveRecipient) au lieu
// de l'ancien envoi "fire-and-forget" (adapters/telegram.js#sendBulk,
// supprimé) : bénéficie ainsi de la même Pause/Reprendre/Stop, du même
// suivi live, du même coupe-circuit et de la même détection anti-doublons
// que les messages directs vers des contacts — un seul moteur, un seul
// verrou de campagne par tenant, quel que soit le type de destinataire.
app.post('/api/telegram/queue', requireAccess, requireModule('telegram'), attachTelegram, upload.single('media'), async (req, res) => {
  if (!req.telegram.isConnected()) {
    return res.status(409).json({ error: 'Telegram non connecté. Connectez-vous via l\'onglet Telegram avant d\'envoyer.' });
  }

  const { message, delaySeconds, batchSize, batchPauseSeconds, duplicateWindowHours } = req.body;
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
  const parsedBatchPauseSeconds = batchPauseSeconds !== undefined && batchPauseSeconds !== '' ? parseFloat(batchPauseSeconds) : undefined;
  const media = req.file
    ? { buffer: req.file.buffer, mimetype: req.file.mimetype, filename: req.file.originalname }
    : null;

  // enqueueIfBusy: true — Gestionnaire Multi-Campagnes : voir
  // /api/messages/queue (équivalent WhatsApp) pour la même logique.
  const campaign = await req.telegramCampaignEngine.start(recipients, message, {
    name: req.body.name,
    recipientType: 'groups',
    delaySeconds: fixedDelaySeconds,
    batchSize: parsedBatchSize,
    batchPauseSeconds: parsedBatchPauseSeconds,
    duplicateWindowHours: duplicateWindowHours !== undefined && duplicateWindowHours !== '' ? parseFloat(duplicateWindowHours) : undefined,
    media,
    enqueueIfBusy: true,
  });

  res.status(202).json({
    status: campaign.status === 'queued' ? 'campaign_queued' : 'tg_queue_started',
    id: campaign.id,
    name: campaign.name,
    total: campaign.total,
    delaySeconds: fixedDelaySeconds || 12,
    batchSize: parsedBatchSize || recipients.length,
    batchPauseSeconds: parsedBatchPauseSeconds || (fixedDelaySeconds || 12) * 3,
    media: media ? media.filename : null,
    duplicateWindowHours: campaign.duplicateWindowHours,
    skippedDuplicates: campaign.skippedDuplicates,
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

// Voir /api/messages/manual-import (même principe côté WhatsApp) : sert
// directement la Relance Manuelle Express Telegram sans jamais créer ni
// démarrer de campagne, avec le même Smart Screening anti-doublons 48h.
app.post('/api/telegram/campaign/manual-import', requireAccess, requireModule('telegram'), upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'Aucun fichier fourni (champ "file").' });
  }
  const template = String((req.body || {}).message || '').trim();

  let rows;
  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(sheet);
  } catch (err) {
    return res.status(400).json({ error: 'Fichier invalide. Utilisez un fichier .xlsx ou .csv avec une colonne "identifiant"/"username"/"telephone".' });
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

  const tenantId = resolveTenantId(req);
  const messageHash = messageHistory.hashTemplate([template]);
  const duplicateWindowHours = messageHistory.clampWindowHours((req.body || {}).duplicateWindowHours);
  const windowMs = duplicateWindowHours * 3_600_000;
  const historyEntries = await messageHistory.loadHistory('telegram', tenantId);

  const now = Date.now();
  const historySeen = new Set();
  historyEntries.forEach((entry) => {
    if (!entry || entry.messageHash !== messageHash) return;
    if (now - new Date(entry.sentAt).getTime() < windowMs) historySeen.add(entry.contactKey);
  });

  // Même comportement que TelegramCampaignEngine#getManualRelaunchQueue :
  // un doublon détecté n'apparaît pas du tout dans la file.
  const seenInThisImport = new Set();
  let skippedDuplicates = 0;
  const items = [];
  contacts.forEach((contact) => {
    const key = messageHistory.normalizeContactKey(contact.identifier);
    const isDuplicate = Boolean(key) && (historySeen.has(key) || seenInThisImport.has(key));
    if (key) seenInThisImport.add(key);
    if (isDuplicate) { skippedDuplicates += 1; return; }
    const isPhone = /^\+?\d[\d\s-]{5,}$/.test(contact.identifier);
    const vars = buildPersonalizationVars(contact.name, contact.identifier);
    items.push({
      index: items.length,
      to: contact.identifier,
      isPhone,
      phone: isPhone ? contact.identifier.replace(/[^\d]/g, '') : '',
      username: !isPhone ? contact.identifier.replace(/^@/, '') : '',
      name: contact.name,
      message: personalizeMessage(template, vars),
      status: 'pending',
    });
  });

  res.status(200).json({ items, messageHash, total: items.length, skippedDuplicates });
});

app.post('/api/telegram/campaign/manual-import/sent', requireAccess, requireModule('telegram'), async (req, res) => {
  const to = String((req.body || {}).to || '').trim();
  const messageHash = String((req.body || {}).messageHash || '').trim();
  const contactKey = messageHistory.normalizeContactKey(to);
  if (!contactKey || !messageHash) {
    return res.status(400).json({ error: 'Paramètres "to" et "messageHash" requis.' });
  }

  const tenantId = resolveTenantId(req);
  const historyEntries = await messageHistory.loadHistory('telegram', tenantId);
  historyEntries.push({ contactKey, messageHash, sentAt: new Date().toISOString() });
  messageHistory.saveHistory('telegram', tenantId, historyEntries);

  res.status(200).json({ status: 'recorded' });
});

app.post('/api/telegram/campaign/send', requireAccess, requireModule('telegram'), attachTelegram, upload.single('media'), async (req, res) => {
  if (!req.telegram.isConnected()) {
    return res.status(409).json({ error: 'Telegram non connecté. Connectez-vous via l\'onglet Telegram avant d\'envoyer.' });
  }

  const { message, delaySeconds, minDelaySeconds, maxDelaySeconds, batchSize, batchPauseSeconds, duplicateWindowHours } = req.body;
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

  // enqueueIfBusy: true — Gestionnaire Multi-Campagnes : voir
  // /api/messages/queue (équivalent WhatsApp) pour la même logique.
  const campaign = await req.telegramCampaignEngine.start(recipients, message, {
    name: req.body.name,
    // Délai fixe configurable, prioritaire sur la fenêtre min/max
    // (voir queues/telegramCampaignEngine.js) : standard demandé, sans
    // randomisation quand une valeur précise est fournie.
    delaySeconds: delaySeconds !== undefined && delaySeconds !== '' ? parseFloat(delaySeconds) : undefined,
    minDelayMs: minDelaySeconds !== undefined && minDelaySeconds !== '' ? parseFloat(minDelaySeconds) * 1000 : undefined,
    maxDelayMs: maxDelaySeconds !== undefined && maxDelaySeconds !== '' ? parseFloat(maxDelaySeconds) * 1000 : undefined,
    batchSize: batchSize !== undefined && batchSize !== '' ? parseInt(batchSize, 10) : undefined,
    batchPauseSeconds: batchPauseSeconds !== undefined && batchPauseSeconds !== '' ? parseFloat(batchPauseSeconds) : undefined,
    duplicateWindowHours: duplicateWindowHours !== undefined && duplicateWindowHours !== '' ? parseFloat(duplicateWindowHours) : undefined,
    media,
    enqueueIfBusy: true,
  });

  res.status(202).json({
    status: campaign.status === 'queued' ? 'campaign_queued' : 'tg_campaign_started',
    id: campaign.id,
    name: campaign.name,
    total: campaign.total,
    duplicateWindowHours: campaign.duplicateWindowHours,
    skippedDuplicates: campaign.skippedDuplicates,
  });
});

// campaignId (body ou query, optionnel) : cible une campagne précise du
// Gestionnaire Multi-Campagnes — omis, agit sur la campagne "par défaut".
app.post('/api/telegram/campaign/pause', requireAccess, requireModule('telegram'), attachTelegram, (req, res) => {
  try {
    req.telegramCampaignEngine.pause(req.body.campaignId || req.query.campaignId);
    res.status(200).json({ status: 'pause_requested' });
  } catch (err) {
    if (err.message === 'NO_CAMPAIGN_RUNNING') {
      return res.status(400).json({ error: 'Aucune campagne Telegram en cours à mettre en pause.' });
    }
    throw err;
  }
});

// Async (voir /api/messages/resume, même principe) : une bascule depuis une
// AUTRE campagne active attend que sa boucle d'envoi ait réellement quitté.
app.post('/api/telegram/campaign/resume', requireAccess, requireModule('telegram'), attachTelegram, async (req, res) => {
  try {
    const campaign = await req.telegramCampaignEngine.resume(req.body.campaignId || req.query.campaignId);
    res.status(200).json({ status: 'resume_requested', campaign });
  } catch (err) {
    if (err.message === 'NO_CAMPAIGN_RUNNING') {
      return res.status(400).json({ error: 'Aucune campagne Telegram en cours à reprendre.' });
    }
    throw err;
  }
});

app.post('/api/telegram/campaign/stop', requireAccess, requireModule('telegram'), attachTelegram, (req, res) => {
  try {
    req.telegramCampaignEngine.stop(req.body.campaignId || req.query.campaignId);
    res.status(200).json({ status: 'stop_requested' });
  } catch (err) {
    if (err.message === 'NO_CAMPAIGN_RUNNING') {
      return res.status(400).json({ error: 'Aucune campagne Telegram en cours à interrompre.' });
    }
    throw err;
  }
});

app.get('/api/telegram/campaign/status', requireAccess, requireModule('telegram'), attachTelegram, (req, res) => {
  const status = req.telegramCampaignEngine.getStatus(req.query.campaignId);
  if (!status) {
    return res.status(200).json({ exists: false });
  }

  res.status(200).json({ exists: true, ...status });
});

// Gestionnaire Multi-Campagnes (dashboard) — voir /api/messages/campaigns
// pour l'équivalent WhatsApp, même principe.
app.get('/api/telegram/campaigns', requireAccess, requireModule('telegram'), attachTelegram, (req, res) => {
  res.status(200).json({ campaigns: req.telegramCampaignEngine.listCampaigns() });
});

app.post('/api/telegram/campaigns/:id/play', requireAccess, requireModule('telegram'), attachTelegram, async (req, res) => {
  try {
    const campaign = await req.telegramCampaignEngine.resume(req.params.id);
    res.status(200).json({ status: 'resume_requested', campaign });
  } catch (err) {
    if (err.message === 'NO_CAMPAIGN_RUNNING') {
      return res.status(404).json({ error: 'Campagne introuvable ou déjà terminée.' });
    }
    throw err;
  }
});

app.post('/api/telegram/campaigns/:id/pause', requireAccess, requireModule('telegram'), attachTelegram, (req, res) => {
  try {
    req.telegramCampaignEngine.pause(req.params.id);
    res.status(200).json({ status: 'pause_requested' });
  } catch (err) {
    if (err.message === 'NO_CAMPAIGN_RUNNING') {
      return res.status(400).json({ error: 'Cette campagne n\'est pas en cours d\'envoi.' });
    }
    throw err;
  }
});

app.post('/api/telegram/campaigns/:id/stop', requireAccess, requireModule('telegram'), attachTelegram, (req, res) => {
  try {
    req.telegramCampaignEngine.stop(req.params.id);
    res.status(200).json({ status: 'stop_requested' });
  } catch (err) {
    if (err.message === 'NO_CAMPAIGN_RUNNING') {
      return res.status(404).json({ error: 'Campagne introuvable ou déjà arrêtée.' });
    }
    throw err;
  }
});

// Onglet dashboard "Relance Manuelle Express" (Telegram) — voir
// /api/messages/manual-queue pour l'équivalent WhatsApp, même principe :
// TelegramCampaignEngine#getManualRelaunchQueue.
app.get('/api/telegram/campaign/manual-queue', requireAccess, requireModule('telegram'), attachTelegram, (req, res) => {
  res.status(200).json({ items: req.telegramCampaignEngine.getManualRelaunchQueue(req.query.campaignId) });
});

// Trace l'ouverture manuelle d'un deep link Telegram pour un contact donné
// (statut 'sent_manual') — voir TelegramCampaignEngine#markManualSent.
app.post('/api/telegram/campaign/manual-queue/:index/sent', requireAccess, requireModule('telegram'), attachTelegram, (req, res) => {
  const index = parseInt(req.params.index, 10);
  const result = req.telegramCampaignEngine.markManualSent(index, req.body.campaignId || req.query.campaignId);
  if (!result) {
    return res.status(404).json({ error: 'Contact introuvable dans la campagne en cours.' });
  }
  res.status(200).json({ status: 'sent_manual', result });
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

// ---------- Génération d'images IA (FLUX réel via fal.ai, voir lib/media/imageAiEngine.js) ----------
// Appelée depuis le Studio Média (voir public/dashboard.html#mediaFetchBackgroundImageOnce)
// AVANT toute tentative Pollinations — la clé fal.ai reste côté serveur,
// jamais exposée au navigateur. Retourne un lien /v/:id/raw (même store que
// Image-to-Link ci-dessous) plutôt que l'URL fal.ai brute, pour garantir des
// en-têtes CORS cohérents avec le reste de l'app (nécessaire à
// img.crossOrigin='anonymous' pour l'export PNG du canvas côté client).
app.post('/api/media/generate-image', requireAccess, requireModule('studio_video'), async (req, res) => {
  const prompt = String((req.body || {}).prompt || '').trim().slice(0, 2000);
  if (!prompt) {
    return res.status(400).json({ error: 'Prompt manquant.' });
  }
  const width = Math.min(Math.max(parseInt((req.body || {}).width, 10) || 1024, 256), 1536);
  const height = Math.min(Math.max(parseInt((req.body || {}).height, 10) || 1024, 256), 1536);

  try {
    const { buffer, mimetype, provider } = await imageAiEngine.generateImage({ prompt, width, height });
    const id = imageLinkStore.register(buffer, mimetype, { title: 'Image IA — CYRUS SUPER ASSISTANT', width, height });
    res.json({ url: `${PUBLIC_BASE_URL}/v/${id}/raw`, provider });
  } catch (err) {
    if (err.kind === 'not_configured') {
      return res.status(503).json({ error: err.message });
    }
    console.error('Erreur génération image IA (fal.ai):', err.message);
    res.status(502).json({ error: 'Échec de la génération image IA côté serveur — repli automatique sur Pollinations.' });
  }
});

// ---------- Image-to-Link (aperçu visuel WhatsApp/Telegram, voir lib/media/imageLinkStore.js) ----------
function escapeHtml(str) {
  return String(str || '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

// Accepte soit un fichier importé (multipart, champ "image"), soit une
// affiche Studio IA exportée côté client en data URL (canvas.toDataURL(),
// champ JSON "imageDataUrl") — couvre les deux sources demandées par la
// feuille de route sans dupliquer la logique d'upload.
app.post('/api/media/image-link', requireAccess, upload.single('image'), (req, res) => {
  let buffer;
  let mimetype;

  if (req.file) {
    buffer = req.file.buffer;
    mimetype = req.file.mimetype;
  } else {
    const dataUrl = String((req.body || {}).imageDataUrl || '');
    const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: 'Aucune image reçue (fichier importé ou affiche Studio IA attendus).' });
    }
    mimetype = match[1];
    buffer = Buffer.from(match[2], 'base64');
  }

  const title = String((req.body || {}).title || '').trim().slice(0, 120) || 'Aperçu image — CYRUS SUPER ASSISTANT';
  // width/height (mesurées côté client, voir public/dashboard.html) : alimentent
  // og:image:width/height, qui accélèrent le rendu de la carte d'aperçu par
  // WhatsApp/Telegram (dimensions connues sans devoir télécharger l'image
  // d'abord). contactPhone (optionnel) : numéro affiché par le bouton "Nous
  // contacter sur WhatsApp" de la landing page (voir GET /v/:id) — jamais
  // deviné depuis la session WhatsApp connectée, car le contact public
  // affiché au prospect peut légitimement différer du compte d'automatisation.
  const width = parseInt((req.body || {}).width, 10) || null;
  const height = parseInt((req.body || {}).height, 10) || null;
  const contactPhone = String((req.body || {}).contactPhone || '').replace(/[^\d+]/g, '').slice(0, 20) || null;
  const id = imageLinkStore.register(buffer, mimetype, { title, width, height, contactPhone });
  res.json({ url: `${PUBLIC_BASE_URL}/v/${id}`, expiresInHours: 6 });
});

// Doit rester PUBLIQUE et sans authentification, même principe que
// /api/media/temp/:token ci-dessus : c'est le "crawler" de prévisualisation
// de lien de WhatsApp/Telegram lui-même qui va chercher cette page pour en
// extraire les balises Open Graph — il n'envoie jamais nos en-têtes
// d'authentification. Le jeton (32 caractères hex) fait office de
// protection contre la découverte, et le lien expire après 6h (voir
// lib/media/imageLinkStore.js).
app.get('/v/:id', (req, res) => {
  const entry = imageLinkStore.get(req.params.id);
  if (!entry) {
    return res.status(404).send('<!doctype html><html><body>Fichier expiré ou introuvable.</body></html>');
  }

  // Ce même store héberge désormais aussi bien des images (Image-to-Link)
  // que des vidéos (voir POST /api/studio/video-ai/status, résultat LTX-Video)
  // — même principe d'hébergement éphémère avec lien /v/:id, seules les
  // balises Open Graph et la balise média affichée diffèrent selon le type.
  const isVideo = (entry.mimetype || '').startsWith('video/');
  const mediaUrl = `${PUBLIC_BASE_URL}/v/${req.params.id}/raw`;
  const title = escapeHtml(entry.meta.title);
  const dimensionTags = (!isVideo && entry.meta.width && entry.meta.height)
    ? `<meta property="og:image:width" content="${entry.meta.width}">\n<meta property="og:image:height" content="${entry.meta.height}">`
    : '';
  const contactPhone = entry.meta.contactPhone ? entry.meta.contactPhone.replace(/^\+/, '') : null;
  const whatsappBtn = contactPhone
    ? `<a class="btn btn-whatsapp" href="https://wa.me/${escapeHtml(contactPhone)}" target="_blank" rel="noopener">💬 Nous contacter sur WhatsApp</a>`
    : '';
  const ogMediaTags = isVideo
    ? `<meta property="og:video" content="${mediaUrl}">\n<meta property="og:video:type" content="${escapeHtml(entry.mimetype)}">`
    : `<meta property="og:image" content="${mediaUrl}">\n${dimensionTags}`;
  const mediaTag = isVideo
    ? `<video src="${mediaUrl}" controls autoplay muted loop playsinline></video>`
    : `<img src="${mediaUrl}" alt="${title}">`;
  const downloadLabel = isVideo ? "📥 Télécharger la vidéo" : "📥 Télécharger l'image";

  // Micro-landing page (feuille de route "Micro-Landing Page d'aperçu &
  // téléchargement direct HD") : centrée, réactive mobile, avec un
  // téléchargement direct (lien <a download> même origine, aucune API
  // blob nécessaire côté client) et un CTA WhatsApp optionnel — ET les
  // balises Open Graph nécessaires au rendu de la carte d'aperçu par
  // WhatsApp/Telegram AVANT même que le prospect n'ouvre le lien.
  res.set('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<meta property="og:type" content="website">
<meta property="og:title" content="${title}">
<meta property="og:description" content="Partagé via CYRUS SUPER ASSISTANT">
${ogMediaTags}
<meta name="twitter:card" content="summary_large_image">
<style>
  body { margin:0; background:#111; color:#fff; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; display:flex; flex-direction:column; align-items:center; min-height:100vh; padding:1.25rem; box-sizing:border-box; }
  img, video { max-width:100%; max-height:70vh; border-radius:10px; box-shadow:0 4px 24px rgba(0,0,0,0.4); }
  .actions { display:flex; flex-direction:column; gap:0.75rem; width:100%; max-width:360px; margin-top:1.25rem; }
  .btn { display:block; text-align:center; padding:0.9rem 1rem; border-radius:10px; font-weight:bold; text-decoration:none; font-size:1rem; }
  .btn-download { background:#fff; color:#111; }
  .btn-whatsapp { background:#25D366; color:#fff; }
</style>
</head>
<body>
${mediaTag}
<div class="actions">
<a class="btn btn-download" href="${mediaUrl}" download>${downloadLabel}</a>
${whatsappBtn}
</div>
</body>
</html>`);
});

app.get('/v/:id/raw', (req, res) => {
  const entry = imageLinkStore.get(req.params.id);
  if (!entry) {
    return res.status(404).send('Fichier expiré ou introuvable.');
  }
  res.set('Content-Type', entry.mimetype || 'image/png');
  res.set('Cache-Control', 'public, max-age=21600');
  res.send(entry.buffer);
});

// ---------- Studio Vidéo IA (image-to-video LTX-Video, voir lib/media/videoAiEngine.js) ----------
// Job asynchrone : la génération LTX-Video prend de 30s à quelques minutes,
// incompatible avec une requête HTTP bloquante. Le "jobToken" renvoyé au
// client encode l'état du job (fournisseur + URLs de suivi) en base64 —
// aucun état côté serveur à faire survivre entre les requêtes de polling,
// cohérent avec le reste de l'architecture (disque éphémère, voir
// CLAUDE.md) et résilient à un redéploiement en plein milieu d'une
// génération (le pire cas est un jobToken qui échoue au prochain poll,
// jamais un crash serveur).
function encodeVideoAiJobToken(job) {
  return Buffer.from(JSON.stringify(job), 'utf8').toString('base64url');
}

function decodeVideoAiJobToken(token) {
  return JSON.parse(Buffer.from(String(token || ''), 'base64url').toString('utf8'));
}

app.post('/api/studio/video-ai/start', requireAccess, requireModule('studio_video'), upload.single('image'), async (req, res) => {
  try {
    let buffer;
    let mimetype;
    if (req.file) {
      buffer = req.file.buffer;
      mimetype = req.file.mimetype;
    } else {
      const dataUrl = String((req.body || {}).imageDataUrl || '');
      const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!match) {
        return res.status(400).json({ error: 'Aucune image reçue (fichier importé ou affiche Studio IA attendus).' });
      }
      mimetype = match[1];
      buffer = Buffer.from(match[2], 'base64');
    }

    const prompt = String((req.body || {}).prompt || '').trim().slice(0, 500);
    // Choix explicite de moteur (voir dashboard.html, sélecteur "Moteur" du
    // Studio Vidéo IA) — 'auto' (ou absent) garde la cascade automatique
    // habituelle (fal -> replicate -> huggingface), 'ltx2'/'wan21' forcent
    // un générateur précis (voir videoAiEngine.js#startVideoAiJob).
    const rawProvider = String((req.body || {}).provider || '').trim();
    const preferredProvider = rawProvider === 'ltx2' ? rawProvider : undefined;

    // fal.ai/Replicate ont besoin d'une URL http(s) publique pour l'image de
    // départ (pas de data URL/multipart direct) — on réutilise le store
    // Image-to-Link déjà en place (voir POST /api/media/image-link) plutôt
    // que de dupliquer un hébergement temporaire distinct.
    const sourceImageId = imageLinkStore.register(buffer, mimetype, { title: 'Image source — génération vidéo IA' });
    const sourceImageUrl = `${PUBLIC_BASE_URL}/v/${sourceImageId}/raw`;

    const job = await videoAiEngine.startVideoAiJob(sourceImageUrl, prompt, undefined, preferredProvider);
    res.json({ jobToken: encodeVideoAiJobToken(job), provider: job.hfMode || job.provider });
  } catch (err) {
    if (err.kind === 'not_configured') {
      return res.status(503).json({ error: err.message });
    }
    console.error('Erreur lors du démarrage du job vidéo IA:', err.message);
    res.status(500).json({ error: "Échec du démarrage de la génération vidéo IA — vérifiez la clé API configurée côté serveur." });
  }
});

app.get('/api/studio/video-ai/status', requireAccess, requireModule('studio_video'), async (req, res) => {
  let job;
  try {
    job = decodeVideoAiJobToken(req.query.jobToken);
  } catch (err) {
    return res.status(400).json({ status: 'error', message: 'jobToken invalide.' });
  }

  try {
    const result = await videoAiEngine.pollVideoAiJob(job);
    if (!result.done) {
      return res.json({ status: 'pending' });
    }

    // fal.ai/Replicate renvoient une URL à télécharger nous-mêmes ;
    // Hugging Face (voir videoAiEngine.js#pollHuggingFaceJob) renvoie
    // directement les octets de la vidéo, sans URL intermédiaire.
    let buffer;
    let mimetype;
    if (result.videoUrl) {
      const videoRes = await axios.get(result.videoUrl, { responseType: 'arraybuffer', timeout: 60_000 });
      buffer = Buffer.from(videoRes.data);
      mimetype = videoRes.headers['content-type'] || 'video/mp4';
    } else {
      buffer = result.videoBuffer;
      mimetype = result.videoMimetype || 'video/mp4';
    }
    const id = imageLinkStore.register(buffer, mimetype, { title: 'Vidéo IA — CYRUS SUPER ASSISTANT' });
    res.json({ status: 'done', url: `${PUBLIC_BASE_URL}/v/${id}`, expiresInHours: 6 });
  } catch (err) {
    console.error('Erreur pendant le suivi du job vidéo IA:', err.message);
    res.json({ status: 'error', message: err.message || 'Échec de la génération vidéo IA.' });
  }
});

// ---------- Storyboard vidéo IA multi-scènes (voir lib/media/storyboardEngine.js) ----------
// Pipeline long (une génération vidéo par scène, potentiellement plusieurs
// minutes au total) orchestré entièrement côté serveur — startStoryboard()
// renvoie immédiatement un id, l'avancement réel se lit via le polling de
// /status ci-dessous, sur le même principe que /api/studio/video-ai/* mais
// avec plusieurs étapes internes (voir storyboardEngine.js) plutôt qu'un
// simple relais vers un job de fournisseur externe.
app.post('/api/studio/storyboard/start', requireAccess, requireModule('studio_video'), upload.single('image'), async (req, res) => {
  try {
    let buffer;
    let mimetype;
    if (req.file) {
      buffer = req.file.buffer;
      mimetype = req.file.mimetype;
    } else {
      const dataUrl = String((req.body || {}).imageDataUrl || '');
      const match = dataUrl.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
      if (!match) {
        return res.status(400).json({ error: 'Aucune image de départ reçue (fichier importé ou affiche Studio IA attendus).' });
      }
      mimetype = match[1];
      buffer = Buffer.from(match[2], 'base64');
    }

    let scenes;
    try {
      scenes = JSON.parse((req.body || {}).scenes || '[]');
    } catch (err) {
      scenes = [];
    }
    scenes = (Array.isArray(scenes) ? scenes : [])
      .map((s) => String(s || '').trim().slice(0, 300))
      .filter(Boolean)
      .slice(0, 8); // limite raisonnable : chaque scène = plusieurs minutes de génération
    if (scenes.length < 2) {
      return res.status(400).json({ error: 'Renseignez au moins 2 scènes pour générer un storyboard multi-scènes.' });
    }
    const baseStyle = String((req.body || {}).baseStyle || '').trim().slice(0, 200);

    // Vérifié AVANT de lancer le pipeline (plutôt que de le découvrir en
    // pleine scène 1, après avoir déjà consommé un slot du store d'images).
    const providers = videoAiEngine.isConfigured();
    if (!providers.fal && !providers.replicate && !providers.huggingface) {
      return res.status(503).json({ error: "Aucun fournisseur vidéo IA configuré côté serveur (FAL_KEY, REPLICATE_API_TOKEN ou HUGGINGFACE_API_KEY absents dans .env)." });
    }

    const storyboardId = storyboardEngine.startStoryboard({
      imageBuffer: buffer,
      imageMimetype: mimetype,
      scenes,
      baseStyle,
      publicBaseUrl: PUBLIC_BASE_URL,
    });
    res.json({ storyboardId, totalScenes: scenes.length });
  } catch (err) {
    console.error('Erreur lors du démarrage du storyboard vidéo IA:', err.message);
    res.status(500).json({ error: 'Échec du démarrage du storyboard vidéo IA.' });
  }
});

app.get('/api/studio/storyboard/status/:id', requireAccess, requireModule('studio_video'), (req, res) => {
  const state = storyboardEngine.getStoryboardStatus(req.params.id);
  if (!state) {
    return res.status(404).json({ status: 'error', message: 'Storyboard introuvable ou expiré.' });
  }
  if (state.status === 'error') {
    return res.json({ status: 'error', message: state.error || 'Échec du storyboard vidéo IA.' });
  }
  if (state.status !== 'done') {
    return res.json({ status: state.status, currentScene: state.currentScene, totalScenes: state.totalScenes });
  }

  const id = imageLinkStore.register(state.resultBuffer, state.resultMimetype, { title: 'Storyboard vidéo IA — CYRUS SUPER ASSISTANT' });
  storyboardEngine.clearStoryboard(req.params.id);
  res.json({ status: 'done', url: `${PUBLIC_BASE_URL}/v/${id}`, expiresInHours: 6 });
});

// ---------- Import vidéo personnelle & habillage TikTok/Reels (voir lib/media/videoMixerEngine.js) ----------
// Traitement 100% local (ffmpeg), pas d'appel à un fournisseur externe — donc
// synchrone (pas de job/poll comme /api/studio/video-ai ou /api/studio/storyboard
// ci-dessus) : quelques clips courts se montent en quelques secondes à
// quelques dizaines de secondes, largement dans le budget d'une requête HTTP
// classique. whatsappMediaUpload (déjà configuré à 100 Mo/fichier, voir plus
// haut) est réutilisé tel quel plutôt que de définir une nouvelle instance
// multer dédiée pour ce seul besoin, identique en pratique.
app.post('/api/studio/video-mixer', requireAccess, requireModule('studio_video'), whatsappMediaUpload.fields([
  { name: 'clips', maxCount: 10 },
  { name: 'music', maxCount: 1 },
  { name: 'logo', maxCount: 1 },
]), async (req, res) => {
  try {
    const files = req.files || {};
    const clipFiles = files.clips || [];
    if (clipFiles.length === 0) {
      return res.status(400).json({ error: 'Importez au moins un clip vidéo.' });
    }

    const body = req.body || {};
    const buffer = await videoMixerEngine.mixVideos({
      clipBuffers: clipFiles.map((f) => f.buffer),
      autoStyle916: String(body.autoStyle916) === 'true',
      musicBuffer: (files.music && files.music[0]) ? files.music[0].buffer : null,
      musicVolume: parseFloat(body.musicVolume),
      fadeAudio: String(body.fadeAudio) === 'true',
      // .replace([\r\n]+, ' ') en plus du .trim() : défense en profondeur
      // avant même d'atteindre escapeDrawtext (voir videoMixerEngine.js) —
      // ces champs viennent normalement d'<input type="text"> côté
      // dashboard (jamais de saut de ligne possible), mais un appel direct
      // à cette API pourrait en injecter un.
      titleText: String(body.titleText || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 100),
      priceText: String(body.priceText || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60),
      contactText: String(body.contactText || '').replace(/[\r\n]+/g, ' ').trim().slice(0, 60),
      logoBuffer: (files.logo && files.logo[0]) ? files.logo[0].buffer : null,
    });

    const id = imageLinkStore.register(buffer, 'video/mp4', { title: 'Montage vidéo — CYRUS SUPER ASSISTANT' });
    res.json({ url: `${PUBLIC_BASE_URL}/v/${id}`, expiresInHours: 6 });
  } catch (err) {
    console.error('Erreur lors du montage vidéo:', err.message);
    res.status(500).json({ error: err.message || 'Échec du montage vidéo.' });
  }
});

app.get('/api/media/status', requireAccess, requireModule('studio_video'), (req, res) => {
  res.status(200).json({
    youtube: { configured: mediaPublisher.isYoutubeConfigured(), connectAvailable: mediaPublisher.isYoutubeConnectAvailable() },
    instagram: { configured: mediaPublisher.isInstagramConfigured() },
    tiktok: { configured: mediaPublisher.isTikTokConfigured(), connectAvailable: mediaPublisher.isTikTokConnectAvailable() },
    videoAi: videoAiEngine.isConfigured(),
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

// ---------- Copywriter Studio IA (assistant marketing/closing 100% local) ----------
// Même convention de tenant que le reste de l'app (voir
// adapters/whatsappManager.js#getSessionForRequest) : l'admin et chaque clé
// de licence ont leurs propres discussions, jamais partagées.
function resolveTenantId(req) {
  return req.isAdmin ? '__admin__' : req.licenseKey;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

app.get('/api/ai-studio/sessions', requireAccess, requireModule('studio_video'), async (req, res) => {
  const sessions = await aiStudioStore.listSessions(resolveTenantId(req));
  res.json({ sessions });
});

app.post('/api/ai-studio/sessions', requireAccess, requireModule('studio_video'), async (req, res) => {
  const session = await aiStudioStore.createSession(resolveTenantId(req));
  res.status(201).json({ session });
});

app.get('/api/ai-studio/sessions/:id', requireAccess, requireModule('studio_video'), async (req, res) => {
  const session = await aiStudioStore.getSession(resolveTenantId(req), req.params.id);
  if (!session) {
    return res.status(404).json({ error: 'Discussion introuvable.' });
  }
  res.json({ session });
});

app.delete('/api/ai-studio/sessions/:id', requireAccess, requireModule('studio_video'), async (req, res) => {
  const deleted = await aiStudioStore.deleteSession(resolveTenantId(req), req.params.id);
  if (!deleted) {
    return res.status(404).json({ error: 'Discussion introuvable.' });
  }
  res.status(204).end();
});

// ---------- Chat-First : détection d'intention & orchestration (Studio IA unifié) ----------
// Remplace les formulaires à champs multiples (ex-Studio Média, ex-
// Générateur de Livres) par un unique fil de discussion : l'utilisateur
// décrit ce qu'il veut (+ pièces jointes optionnelles), l'IA complète le
// brief par 2-3 questions ciblées si nécessaire puis propose des BOUTONS
// D'ACTION (jamais de génération automatique non désirée, qui gâcherait un
// appel fal.ai payant sur un brief encore incomplet) — le clic déclenche le
// rendu réel (image FLUX / vidéo IA / PDF), avec incrustation automatique
// du logo/contact importé dans le tchat.
const IMAGE_QUALITY_SUFFIX_EN = 'professional commercial product photography, 8k resolution, studio lighting, hyper-detailed, advertising poster style, crisp focus, clean composition, high-end graphic design, no blur, no distortion, no abstract, no deformed proportions, no noise, no draft look, no watermark, no text';

// Listes de mots-clés élargies (feuille de route "Briefing Interactif
// Universel") suite à un cas réel non couvert : une demande formulée comme
// "publicité"/"promo" (sans les mots "affiche"/"flyer"/"poster" d'origine)
// tombait dans le cas générique 'chat' ci-dessous, qui ne bénéficie d'AUCUN
// garde-fou structuré — le modèle a alors librement produit un gabarit
// HTML/CSS complet affiché tel quel à l'utilisateur (voir looksLikeRawMarkupDump
// plus bas pour le filet de sécurité complémentaire, au niveau de la sortie
// plutôt que de l'entrée, qui couvre aussi les formulations non anticipées
// ici).
// \b (limite de mot) en JavaScript se base sur [A-Za-z0-9_] uniquement : un
// mot-clé terminé par un accent (ex. "publicité", "communiqué") NE MATCHE
// JAMAIS avec un \b final, la lettre accentuée n'étant pas considérée comme
// un caractère de mot par le moteur — bug constaté en test réel juste après
// l'ajout de ces mots-clés (ci-dessous), silencieux (aucune erreur, juste
// aucune détection). Plutôt que de traquer un par un les mots-clés
// concernés, le texte entrant est translittéré en ASCII (accents retirés)
// AVANT le test, et les mots-clés eux-mêmes sont écrits sans accent.
function foldAccents(text) {
  return String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function detectStudioIntent(text) {
  const t = foldAccents(text);
  if (/\b(livre|e-?book|ouvrage|guide|manuel|formation pdf|rapport pdf|brochure numerique)\b/i.test(t)) return 'book';
  if (/\b(video|clip video|reels?|shorts?|tiktok|capsule|spot video)\b/i.test(t)) return 'video';
  if (/\b(affiche|flyer|banniere publicitaire|poster|visuel publicitaire|design graphique|publicite|\bpub\b|promo(tion)?|annonce|communique|prospectus|depliant|carte de visite)\b/i.test(t)) return 'image';
  return 'chat';
}

// Un seul appel LLM par tour : soit 2-3 questions ciblées (texte simple, le
// brief est incomplet), soit un JSON "ready" prêt à l'exécution — jamais les
// deux mélangés. Évite une étape de classification séparée : c'est le LLM
// lui-même, guidé par `extraInstruction`, qui juge si le brief est
// suffisant.
// Garde-fou PROGRAMMATIQUE (voir en-tête de fichier) contre un mode
// "tutoriel" que certains modèles gratuits (constaté en test réel sur
// Groq) produisent malgré une instruction explicite de ne jamais le faire —
// plus fiable qu'un simple renforcement du prompt, qui a montré ses limites
// (testé : renforcer l'instruction n'a pas empêché le tutoriel, et a même
// dégradé la détection "prêt" sur un brief pourtant complet). Détecte les
// signatures STRUCTURELLES d'une réponse "hors format" — un tutoriel
// (titres Markdown, tableau, mention d'un logiciel tiers) mais aussi,
// constaté également en test réel, un contenu complet rédigé directement
// (ex: chapitres entiers) au lieu du JSON de planification demandé —
// plutôt qu'une liste de mots-clés qui ne peut pas couvrir tous les cas,
// la longueur et le nombre de lignes seuls suffisent déjà à distinguer
// "2-3 questions courtes" d'un texte long, quelle qu'en soit la nature.
function looksLikeRunawayTutorial(raw) {
  const t = String(raw || '').trim();
  if (t.length > 500) return true;
  if ((t.match(/\n/g) || []).length > 8) return true;
  if (/^#{1,3}\s/m.test(t)) return true;
  if (/\|.+\|.+\|/.test(t)) return true;
  if (/\b(blender|after effects|photoshop|premiere|davinci|canva|sketchfab)\b/i.test(t)) return true;
  return false;
}

// Filet de sécurité complémentaire, cette fois côté RÉPONSE GÉNÉRIQUE (voir
// la branche 'chat' de POST .../messages ci-dessous) plutôt que côté
// planification structurée : detectStudioIntent() reste une liste de
// mots-clés, forcément incomplète (constaté en démonstration réelle : une
// demande de "publicité" produisait un gabarit HTML/CSS complet — balises
// <div>/<span>/<a>, attributs style="...", règles ".prix{...}" — recopié
// tel quel dans le tchat). Détecte cette signature STRUCTURELLE (balisage
// HTML ou règle CSS) quel que soit le module d'origine, pour rattraper tout
// message mal classé plutôt que d'étendre indéfiniment la liste de
// mots-clés.
function looksLikeRawMarkupDump(raw) {
  const t = String(raw || '');
  if (/<\/?(div|span|a|img|h[1-6]|p|br|button)\b[^>]*>/i.test(t)) return true;
  if (/style\s*=\s*"/i.test(t)) return true;
  if (/\.[a-zA-Z][\w-]*\s*\{[^}]{0,300}\}/.test(t)) return true;
  return false;
}

// BUG CORRIGÉ (constaté en test réel, feuille de route "Briefing Interactif
// Universel") : l'historique était auparavant toujours passé comme `[]` à
// generateAIResponse — chaque tour de planification repartait donc de zéro,
// sans aucun souvenir des réponses déjà données aux questions précédentes.
// Résultat observé : le brief ne convergeait JAMAIS vers "ready", le modèle
// reposant en boucle les mêmes questions (date, contact, logo...) même
// après que le client y ait répondu. `history` (voir aiStudioStore.js,
// même format {role, text} que toChatMessages() dans llmFallbackEngine.js)
// doit être l'historique de la discussion AVANT le tour courant, pour que
// chaque question posée s'appuie sur ce qui a déjà été fourni.
async function planOrAsk(skillKey, text, extraInstruction, history) {
  const prompt = [
    `Nouveau message du client dans cette discussion : "${text}"`,
    extraInstruction,
    'Base-toi sur TOUT l\'historique de cette discussion (déjà fourni ci-dessus) pour savoir ce qui a déjà été répondu — ne repose jamais une question à laquelle le client a déjà répondu, même dans un message précédent.',
    'Si des informations importantes manquent encore pour bien répondre à cette demande, réponds UNIQUEMENT par 2 à 3 questions courtes (texte simple, jamais de JSON, jamais plus de 3 questions, jamais une question déjà répondue).',
    'Si tu as assez d\'informations (en combinant ce message et l\'historique), réponds UNIQUEMENT avec l\'objet JSON demandé ci-dessus (aucun texte avant/après, aucun markdown).',
  ].filter(Boolean).join('\n');
  const { text: raw } = await llmFallbackEngine.generateAIResponse(prompt, history, null, undefined, skillKey);
  const trimmed = raw.trim();
  const parsed = extractJsonBlock(trimmed);
  // Filet de sécurité : un texte qui ressemble à un tutoriel (voir
  // looksLikeRunawayTutorial) est remplacé par une invite générique plutôt
  // que montré tel quel — jamais de mode d'emploi affiché à la place d'une
  // génération réelle.
  if (!parsed && looksLikeRunawayTutorial(trimmed)) {
    return { raw: 'Je m\'en charge directement avec nos outils — décrivez-moi précisément ce que vous voulez (et le contact/prix si besoin), sans vous soucier de la méthode.', parsed: null };
  }
  return { raw: trimmed, parsed };
}

// BUG CORRIGÉ (retour utilisateur, exemples de vraies affiches pro
// fournis) : l'ancien schéma (titleText/priceText/contactText/badgeText
// seuls) produisait un simple visuel photo + 2-3 lignes de texte plaqué
// dessus (voir imageCompositorEngine.js, ffmpeg drawtext) — jamais la mise
// en page structurée (en-tête logo/marque, liste de bénéfices à puces,
// bandeau de prix) des exemples réels. Le rendu passe désormais par un
// vrai moteur de templates (voir lib/media/posterTemplateEngine.js, satori
// + resvg) que ce schéma alimente en contenu structuré plutôt qu'en texte
// brut à positions fixes.
function planImage(text, history) {
  return planOrAsk('designDirectorSkill', text, [
    'Tu prépares une affiche marketing PROFESSIONNELLE (mise en page structurée façon flyer de graphiste — en-tête marque, liste de bénéfices, bandeau de prix, pied de page contact) pour le Studio IA de CYRUS SUPER ASSISTANT.',
    'Informations importantes à obtenir si absentes de la demande : le nom de l\'entreprise/marque, 3 à 5 bénéfices ou points clés à mettre en avant (courts, percutants), le prix ou l\'offre exacte, le contact (téléphone/WhatsApp) à afficher — invite aussi le client à importer son logo ou une photo du produit directement dans le tchat s\'il ne l\'a pas déjà fait.',
    'Choisis "template":"product_photo" si une vraie photo du produit/lieu apporte de la valeur (restauration, produit physique, immobilier...), sinon "template":"icons_list" (service, formation, logiciel, offre abstraite) — dans ce second cas N\'INCLUS PAS imagePromptEnglish (aucune photo ne sera générée).',
    'Choisis "colorTheme" parmi exactement : green, blue, red, purple, brown — celui qui correspond le mieux au secteur/à la marque.',
    'Format JSON si prêt : {"ready":true,"summary":"résumé en français de l\'affiche qui va être créée","template":"icons_list ou product_photo","businessName":"nom de l\'entreprise","tagline":"accroche courte et percutante (1 phrase)","bulletPoints":[{"text":"bénéfice 1 court"},{"text":"bénéfice 2 court"},{"text":"bénéfice 3 court"}],"priceText":"prix/offre ou chaîne vide","badgeText":"badge court ou chaîne vide (ex: PROMO, NOUVEAU)","contactText":"contact ou chaîne vide","colorTheme":"green|blue|red|purple|brown","imagePromptEnglish":"UNIQUEMENT si template=product_photo : prompt photo professionnel ultra détaillé en anglais"}',
  ].join('\n'), history);
}

function planVideo(text, history) {
  return planOrAsk('videoCinematographerSkill', text, [
    'Tu prépares une courte vidéo générée par IA pour le Studio IA de CYRUS SUPER ASSISTANT.',
    'Informations importantes à obtenir si absentes : ce que la vidéo doit montrer précisément — invite le client à importer une photo du produit ou son logo dans le tchat s\'il ne l\'a pas déjà fait.',
    'Format JSON si prêt : {"ready":true,"summary":"résumé en français de la vidéo qui va être créée","motionPromptEnglish":"prompt de mouvement cinématographique en anglais"}',
  ].join('\n'), history);
}

function planBook(text, history) {
  return planOrAsk('bookPlannerSkill', text, [
    'Tu prépares un livre/guide PDF pour le Studio IA de CYRUS SUPER ASSISTANT.',
    'Informations importantes à obtenir si absentes : le sujet précis, l\'angle souhaité, le public visé.',
    'Format JSON si prêt : {"ready":true,"summary":"résumé en français du livre qui va être créé","title":"titre du livre","chapterTopics":["sujet du chapitre 1","sujet du chapitre 2","sujet du chapitre 3"]} (entre 3 et 5 sujets de chapitre).',
  ].join('\n'), history);
}

// Cherche la pièce jointe la plus récente d'un rôle donné ('logo'|'photo')
// dans l'historique — voir la route POST .../messages ci-dessous, qui
// devine ce rôle depuis le texte accompagnant l'envoi ("mon logo" -> logo,
// sinon -> photo). `attachment.id` référence une entrée déjà hébergée via
// imageLinkStore (voir lib/media/imageLinkStore.js).
function findRecentAttachment(messages, role) {
  const list = Array.isArray(messages) ? messages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const att = list[i] && list[i].attachment;
    if (att && att.role === role) return att;
  }
  return null;
}

function loadAttachmentBuffer(attachment) {
  if (!attachment) return null;
  const entry = imageLinkStore.get(attachment.id);
  return entry ? { buffer: entry.buffer, mimetype: entry.mimetype } : null;
}

// ---------- Exécution des actions (clic sur un bouton du tchat) ----------
// Template "product_photo" (voir planImage/posterTemplateEngine.js) : une
// vraie photo est générée via FLUX/Pollinations (imageAiEngine.js) et
// intégrée au template comme hero visuel. Template "icons_list" : aucun
// appel de génération d'image — la mise en page structurée (texte + icônes)
// suffit et évite un coût/délai FLUX inutile pour une offre abstraite.
async function executeGenerateImage(payload, messages) {
  const template = payload.template === 'product_photo' ? 'product_photo' : 'icons_list';

  let photoDataUri = null;
  if (template === 'product_photo' && payload.imagePromptEnglish) {
    const prompt = `${String(payload.imagePromptEnglish).slice(0, 2000)}, ${IMAGE_QUALITY_SUFFIX_EN}`;
    const { buffer, mimetype } = await imageAiEngine.generateImage({ prompt, width: 1024, height: 1024 });
    photoDataUri = posterTemplateEngine.bufferToDataUri(buffer, mimetype);
  }

  const logo = loadAttachmentBuffer(findRecentAttachment(messages, 'logo'));
  const logoDataUri = logo ? posterTemplateEngine.bufferToDataUri(logo.buffer, logo.mimetype) : null;

  const finalBuffer = await posterTemplateEngine.renderPoster({
    template,
    businessName: payload.businessName,
    tagline: payload.tagline,
    summary: payload.summary,
    bulletPoints: payload.bulletPoints,
    priceText: payload.priceText,
    badgeText: payload.badgeText,
    contactText: payload.contactText,
    colorTheme: payload.colorTheme,
    logoDataUri,
    photoDataUri,
  });

  const id = imageLinkStore.register(finalBuffer, 'image/png', { title: 'Affiche IA — CYRUS SUPER ASSISTANT' });
  return { text: '✅ Affiche générée.', media: { kind: 'image', url: `${PUBLIC_BASE_URL}/v/${id}`, downloadUrl: `${PUBLIC_BASE_URL}/v/${id}/raw` } };
}

async function executeGenerateVideo(payload, messages) {
  const photo = loadAttachmentBuffer(findRecentAttachment(messages, 'photo'));
  let sourceImageUrl;
  if (photo) {
    const id = imageLinkStore.register(photo.buffer, photo.mimetype, { title: 'Photo produit (pièce jointe tchat)' });
    sourceImageUrl = `${PUBLIC_BASE_URL}/v/${id}/raw`;
  } else {
    const { buffer, mimetype } = await imageAiEngine.generateImage({
      prompt: `${String(payload.motionPromptEnglish || '').slice(0, 2000)}, ${IMAGE_QUALITY_SUFFIX_EN}`,
      width: 1024,
      height: 1024,
    });
    const id = imageLinkStore.register(buffer, mimetype, { title: 'Image source (auto) — CYRUS SUPER ASSISTANT' });
    sourceImageUrl = `${PUBLIC_BASE_URL}/v/${id}/raw`;
  }

  const job = await videoAiEngine.startVideoAiJob(sourceImageUrl, String(payload.motionPromptEnglish || '').slice(0, 500));
  const logo = findRecentAttachment(messages, 'logo');
  return {
    text: '🎬 Génération de la vidéo en cours (1 à 3 minutes)...',
    pendingJobToken: encodeVideoAiJobToken({ ...job, _logoAttachmentId: logo ? logo.id : null }),
  };
}

async function executeGenerateBook(payload) {
  const topics = (Array.isArray(payload.chapterTopics) ? payload.chapterTopics : []).slice(0, 5);
  if (topics.length === 0) throw new Error('Aucun sujet de chapitre à rédiger.');

  const chapters = [];
  for (const topic of topics) {
    const chapterPrompt = `Chapitre à rédiger intégralement pour le livre "${payload.title}" : "${topic}"`;
    // eslint-disable-next-line no-await-in-loop -- rédaction séquentielle
    // volontaire (voir en-tête de fichier ebooks/draft-chapter) : un seul
    // gros appel JSON multi-chapitres risquerait une troncature sur les
    // modèles gratuits à quota de sortie limité.
    const { text: content } = await llmFallbackEngine.generateAIResponse(chapterPrompt, [], null, 'longform');
    chapters.push({ title: String(topic).slice(0, 150), content: content.slice(0, 6000) });
  }

  const pdfBuffer = await ebookGenerator.generateEbookPdf({ title: String(payload.title || 'Livre généré par IA').slice(0, 150), chapters });
  const id = imageLinkStore.register(pdfBuffer, 'application/pdf', { title: payload.title || 'Livre IA' });
  return { text: '✅ Livre généré.', media: { kind: 'book', url: `${PUBLIC_BASE_URL}/v/${id}`, downloadUrl: `${PUBLIC_BASE_URL}/v/${id}/raw`, title: payload.title } };
}

// Compose la réponse de l'assistant. Un délai artificiel de 1.5 à 3
// secondes (voir sleep ci-dessus) simule le temps de réflexion "naturel"
// demandé par la feuille de route CYRUS SUPER ASSISTANT — le moteur répond
// instantanément, un temps de réponse à 0ms romprait l'illusion
// conversationnelle recherchée (voir aussi l'effet de dactylographie côté
// client, public/dashboard.html#studioStartTypewriter). N'ajoute ce délai
// QUE pour la conversation générale : les flux image/vidéo/livre ont déjà
// un temps de réponse réel (appels réseau), un délai artificiel de plus
// serait pénalisant sans aucun bénéfice.
app.post('/api/ai-studio/sessions/:id/messages', requireAccess, requireModule('studio_video'), upload.single('attachment'), async (req, res) => {
  const tenantId = resolveTenantId(req);
  const text = String((req.body || {}).text || '').trim();
  if (!text) {
    return res.status(400).json({ error: 'Message vide.' });
  }

  const existing = await aiStudioStore.getSession(tenantId, req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Discussion introuvable.' });
  }

  // Pièce jointe optionnelle (logo/photo produit/clip vidéo) : hébergée
  // immédiatement via imageLinkStore (même store que Image-to-Link) pour
  // être réutilisable plus tard par une action (voir findRecentAttachment
  // ci-dessus) sans garder de fichier en mémoire entre deux requêtes HTTP.
  // Rôle deviné depuis le texte du message ("logo" -> logo, sinon -> photo)
  // — heuristique simple, assumée comme telle.
  let attachment = null;
  if (req.file) {
    const role = /\blogo\b/i.test(text) ? 'logo' : 'photo';
    const id = imageLinkStore.register(req.file.buffer, req.file.mimetype, { title: `Pièce jointe tchat (${role})` });
    attachment = { id, mimetype: req.file.mimetype, role };
  }

  const isFirstMessage = !Array.isArray(existing.messages) || existing.messages.length === 0;
  const title = isFirstMessage ? copywriterEngine.generateSessionTitle(text) : null;
  const userMessage = { role: 'user', text, createdAt: new Date().toISOString(), attachment };

  // BUG CORRIGÉ (constaté en test réel : une conversation de planification
  // affiche/vidéo/livre "perdait le fil" dès la réponse aux questions de
  // clarification) : detectStudioIntent(text) n'analyse QUE le message
  // courant, jamais l'historique — une réponse du type "mon slogan est...,
  // mes atouts sont..." ne contient plus aucun mot-clé ("affiche", "vidéo"...)
  // et retombait donc à tort sur l'intention générique 'chat', abandonnant
  // en cours de route toute la planification déjà entamée (l'utilisateur
  // recevait alors un texte générique du LLM au lieu de la suite du brief).
  // Si le DERNIER message assistant était une question de planification
  // (isPlanningQuestion, voir plus bas), on reste sur CETTE intention tant
  // qu'un nouveau message ne relance pas explicitement une intention
  // différente detectée par mots-clés.
  const lastAssistantMessage = Array.isArray(existing.messages)
    ? [...existing.messages].reverse().find((m) => m.role === 'assistant')
    : null;
  const keywordIntent = detectStudioIntent(text);
  const intent = (keywordIntent === 'chat' && lastAssistantMessage && lastAssistantMessage.isPlanningQuestion && lastAssistantMessage.intent)
    ? lastAssistantMessage.intent
    : keywordIntent;
  let assistantMessage;

  try {
    if (intent === 'image' || intent === 'video' || intent === 'book') {
      const planner = intent === 'image' ? planImage : (intent === 'video' ? planVideo : planBook);
      const { raw, parsed } = await planner(text, existing.messages);

      if (parsed && parsed.ready) {
        const actionByIntent = {
          image: { label: '🎨 Générer l\'affiche HD', action: 'generate_image' },
          video: { label: '🎬 Lancer la vidéo avec ce script', action: 'generate_video' },
          book: { label: '📄 Exporter le guide PDF', action: 'generate_book' },
        };
        assistantMessage = {
          role: 'assistant',
          text: String(parsed.summary || raw).slice(0, 2000),
          createdAt: new Date().toISOString(),
          actions: [{ ...actionByIntent[intent], payload: parsed }],
        };
      } else {
        // Le LLM a posé des questions (brief incomplet) — réponse texte
        // simple, aucun bouton d'action. isPlanningQuestion (voir
        // studioBuildBubble côté frontend) : BUG CORRIGÉ — sans ce marqueur,
        // cette question de brief avait exactement la même forme qu'une
        // vraie réponse de chat, et le frontend lui collait à tort les
        // boutons "📌 Relance Manuelle"/"🚀 Campagne Auto" (prévus pour du
        // texte de vente fini, pas pour "Quel est le nom de votre
        // restaurant ?") — ce qui donnait l'impression que le Studio IA ne
        // générait jamais de vrai visuel.
        assistantMessage = { role: 'assistant', text: raw, createdAt: new Date().toISOString(), isPlanningQuestion: true, intent };
      }
    } else {
      // Réponse exclusivement via la cascade d'API IA (Groq -> Gemini ->
      // OpenRouter -> Hugging Face -> Pollinations, voir llmFallbackEngine.js)
      // — plus de réponse locale toute faite (composeReply) servie en repli
      // silencieux si la cascade échoue : un échec total remonte désormais à
      // l'appelant (voir le catch englobant plus bas, qui affiche déjà un
      // message d'erreur clair) plutôt que de faire croire à une vraie
      // réponse IA. generateSessionTitle (ci-dessus) reste local — c'est un
      // simple intitulé de discussion, pas une réponse fournie à l'utilisateur.
      const { text: replyText } = await llmFallbackEngine.generateAIResponse(text, existing.messages);

      // Rattrapage (voir looksLikeRawMarkupDump ci-dessus) : la demande a été
      // classée 'chat' par detectStudioIntent mais la réponse générique
      // ressemble à un gabarit HTML/CSS brut — c'est le signe que
      // l'utilisateur voulait en réalité un visuel. On rebascule sur le
      // pipeline structuré (planification + bouton d'action) plutôt que
      // d'exposer ce texte brut. Uniquement looksLikeRawMarkupDump ici, PAS
      // looksLikeRunawayTutorial (bug constaté en test réel) : ce dernier se
      // déclenche sur un texte long/multi-lignes/à puces — exactement le
      // format ATTENDU d'un script de closing/objection dans cette branche
      // générique (contrairement à la branche planification image/vidéo/
      // livre ci-dessus, où SEULES 2-3 questions courtes ou un JSON strict
      // sont valides) ; l'appliquer ici détournait à tort de vraies réponses
      // de copywriting légitimes vers la planification d'affiche.
      if (looksLikeRawMarkupDump(replyText)) {
        const { raw, parsed } = await planImage(text, existing.messages);
        if (parsed && parsed.ready) {
          assistantMessage = {
            role: 'assistant',
            text: String(parsed.summary || raw).slice(0, 2000),
            createdAt: new Date().toISOString(),
            actions: [{ label: '🎨 Générer l\'affiche HD', action: 'generate_image', payload: parsed }],
          };
        } else {
          // intent forcé à 'image' (pas la variable `intent` englobante, qui
          // vaut 'chat' ici) : c'est bien planImage() qui a été appelé
          // juste au-dessus, la reprise de conversation (voir plus haut)
          // doit donc continuer sur cette planification, pas sur 'chat'.
          assistantMessage = { role: 'assistant', text: raw, createdAt: new Date().toISOString(), isPlanningQuestion: true, intent: 'image' };
        }
      } else {
        await sleep(1500 + Math.floor(Math.random() * 1500));
        assistantMessage = { role: 'assistant', text: replyText, createdAt: new Date().toISOString() };
      }
    }
  } catch (err) {
    // Filet de sécurité : un échec de planification (image/vidéo/livre)
    // retombe sur une réponse texte simple plutôt que de casser la
    // conversation — jamais d'erreur HTTP visible pour un simple message.
    console.warn(`Chat-First — échec du traitement d'intention "${intent}" :`, err.message);
    assistantMessage = { role: 'assistant', text: `Désolé, je n'ai pas pu traiter cette demande (${err.message}). Reformulez ou réessayez.`, createdAt: new Date().toISOString() };
  }

  const updated = await aiStudioStore.appendMessages(tenantId, req.params.id, [userMessage, assistantMessage], title);
  res.json({ session: updated });
});

// Exécute une action proposée par l'assistant (clic sur un bouton — voir
// ci-dessus) : déclenche le rendu réel (coûteux/payant pour l'image/vidéo),
// jamais fait automatiquement dès que le brief est prêt.
app.post('/api/ai-studio/sessions/:id/actions', requireAccess, requireModule('studio_video'), async (req, res) => {
  const tenantId = resolveTenantId(req);
  const { action, payload } = req.body || {};
  if (!action || !payload) {
    return res.status(400).json({ error: 'Action ou paramètres manquants.' });
  }

  const existing = await aiStudioStore.getSession(tenantId, req.params.id);
  if (!existing) {
    return res.status(404).json({ error: 'Discussion introuvable.' });
  }

  try {
    let result;
    if (action === 'generate_image') result = await executeGenerateImage(payload, existing.messages);
    else if (action === 'generate_video') result = await executeGenerateVideo(payload, existing.messages);
    else if (action === 'generate_book') result = await executeGenerateBook(payload);
    else return res.status(400).json({ error: `Action inconnue : ${action}` });

    const assistantMessage = { role: 'assistant', createdAt: new Date().toISOString(), ...result };
    const updated = await aiStudioStore.appendMessages(tenantId, req.params.id, [assistantMessage], null);
    res.json({ session: updated });
  } catch (err) {
    console.error(`Chat-First — échec de l'action "${action}" :`, err.message);
    res.status(502).json({ error: err.message || "Échec de l'exécution de l'action." });
  }
});

// Poll d'un job vidéo démarré par executeGenerateVideo ci-dessus (même
// principe que GET /api/studio/video-ai/status, mais ajoute le résultat
// comme nouveau message de la discussion une fois prêt, avec incrustation
// du logo en attente si un a été importé — voir _logoAttachmentId encodé
// dans le jobToken).
app.post('/api/ai-studio/sessions/:id/video-status', requireAccess, requireModule('studio_video'), async (req, res) => {
  const tenantId = resolveTenantId(req);
  let job;
  try {
    job = decodeVideoAiJobToken((req.body || {}).jobToken);
  } catch (err) {
    return res.status(400).json({ status: 'error', message: 'jobToken invalide.' });
  }

  try {
    const result = await videoAiEngine.pollVideoAiJob(job);
    if (!result.done) {
      return res.json({ status: 'pending' });
    }

    let buffer;
    let mimetype;
    if (result.videoUrl) {
      const videoRes = await axios.get(result.videoUrl, { responseType: 'arraybuffer', timeout: 60_000 });
      buffer = Buffer.from(videoRes.data);
      mimetype = videoRes.headers['content-type'] || 'video/mp4';
    } else {
      buffer = result.videoBuffer;
      mimetype = result.videoMimetype || 'video/mp4';
    }

    if (job._logoAttachmentId) {
      const logoEntry = imageLinkStore.get(job._logoAttachmentId);
      if (logoEntry) {
        try {
          buffer = await videoMixerEngine.overlayLogoOnVideo(buffer, logoEntry.buffer);
          mimetype = 'video/mp4';
        } catch (err) {
          console.warn('Incrustation du logo sur la vidéo IA échouée, vidéo renvoyée sans logo :', err.message);
        }
      }
    }

    const id = imageLinkStore.register(buffer, mimetype, { title: 'Vidéo IA — CYRUS SUPER ASSISTANT' });
    const assistantMessage = {
      role: 'assistant',
      text: '✅ Vidéo générée.',
      createdAt: new Date().toISOString(),
      media: { kind: 'video', url: `${PUBLIC_BASE_URL}/v/${id}`, downloadUrl: `${PUBLIC_BASE_URL}/v/${id}/raw` },
    };
    const updated = await aiStudioStore.appendMessages(tenantId, req.params.id, [assistantMessage], null);
    res.json({ status: 'done', session: updated });
  } catch (err) {
    console.error('Chat-First — échec du suivi vidéo :', err.message);
    res.json({ status: 'error', message: err.message || 'Échec de la génération vidéo.' });
  }
});

// ---------- Creative Director IA (Studio Média) ----------
// Directive créative structurée pour PRÉ-REMPLIR les champs existants du
// Studio Média (public/dashboard.html#studio-media-view) — secteur,
// accroche/titre, script vidéo, formats suggérés — et enrichir le prompt
// image envoyé à mediaBuildEnrichedPrompt côté client. N'appelle QUE la
// cascade LLM (lib/ai/llmFallbackEngine.js) ; en cas d'échec total, renvoie
// une erreur 503 explicite et le client continue avec les champs manuels
// existants (aucune régression du pipeline 100% local déjà en place).
const MEDIA_CREATIVE_SECTORS = ['restauration', 'immobilier', 'ecommerce', 'hightech', 'formation'];
const MEDIA_CREATIVE_FORMATS = ['9:16', '1:1', '16:9', '4:5'];

function parseCreativeDirective(rawText) {
  const parsed = extractJsonBlock(rawText);
  if (!parsed) return null;
  return {
    detectedSector: MEDIA_CREATIVE_SECTORS.includes(parsed.detectedSector) ? parsed.detectedSector : '',
    marketingHook: typeof parsed.marketingHook === 'string' ? parsed.marketingHook.trim().slice(0, 120) : '',
    imagePromptEnglish: typeof parsed.imagePromptEnglish === 'string' ? parsed.imagePromptEnglish.trim().slice(0, 800) : '',
    videoScript: typeof parsed.videoScript === 'string' ? parsed.videoScript.trim().slice(0, 600) : '',
    suggestedFormats: Array.isArray(parsed.suggestedFormats)
      ? parsed.suggestedFormats.filter((f) => MEDIA_CREATIVE_FORMATS.includes(f))
      : [],
  };
}

app.post('/api/media/creative-direction', requireAccess, requireModule('studio_video'), async (req, res) => {
  const concept = String((req.body || {}).concept || '').trim();
  if (!concept) {
    return res.status(400).json({ error: 'Décrivez le visuel avant de demander une direction créative IA.' });
  }

  // Instruction stricte "JSON seul" : les niveaux de la cascade
  // (lib/ai/llmFallbackEngine.js) sont des modèles de complétion généraux,
  // pas une API structurée — parseCreativeDirective() ci-dessus reste
  // tolérant (extrait le premier bloc {...}, ignore les champs invalides)
  // plutôt que d'exiger un JSON parfait du premier coup. Le rôle de
  // directeur artistique est désormais fourni par designDirectorSkill (voir
  // lib/ai/skills/), injecté dans le system prompt plutôt que répété ici.
  const instructionPrompt = [
    'Réponds UNIQUEMENT avec un objet JSON valide (aucun texte avant/après, aucun markdown), exactement dans ce format :',
    `{"detectedSector":"une valeur parmi ${MEDIA_CREATIVE_SECTORS.join('|')}","marketingHook":"accroche courte et percutante en français pour une affiche","imagePromptEnglish":"prompt visuel photoréaliste ultra-détaillé en anglais avec éclairage et détails HD, pour un générateur d'image IA","videoScript":"script court en français pour une voix off vidéo (2 à 3 phrases)","suggestedFormats":["deux valeurs parmi ${MEDIA_CREATIVE_FORMATS.join(', ')}"]}`,
    `Demande du client : "${concept}"`,
  ].join('\n');

  try {
    const { text: llmText, provider } = await llmFallbackEngine.generateAIResponse(instructionPrompt, [], null, undefined, 'designDirectorSkill');
    const directive = parseCreativeDirective(llmText);
    if (!directive) {
      throw new Error('Aucun JSON de directive créative exploitable dans la réponse du LLM.');
    }
    res.json({ directive, provider });
  } catch (err) {
    console.warn('Creative Director IA — cascade LLM indisponible :', err.message);
    res.status(503).json({ error: 'Direction créative IA indisponible pour le moment — renseignez les champs manuellement.' });
  }
});

// Extrait un premier bloc JSON {...} tolérant d'une réponse de complétion
// libre (même principe que parseCreativeDirective ci-dessus) — utilisé par
// les routes JSON de skills ci-dessous plutôt que d'exiger un JSON parfait
// du premier coup de la part d'un modèle de complétion généraliste.
function extractJsonBlock(rawText) {
  const match = String(rawText || '').match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (err) {
    return null;
  }
}

// ---------- Skills Expertes du Studio (voir lib/ai/skills/) ----------
// Chacune des 4 routes ci-dessous SAIT déjà dans quel module du Studio elle
// se trouve (voir la feuille de route "correspondance module -> skill") et
// passe donc la ou les clés de skill EXPLICITEMENT à generateAIResponse —
// jamais une détection heuristique comme pour le chat libre (voir
// lib/ai/marketingSkills.js, toujours utilisé pour le Copywriter Studio IA).

// Rendu Vidéo Séquentiel -> videoCinematographerSkill : transforme une idée
// de scène en prompt de mouvement structuré (caméra, physique, éclairage)
// avant transmission au moteur vidéo IA (voir lib/media/videoAiEngine.js /
// storyboardEngine.js) — remplace un prompt saisi tel quel par l'utilisateur
// quand celui-ci veut un résultat plus cinématographique.
app.post('/api/studio/video-prompt', requireAccess, requireModule('studio_video'), async (req, res) => {
  const concept = String((req.body || {}).concept || '').trim().slice(0, 500);
  if (!concept) {
    return res.status(400).json({ error: 'Décrivez la scène avant de générer un prompt de mouvement.' });
  }
  try {
    const { text, provider } = await llmFallbackEngine.generateAIResponse(
      `Scène à transformer en prompt de mouvement pour un moteur vidéo IA : "${concept}"`,
      [], null, undefined, 'videoCinematographerSkill',
    );
    res.json({ prompt: text, provider });
  } catch (err) {
    console.warn('Réalisateur IA (video-prompt) — cascade LLM indisponible :', err.message);
    res.status(503).json({ error: 'Amélioration de prompt indisponible pour le moment — utilisez votre texte tel quel.' });
  }
});

// Module UGC Produit -> ugcCreatorSkill + conversionContactSkill combinées :
// script UGC spontané qui se termine par un élément de contact direct
// (WhatsApp/téléphone/prix) — voir lib/ai/skills/index.js#buildSkillPromptBlock
// pour la combinaison de plusieurs skills en un seul appel.
app.post('/api/studio/ugc-script', requireAccess, requireModule('studio_video'), async (req, res) => {
  const product = String((req.body || {}).product || '').trim().slice(0, 500);
  if (!product) {
    return res.status(400).json({ error: 'Décrivez le produit avant de générer un script UGC.' });
  }
  const contact = String((req.body || {}).contact || '').trim().slice(0, 60);
  const price = String((req.body || {}).price || '').trim().slice(0, 60);
  const contactLine = [
    contact ? `Contact à utiliser : ${contact}` : null,
    price ? `Prix/offre à mentionner : ${price}` : null,
  ].filter(Boolean).join('\n');

  try {
    const { text, provider } = await llmFallbackEngine.generateAIResponse(
      [`Produit/service à mettre en avant : "${product}"`, contactLine].filter(Boolean).join('\n'),
      [], null, undefined, ['ugcCreatorSkill', 'conversionContactSkill'],
    );
    res.json({ script: text, provider });
  } catch (err) {
    console.warn('UGC Creator IA (ugc-script) — cascade LLM indisponible :', err.message);
    res.status(503).json({ error: 'Génération de script UGC indisponible pour le moment — rédigez-le manuellement.' });
  }
});

// Montage & Assemblage Mobile -> mobileFormatExpertSkill : suggère les
// bannières texte (titre/prix/contact) et les incrustations mot-à-mot pour
// le Montage TikTok/Reels (voir lib/media/videoMixerEngine.js et le
// formulaire "Import vidéo perso" du dashboard).
app.post('/api/studio/mobile-captions', requireAccess, requireModule('studio_video'), async (req, res) => {
  const product = String((req.body || {}).product || '').trim().slice(0, 500);
  if (!product) {
    return res.status(400).json({ error: "Décrivez le produit/contenu avant de générer des suggestions d'habillage." });
  }
  try {
    const { text, provider } = await llmFallbackEngine.generateAIResponse(
      `Contenu à habiller pour une vidéo verticale TikTok/Reels : "${product}"`,
      [], null, undefined, 'mobileFormatExpertSkill',
    );
    const parsed = extractJsonBlock(text);
    if (!parsed) throw new Error("Réponse inexploitable (JSON attendu pour l'habillage mobile).");
    res.json({
      titleText: typeof parsed.titleText === 'string' ? parsed.titleText.slice(0, 100) : '',
      priceText: typeof parsed.priceText === 'string' ? parsed.priceText.slice(0, 60) : '',
      contactText: typeof parsed.contactText === 'string' ? parsed.contactText.slice(0, 60) : '',
      captionWords: Array.isArray(parsed.captionWords) ? parsed.captionWords.slice(0, 40).map((w) => String(w).slice(0, 40)) : [],
      provider,
    });
  } catch (err) {
    console.warn('Monteur Mobile IA (mobile-captions) — cascade LLM indisponible :', err.message);
    res.status(503).json({ error: "Suggestions d'habillage indisponibles pour le moment — renseignez les champs manuellement." });
  }
});

// Faceless Shorts Automatisés -> facelessAutomationSkill : découpe un sujet
// en script segmenté + mot-clé de recherche B-Roll par segment. NE
// télécharge ni n'assemble aucune vidéo (voir lib/ai/skills/
// facelessAutomationSkill.js) — renvoie un plan textuel exploitable
// manuellement (recherche sur Pexels/Pixabay) ou par une intégration future.
app.post('/api/studio/faceless/plan', requireAccess, requireModule('studio_video'), async (req, res) => {
  const topic = String((req.body || {}).topic || '').trim().slice(0, 500);
  if (!topic) {
    return res.status(400).json({ error: 'Décrivez le sujet avant de générer un plan de vidéo faceless.' });
  }
  try {
    const { text, provider } = await llmFallbackEngine.generateAIResponse(
      `Sujet à découper en script + mots-clés B-Roll : "${topic}"`,
      [], null, undefined, 'facelessAutomationSkill',
    );
    const parsed = extractJsonBlock(text);
    const segments = parsed && Array.isArray(parsed.segments)
      ? parsed.segments
        .map((s) => ({ text: String((s || {}).text || '').slice(0, 300), brollKeyword: String((s || {}).brollKeyword || '').slice(0, 80) }))
        .filter((s) => s.text)
        .slice(0, 12)
      : [];
    if (segments.length === 0) throw new Error('Réponse inexploitable (aucun segment JSON valide).');
    res.json({ segments, provider });
  } catch (err) {
    console.warn('Faceless Automation IA (faceless/plan) — cascade LLM indisponible :', err.message);
    res.status(503).json({ error: 'Génération du plan faceless indisponible pour le moment.' });
  }
});

// Rédaction assistée d'UN chapitre via la cascade LLM (lib/ai/
// llmFallbackEngine.js), en mode "longform" (voir generateAIResponse) :
// contrairement au Copywriter Studio IA (chat, volontairement concis), un
// chapitre de livre doit être riche et détaillé — jamais quelques phrases.
// Ne modifie rien côté serveur (ebookGenerator.js reste un pur moteur de
// mise en page) : le texte généré est renvoyé au client, qui l'insère dans
// le champ "Contenu" du chapitre concerné, modifiable ensuite normalement.
app.post('/api/ebooks/draft-chapter', requireAccess, requireModule('studio_video'), async (req, res) => {
  const bookTitle = String((req.body || {}).bookTitle || '').trim();
  const chapterTitle = String((req.body || {}).chapterTitle || '').trim();
  const brief = String((req.body || {}).brief || '').trim().slice(0, 800);
  if (!chapterTitle) {
    return res.status(400).json({ error: 'Renseignez le titre du chapitre avant de générer son contenu.' });
  }

  const prompt = [
    bookTitle ? `Livre : "${bookTitle}".` : null,
    `Rédige intégralement le chapitre suivant : "${chapterTitle}".`,
    brief ? `Éléments à couvrir / angle souhaité : ${brief}` : null,
  ].filter(Boolean).join('\n');

  try {
    const { text } = await llmFallbackEngine.generateAIResponse(prompt, [], null, 'longform');
    res.json({ content: text });
  } catch (err) {
    console.warn('Rédaction IA de chapitre — cascade LLM indisponible :', err.message);
    res.status(503).json({ error: 'Rédaction IA indisponible pour le moment — rédigez ce chapitre manuellement.' });
  }
});

// ---------- Générateur de livres/ebooks PDF (moteur local, voir lib/pdf/ebookGenerator.js) ----------
// upload.any() plutôt que upload.fields([...]) : le nombre de chapitres (et
// donc de champs fichier "chapterImage_<index>") est dynamique, décidé côté
// client — voir public/dashboard.html, section Générateur de Livres.
app.post('/api/ebooks/generate', requireAccess, requireModule('studio_video'), upload.any(), async (req, res) => {
  let parsedSpec;
  try {
    parsedSpec = JSON.parse((req.body || {}).spec || '{}');
  } catch (err) {
    return res.status(400).json({ error: 'Paramètres du livre invalides.' });
  }

  const chapters = Array.isArray(parsedSpec.chapters) ? parsedSpec.chapters : [];
  if (chapters.length === 0) {
    return res.status(400).json({ error: 'Ajoutez au moins un chapitre.' });
  }

  const filesByField = {};
  (req.files || []).forEach((f) => { filesByField[f.fieldname] = f; });

  const spec = {
    title: String(parsedSpec.title || '').trim() || 'Sans titre',
    subtitle: String(parsedSpec.subtitle || '').trim(),
    author: String(parsedSpec.author || '').trim(),
    date: String(parsedSpec.date || '').trim(),
    watermarkText: String(parsedSpec.watermarkText || '').trim(),
    introduction: String(parsedSpec.introduction || '').trim(),
    conclusion: String(parsedSpec.conclusion || '').trim(),
    coverImageBuffer: filesByField.cover ? filesByField.cover.buffer : null,
    logoImageBuffer: filesByField.logo ? filesByField.logo.buffer : null,
    chapters: chapters.map((chapter, idx) => ({
      title: String(chapter.title || '').trim(),
      content: String(chapter.content || '').trim(),
      quote: chapter.quoteText
        ? { text: String(chapter.quoteText).trim(), author: String(chapter.quoteAuthor || '').trim() }
        : null,
      tip: chapter.tip ? String(chapter.tip).trim() : '',
      images: filesByField[`chapterImage_${idx}`] ? [filesByField[`chapterImage_${idx}`].buffer] : [],
    })),
  };

  try {
    const pdfBuffer = await ebookGenerator.generateEbookPdf(spec);
    const safeName = spec.title.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 60) || 'ebook';
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safeName}.pdf"`,
      'Content-Length': String(pdfBuffer.length),
    });
    res.send(pdfBuffer);
  } catch (err) {
    console.error('Génération ebook PDF échouée :', err);
    res.status(500).json({ error: 'Échec de la génération du PDF.' });
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
  .then(() => licenses.migrateStudioVideoModule())
  .catch((err) => {
    console.error('Erreur lors de la restauration/migration des licences :', err);
  })
  .finally(() => {
    app.listen(PORT, () => {
      console.log(`Server listening on port ${PORT}`);
      printAndWriteAdminAccessInstructions();
      // Balayage proactif d'inactivité (voir adapters/sessionRegulator.js) —
      // utile surtout sur un hébergement longue durée (VPS dédié) où la
      // pression de capacité seule (ensureCapacity) ne suffit pas à libérer
      // une session jamais sollicitée mais restée connectée indéfiniment.
      sessionRegulator.startIdleSweep();
    });
  });

// initAdminSession() : migre puis connecte le tenant admin (comportement
// historique préservé — seul tenant démarré automatiquement, sans attendre
// une première requête ; voir adapters/whatsappManager.js). Une fois cela
// lancé :
// - bootReconnectAllPairedTenants() reconnecte TOUTE clé de licence ayant
//   déjà une session WhatsApp appairée (avec ou sans campagne en cours) —
//   sans ça, une clé sans campagne active mais bien connectée avant le
//   redéploiement restait affichée "Déconnectée" jusqu'à ce que son
//   propriétaire recharge le dashboard, alors qu'admin et les campagnes en
//   cours redémarraient déjà à chaud (confusion observée en production le
//   2026-09-07, corrigée à la demande explicite de l'utilisateur).
// - bootResumePendingCampaigns() reprend, pour chaque clé de licence dont
//   l'état persisté indique une campagne encore en cours au moment de
//   l'arrêt précédent du process, l'envoi en arrière-plan exactement là où
//   il s'était arrêté (ensureConnected y est de toute façon idempotente :
//   pas de double connexion pour un tenant déjà couvert ci-dessus).
whatsappManager
  .initAdminSession()
  .catch((err) => {
    console.error('Erreur lors de l\'initialisation de la session WhatsApp admin:', err);
  })
  .finally(() => {
    whatsappManager.bootReconnectAllPairedTenants().catch((err) => {
      console.error('Erreur lors de la reconnexion automatique des sessions WhatsApp appairées :', err);
    });
    whatsappManager.bootResumePendingCampaigns().catch((err) => {
      console.error('Erreur lors de la reprise des campagnes WhatsApp interrompues :', err);
    });
  });

// Même principe que whatsappManager ci-dessus, désormais côté Telegram (voir
// adapters/telegramManager.js) : le tenant admin se connecte automatiquement
// au démarrage, puis chaque campagne Telegram encore en cours au moment de
// l'arrêt précédent du process reprend automatiquement là où elle s'était
// arrêtée.
telegramManager
  .initAdminSession()
  .catch((err) => {
    console.error('Erreur lors de l\'initialisation de la session Telegram admin:', err);
  })
  .finally(() => {
    telegramManager.bootResumePendingCampaigns().catch((err) => {
      console.error('Erreur lors de la reprise des campagnes Telegram interrompues :', err);
    });
  });

// Arrêt propre du process (SIGTERM envoyé par Render avant de remplacer le
// conteneur lors d'un redéploiement, SIGINT en local) : met en PAUSE (jamais
// n'annule) toute campagne WhatsApp/Telegram active avant de laisser le
// process se terminer — voir CampaignEngine#pauseForShutdown et son
// équivalent Telegram. Sans ce gestionnaire, une campagne en cours d'envoi
// resterait persistée au statut "running" jusqu'au prochain redémarrage
// (déjà géré correctement par resumeIfPending, mais sans le signal explicite
// "mise en pause propre, en attente d'une reprise volontaire" que ce
// gestionnaire ajoute).
let shuttingDown = false;

function pauseAllActiveCampaignsForShutdown() {
  for (const entry of whatsappManager.listActiveEntries()) {
    try {
      entry.campaignEngine.pauseForShutdown();
    } catch (err) {
      console.error(`Erreur lors de la mise en pause de la campagne WhatsApp (tenant "${entry.session.tenantId}") à l'arrêt :`, err.message);
    }
  }
  for (const entry of telegramManager.listActiveEntries()) {
    try {
      entry.campaignEngine.pauseForShutdown();
    } catch (err) {
      console.error(`Erreur lors de la mise en pause de la campagne Telegram (tenant "${entry.session.tenantId}") à l'arrêt :`, err.message);
    }
  }
}

function handleShutdownSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Signal ${signal} reçu : mise en pause des campagnes actives avant l'arrêt...`);
  pauseAllActiveCampaignsForShutdown();
  // Brève fenêtre avant de quitter pour de laisser une chance aux sauvegardes
  // GitHub déclenchées par pauseForShutdown() (fire-and-forget, voir
  // _persist()) de partir — la seule façon de retrouver cette campagne au
  // démarrage du PROCHAIN conteneur si le redéploiement vide le disque local.
  setTimeout(() => process.exit(0), 3000);
}

process.on('SIGTERM', () => handleShutdownSignal('SIGTERM'));
process.on('SIGINT', () => handleShutdownSignal('SIGINT'));

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
