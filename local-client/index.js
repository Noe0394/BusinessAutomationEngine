require('dotenv').config();

const path = require('path');
const express = require('express');
const open = require('open');

const { verifyLicense } = require('./lib/license');
process.on('cyrus-license-revoked', (reason) => {
  console.error(`Licence révoquée lors du contrôle en ligne (${reason || 'REFUSED'}). Arrêt du client.`);
  process.exit(1);
});
const { checkAndSelfUpdate } = require('./lib/selfUpdate');
const axios = require('axios');
const whatsapp = require('./lib/whatsapp');
const telegram = require('./lib/telegram');
const aiGateway = require('./lib/aiGateway');
const db = require('./lib/db');
const campaigns = require('./lib/campaigns');
const ebookGenerator = require('./lib/pdf/ebookGenerator');
const { DATA_DIR } = require('./lib/paths');
const taskParser = require('./lib/intelligence/task-parser');
const humanContext = require('./lib/intelligence/human-context-engine');
const goalChat = require('./lib/intelligence/goal-chat');

// Chat-Driven Agent Orchestrator (portage local-client, voir docs/PARITE-LOCAL.md
// et ai-engine/ à la racine du dépôt pour la version VPS de référence) —
// mêmes modules, adaptés à un PC mono-poste (pas de multi-tenant, pas
// d'automation-engine différé, voir les commentaires d'en-tête de chaque
// fichier local-client/ai-engine/*.js).
const { createLocalRuntime } = require('./lib/intelligence/runtimes/local-runtime');
const llmFallbackEngine = require('./lib/ai/llmFallbackEngine');
const chatOrchestrator = require('./ai-engine/chatOrchestrator');
const authz = require('./ai-engine/authz');
// chatOrchestrator.handle() exige désormais un principal authentifié (voir ai-engine/authz.js, resynchronisé le
// 2026-09-23 — même exigence côté VPS). En mode local mono-compte, l'accès au tableau de bord EST déjà l'authentification
// (pas de compte distant à usurper) : un principal OWNER fixe est émis une seule fois au démarrage, comme le fait déjà
// ai-engine/ownerChannel.js pour le self-chat WhatsApp/Telegram (voir sa propre émission de principal, même tenant 'local').
const LOCAL_OWNER_PRINCIPAL = authz.issuePrincipal({ tenant: 'local', role: authz.ROLES.OWNER, userId: 'local', channel: 'WEB', via: 'local_dashboard' });
const platformOrchestrator = require('./ai-engine/platformOrchestrator');
const messageTriage = require('./lib/intelligence/message-triage');
const businessProfileStore = require('./ai-engine/storageAdapter');
const emotionalCloser = require('./ai-engine/emotionalCloser');
const voiceProcessor = require('./ai-engine/voiceProcessor');
// Couche d'assistance générale (self-chat propriétaire, routage privé/métier, campagnes d'entrée) + répondeur
// automatique Jarvis — débloqués le 2026-09-23 (voir docs/PORTAGE-LOCAL-MOBILE.md). Jusqu'ici branchés nulle part
// dans ce fichier : les messages entrants ne passaient que par l'ancien repli (messageTriage + emotionalCloser).
const assistantLayer = require('./ai-engine/assistantLayer');
const autoResponder = require('./ai-engine/autoResponder');
const AUTO_CLOSE_PROSPECTS = process.env.AUTO_CLOSE_PROSPECTS === 'true';
const AUTO_ENGAGE_NEW_CONTACTS = process.env.AUTO_ENGAGE_NEW_CONTACTS === 'true';
const AUTO_PAYMENT_VALIDATION = process.env.AUTO_PAYMENT_VALIDATION === 'true';
const contactCrm = require('./ai-engine/contactCrm');
const conversationHistory = require('./ai-engine/messageHistory');
const manualPaymentValidator = require('./ai-engine/manualPaymentValidator');
const recurringTasks = require('./queues/recurringTasks');
const businessServices = require('./ai-engine/businessServices');
const communityService = require('./ai-engine/communityService');
const communityDiscovery = require('./ai-engine/communityDiscovery');

const localRuntime = createLocalRuntime({
  whatsapp, telegram, campaigns,
  llm: (prompt, history, context) => llmFallbackEngine.generateAIResponse(prompt, history, context).then((r) => r.text),
});

const PORT = process.env.LOCAL_PORT || 4100;

async function main() {
  // Tout en premier, avant même la licence : si une mise à jour est
  // appliquée, cette fonction ne rend JAMAIS la main (process.exit — un
  // script jetable relance une instance à jour, qui retraverse ce même
  // point). Voir lib/selfUpdate.js pour le détail (un seul exécutable
  // distribué, aucun second programme à installer).
  await checkAndSelfUpdate();

  console.log(`Données locales : ${DATA_DIR}`);
  console.log('Vérification locale de la licence ou renouvellement sécurisé en ligne...');

  const license = await verifyLicense();
  if (!license.valid) {
    console.error(`\nLICENCE INVALIDE : ${license.error}`);
    console.error('Accès bloqué — contactez votre administrateur pour une clé valide.\n');
    process.exit(1);
  }
  console.log(`Licence valide${license.offline ? ' (validation hors-ligne)' : ''} (expire le ${license.expiresAt || 'jamais'}).`);

  const app = express();
  app.use(express.json({ limit: '15mb' }));
  app.use(express.static(path.join(__dirname, 'public')));

  // Facebook Messenger / Pages : adaptateur Meta officiel local. La clef
  // App Secret reste dans DATA_DIR ou l'environnement, jamais dans le DOM.
  const FacebookMessengerAdapter = require('./lib/facebook');
  const facebook = new FacebookMessengerAdapter();
  const crypto = require('crypto');
  const facebookOAuthStates = new Map();
  const facebookQueueControllers = new Map();
  let facebookCaptureTimer = null;
  let facebookCaptureRunning = false;
  db.interruptRunningFacebookQueueJobs();
  db.recoverFacebookCaptureReplies();
  const facebookRedirectUri = process.env.LOCAL_FB_REDIRECT_URI || `http://localhost:${PORT}/api/facebook/callback`;
  app.get('/api/facebook/status', async (_req, res) => {
    try { res.json({ configured: facebook.isConfigured(), connectAvailable: facebook.isConnectAvailable(), redirectUri: facebookRedirectUri, ...(await facebook.checkConnection()) }); }
    catch (err) { res.status(502).json({ error: err.message }); }
  });
  app.post('/api/facebook/oauth-config', (req, res) => {
    const appId = String(req.body?.appId || '').trim();
    const appSecret = String(req.body?.appSecret || '').trim();
    if (!appId || !appSecret) return res.status(400).json({ error: 'App ID et App Secret sont requis.' });
    try {
      const result = require('./lib/oauthConfig').set('facebook', { appId, appSecret });
      res.json({ ok: true, ...result, redirectUri: facebookRedirectUri });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/facebook/connect', (req, res) => {
    if (!facebook.isConnectAvailable()) return res.status(400).send('Configurez FB_APP_ID/FB_APP_SECRET dans les réglages locaux avant de connecter Facebook.');
    const state = crypto.randomBytes(24).toString('hex');
    for (const [key, expiry] of facebookOAuthStates) if (expiry < Date.now()) facebookOAuthStates.delete(key);
    facebookOAuthStates.set(state, Date.now() + 10 * 60 * 1000);
    res.redirect(facebook.getAuthUrl(facebookRedirectUri, state));
  });
  app.get('/api/facebook/callback', async (req, res) => {
    const state = String(req.query.state || '');
    const expiresAt = facebookOAuthStates.get(state);
    facebookOAuthStates.delete(state);
    if (!expiresAt || expiresAt < Date.now() || !req.query.code) return res.redirect('/?fbConnect=failed');
    try { await facebook.handleOAuthCallback(String(req.query.code), facebookRedirectUri); res.redirect('/?fbConnect=success'); }
    catch (err) { console.error('Facebook OAuth local:', err.response?.data || err.message); res.redirect('/?fbConnect=failed'); }
  });
  app.post('/api/facebook/logout', (_req, res) => res.json(facebook.disconnect()));
  app.get('/api/facebook/conversations', async (_req, res) => {
    if (!facebook.isConfigured()) return res.status(409).json({ error: 'Connectez une Page Facebook.' });
    try { res.json({ conversations: await facebook.getConversations() }); }
    catch (err) { res.status(502).json({ error: err.response?.data?.error?.message || err.message }); }
  });
  app.post('/api/facebook/conversations/:id/message', async (req, res) => {
    const message = String(req.body?.message || '').trim();
    if (!facebook.isConfigured()) return res.status(409).json({ error: 'Connectez une Page Facebook.' });
    if (!message) return res.status(400).json({ error: 'Le message est requis.' });
    try { res.json(await facebook.sendMessage(String(req.params.id), message)); }
    catch (err) { res.status(502).json({ error: err.response?.data?.error?.message || err.message }); }
  });
  app.post('/api/facebook/contacts/resolve', async (req, res) => {
    if (!facebook.isConfigured()) return res.status(409).json({ error: 'Connectez une Page Facebook.' });
    const contacts = req.body?.contacts;
    if (!Array.isArray(contacts) || contacts.length === 0 || contacts.length > 2000) return res.status(400).json({ error: 'Importez entre 1 et 2000 contacts.' });
    try { res.json({ contacts: await facebook.resolveRecipientsFromConversations(contacts) }); }
    catch (err) { res.status(502).json({ error: err.response?.data?.error?.message || err.message }); }
  });
  app.post('/api/facebook/queue', async (req, res) => {
    if (!facebook.isConfigured()) return res.status(409).json({ error: 'Connectez une Page Facebook.' });
    const recipients = Array.isArray(req.body?.recipients) ? [...new Set(req.body.recipients.map(String).filter(Boolean))] : [];
    const message = String(req.body?.message || '').trim();
    const media = req.body?.media;
    if (!recipients.length || recipients.length > 500 || (!message && !media?.base64)) return res.status(400).json({ error: 'Sélectionnez 1 à 500 destinataires et saisissez un message ou joignez un média.' });
    if (media && (!media.base64 || media.base64.length > 15 * 1024 * 1024)) return res.status(413).json({ error: 'Fichier absent ou trop volumineux (maximum 10 Mo).' });
    if (media && !/^(image\/|video\/)/i.test(String(media.type || ''))) return res.status(400).json({ error: 'Seules les images et vidéos sont acceptées pour Messenger.' });
    const mediaBuffer = media ? Buffer.from(media.base64, 'base64') : null;
    if (mediaBuffer && mediaBuffer.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'La pièce jointe dépasse 10 Mo.' });
    let eligible;
    try { eligible = new Set((await facebook.getConversations()).map(item => String(item.recipientId)).filter(Boolean)); }
    catch (err) { return res.status(502).json({ error: err.response?.data?.error?.message || err.message }); }
    const rejectedCount = recipients.filter(recipient => !eligible.has(recipient)).length;
    if (rejectedCount) return res.status(400).json({ error: `${rejectedCount} destinataire(s) ne correspondent pas à une conversation Messenger existante de la Page; aucun envoi lancé.` });
    const id = crypto.randomUUID();
    const createdAt = new Date().toISOString();
    const job = { id, status: 'running', total: recipients.length, sent: 0, recipients, createdAt, updatedAt: createdAt, results: [] };
    db.saveFacebookQueueJob(job);
    db.pruneFacebookQueueJobs(30);
    const controller = { cancelled: false };
    facebookQueueControllers.set(id, controller);
    res.status(202).json({ id, status: job.status, total: job.total, minDelaySeconds: 10, maxDelaySeconds: 15 });
    facebook.sendBulk(recipients, message, {
      minDelaySeconds: 10,
      maxDelaySeconds: 15,
      batchSize: 25,
      shouldStop: () => controller.cancelled,
      onAttempt: (attempt) => {
        const prior = job.results.filter((item) => String(item.to) !== String(attempt.to));
        job.results = [...prior, { to: attempt.to, status: 'sending', timestamp: new Date().toISOString() }];
        job.sent = attempt.index;
        job.updatedAt = new Date().toISOString();
        db.saveFacebookQueueJob(job);
      },
      onProgress: (progress) => {
        job.sent = progress.sent;
        job.results = progress.results || job.results;
        job.updatedAt = new Date().toISOString();
        db.saveFacebookQueueJob(job);
      },
      media: mediaBuffer ? { buffer: mediaBuffer, mimetype: media.type, filename: media.name || 'media' } : null,
    }).then((results) => {
      job.results = results;
      job.sent = results.filter((item) => item.status !== 'not_sent').length;
      job.status = controller.cancelled ? 'cancelled' : 'completed';
      job.completedAt = new Date().toISOString(); job.updatedAt = job.completedAt;
      db.saveFacebookQueueJob(job);
    }).catch((err) => {
      job.status = 'failed'; job.error = err.response?.data?.error?.message || err.message;
      job.completedAt = new Date().toISOString(); job.updatedAt = job.completedAt;
      db.saveFacebookQueueJob(job);
    }).finally(() => facebookQueueControllers.delete(id));
  });
  app.get('/api/facebook/queue/:id', (req, res) => {
    const job = db.getFacebookQueueJob(String(req.params.id));
    if (!job) return res.status(404).json({ error: 'File Messenger introuvable.' });
    res.json(job);
  });
  app.get('/api/facebook/queue', (_req, res) => res.json({ jobs: db.listFacebookQueueJobs(30) }));
  app.post('/api/facebook/queue/:id/cancel', (req, res) => {
    const id = String(req.params.id);
    const job = db.getFacebookQueueJob(id);
    if (!job) return res.status(404).json({ error: 'File Messenger introuvable.' });
    const controller = facebookQueueControllers.get(id);
    if (job.status !== 'running' || !controller) return res.status(409).json({ error: 'Cette file ne peut plus être arrêtée.', job });
    controller.cancelled = true;
    res.json({ id, status: 'stopping', message: 'Arrêt demandé. Un envoi déjà accepté par Meta peut encore se terminer.' });
  });
  app.post('/api/facebook/publish', async (req, res) => {
    if (!facebook.isConfigured()) return res.status(409).json({ error: 'Connectez une Page Facebook.' });
    const message = String(req.body?.message || '').trim();
    const link = String(req.body?.link || '').trim();
    const media = req.body?.media;
    if (!message && !link && !media?.base64) return res.status(400).json({ error: 'Un texte, un lien ou un média est requis.' });
    if (media && (!media.base64 || media.base64.length > 15 * 1024 * 1024)) return res.status(413).json({ error: 'Fichier absent ou trop volumineux (maximum 10 Mo).' });
    if (media && !/^(image\/|video\/)/i.test(String(media.type || ''))) return res.status(400).json({ error: 'Facebook accepte ici uniquement une image ou une vidéo. Les PDF ne sont pas pris en charge.' });
    const mediaBuffer = media ? Buffer.from(media.base64, 'base64') : null;
    if (mediaBuffer && mediaBuffer.length > 10 * 1024 * 1024) return res.status(413).json({ error: 'La pièce jointe dépasse 10 Mo.' });
    const scheduledDate = req.body?.scheduledPublishTime ? new Date(req.body.scheduledPublishTime) : null;
    const scheduledUnix = scheduledDate ? Math.floor(scheduledDate.getTime() / 1000) : undefined;
    if (scheduledDate && (!Number.isFinite(scheduledUnix) || scheduledUnix < Math.floor(Date.now() / 1000) + 600 || scheduledUnix > Math.floor(Date.now() / 1000) + 75 * 86400)) {
      return res.status(400).json({ error: 'Meta exige une programmation entre 10 minutes et 75 jours.' });
    }
    try { res.json(await facebook.publishPost({ message, link, mediaBuffer, mediaMimetype: media?.type, mediaFilename: media?.name, scheduledPublishTime: scheduledDate?.toISOString() })); }
    catch (err) { res.status(502).json({ error: err.response?.data?.error?.message || err.message }); }
  });
  app.get('/api/facebook/posts', async (_req, res) => {
    if (!facebook.isConfigured()) return res.status(409).json({ error: 'Connectez une Page Facebook.' });
    try { res.json({ posts: await facebook.getPagePosts({ limit: 20 }) }); }
    catch (err) { res.status(502).json({ error: err.response?.data?.error?.message || err.message }); }
  });
  app.get('/api/facebook/groups', (_req, res) => res.json({ groups: facebook.getManagedGroups() }));
  app.put('/api/facebook/groups', (req, res) => {
    try { res.json({ groups: facebook.setManagedGroups(req.body?.groups) }); }
    catch (err) { res.status(400).json({ error: err.message }); }
  });
  app.post('/api/facebook/groups', (req, res) => {
    const id = String(req.body?.id || '').trim();
    const name = String(req.body?.name || '').trim();
    if (!id) return res.status(400).json({ error: 'L’identifiant du groupe est requis.' });
    try { res.json({ groups: facebook.addManagedGroup(id, name) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.delete('/api/facebook/groups/:id', (req, res) => {
    try { res.json({ groups: facebook.removeManagedGroup(String(req.params.id)) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/facebook/posts/:postId/comments', async (req, res) => {
    if (!facebook.isConfigured()) return res.status(409).json({ error: 'Connectez une Page Facebook.' });
    try { res.json({ comments: await facebook.getPostComments(String(req.params.postId)) }); }
    catch (err) { res.status(502).json({ error: err.response?.data?.error?.message || err.message }); }
  });
  app.post('/api/facebook/comments/:commentId/reply', async (req, res) => {
    const message = String(req.body?.message || '').trim();
    if (!message) return res.status(400).json({ error: 'La réponse est vide.' });
    try { res.json(await facebook.replyToComment(String(req.params.commentId), message)); }
    catch (err) { res.status(502).json({ error: err.response?.data?.error?.message || err.message }); }
  });
  app.post('/api/facebook/comments/:commentId/moderate', async (req, res) => {
    try { res.json(await facebook.moderateComment(String(req.params.commentId), { hide: req.body?.hide !== false })); }
    catch (err) { res.status(502).json({ error: err.response?.data?.error?.message || err.message }); }
  });
  app.delete('/api/facebook/comments/:commentId', async (req, res) => {
    try { res.json(await facebook.deleteComment(String(req.params.commentId))); }
    catch (err) { res.status(502).json({ error: err.response?.data?.error?.message || err.message }); }
  });

  async function scanFacebookComments() {
    if (facebookCaptureRunning) return { skipped: true, reason: 'scan_in_progress' };
    if (!facebook.isConfigured()) throw Object.assign(new Error('Connectez une Page Facebook.'), { status: 409 });
    facebookCaptureRunning = true;
    const settings = db.getFacebookCaptureSettings();
    const scanStartedAt = new Date();
    const since = settings.lastScanAt
      ? Math.floor(new Date(settings.lastScanAt).getTime() / 1000) - 120
      : Math.floor(scanStartedAt.getTime() / 1000) - 7 * 24 * 60 * 60;
    let captured = 0;
    let replied = 0;
    let incompleteScan = false;
    let stoppedByUser = false;
    try {
      const posts = await facebook.getPagePosts({ limit: 20 });
      for (const post of posts) {
        if (settings.enabled && !db.getFacebookCaptureSettings()?.enabled) { stoppedByUser = true; break; }
        let comments;
        try { comments = await facebook.getPostComments(post.id, { limit: 100, since }); }
        catch (error) {
          incompleteScan = true;
          console.warn(`Capture Facebook: commentaires indisponibles pour la publication ${post.id}:`, error.response?.data?.error?.message || error.message);
          continue;
        }
        for (const comment of comments) {
          if (settings.enabled && !db.getFacebookCaptureSettings()?.enabled) { stoppedByUser = true; break; }
          const psid = String(comment.from?.id || '').trim();
          const commentId = String(comment.id || '').trim();
          const text = String(comment.message || '').trim();
          if (!/^\d{1,80}$/.test(psid) || !commentId || commentId.length > 160 || !text || psid === String(facebook.pageId)) continue;
          if (db.hasFacebookComment(commentId)) continue;
          const rule = db.findFacebookKeywordRule(text);
          const lead = db.upsertFacebookLead({ psid, name: comment.from?.name, source: 'comment', sourceText: text, postId: post.id, keyword: rule?.keyword });
          if (!db.claimFacebookComment({ commentId, postId: post.id, psid, leadId: lead.id, commentText: text, keyword: rule?.keyword })) continue;
          captured += 1;
          if (!rule?.autoReply || !rule.replyMessage || !settings.enabled || !db.getFacebookCaptureSettings()?.enabled) continue;

          db.updateFacebookComment(commentId, 'reply_sending');
          db.setFacebookLeadReplyStatus(psid, 'sending');
          try {
            await facebook.sendPrivateReply(commentId, rule.replyMessage);
            db.updateFacebookComment(commentId, 'reply_sent');
            db.markFacebookLeadReplied(psid);
            replied += 1;
          } catch (error) {
            const message = error.response?.data?.error?.message || error.message || 'Erreur Meta';
            db.updateFacebookComment(commentId, 'reply_unknown', message);
            db.setFacebookLeadReplyStatus(psid, 'reply_unknown');
            console.warn(`Capture Facebook: reponse privee non confirmee pour ${commentId}; aucun nouvel essai automatique.`, message);
          }
        }
        if (stoppedByUser) break;
      }
      const warning = incompleteScan ? 'Certains commentaires Meta sont inaccessibles; la prochaine synchronisation reprendra depuis le dernier point complet.'
        : stoppedByUser ? 'Capture arrêtée; la prochaine synchronisation reprendra depuis le dernier point complet.' : null;
      const currentSettings = db.getFacebookCaptureSettings();
      db.saveFacebookCaptureSettings({ enabled: currentSettings?.enabled ?? settings.enabled, lastScanAt: incompleteScan || stoppedByUser ? null : scanStartedAt.toISOString(), lastError: warning });
      return { captured, replied, scannedAt: scanStartedAt.toISOString(), warning };
    } catch (error) {
      const currentSettings = db.getFacebookCaptureSettings();
      db.saveFacebookCaptureSettings({ enabled: currentSettings?.enabled ?? settings.enabled, lastError: error.response?.data?.error?.message || error.message });
      throw error;
    } finally { facebookCaptureRunning = false; }
  }

  function startFacebookCapture() {
    if (facebookCaptureTimer) return;
    scanFacebookComments().catch((error) => console.warn('Capture Facebook:', error.message));
    facebookCaptureTimer = setInterval(() => {
      scanFacebookComments().catch((error) => console.warn('Capture Facebook:', error.message));
    }, 5 * 60 * 1000);
    if (facebookCaptureTimer.unref) facebookCaptureTimer.unref();
  }

  app.get('/api/facebook/keyword-rules', (_req, res) => res.json({ rules: db.listFacebookKeywordRules() }));
  app.post('/api/facebook/keyword-rules', (req, res) => {
    const keyword = String(req.body?.keyword || '').trim();
    const replyMessage = String(req.body?.replyMessage || '').trim();
    const autoReply = req.body?.autoReply === true;
    if (keyword.length < 2 || keyword.length > 100) return res.status(400).json({ error: 'Le mot-clé doit contenir de 2 à 100 caractères.' });
    if (replyMessage.length > 2000) return res.status(400).json({ error: 'La réponse ne peut pas dépasser 2000 caractères.' });
    if (autoReply && !replyMessage) return res.status(400).json({ error: 'Ajoutez une réponse texte avant d’activer la réponse automatique.' });
    if (db.listFacebookKeywordRules().length >= 100) return res.status(409).json({ error: 'La limite locale est de 100 règles.' });
    try { res.status(201).json({ rule: db.createFacebookKeywordRule({ keyword, replyMessage, autoReply }) }); }
    catch (error) { res.status(500).json({ error: error.message }); }
  });
  app.delete('/api/facebook/keyword-rules/:id', (req, res) => res.json({ rules: db.removeFacebookKeywordRule(req.params.id) }));
  app.get('/api/facebook/prospects', (_req, res) => res.json({ contacts: db.listFacebookLeads() }));
  app.get('/api/facebook/prospects/capture', (_req, res) => res.json(db.getFacebookCaptureSettings()));
  app.post('/api/facebook/prospects/capture', (req, res) => {
    const enabled = req.body?.enabled === true;
    if (enabled && !facebook.isConfigured()) return res.status(409).json({ error: 'Connectez une Page Facebook avant de démarrer la capture.' });
    const settings = db.saveFacebookCaptureSettings({ enabled });
    if (enabled) startFacebookCapture();
    else if (facebookCaptureTimer) { clearInterval(facebookCaptureTimer); facebookCaptureTimer = null; }
    res.json(settings);
  });
  app.post('/api/facebook/prospects/sync', async (_req, res) => {
    try { res.json(await scanFacebookComments()); }
    catch (error) { res.status(error.status || 502).json({ error: error.response?.data?.error?.message || error.message }); }
  });

  // Gestionnaire de campagnes unifié porté du VPS; l'ancien moteur mono-PC
  // reste disponible sous /api/legacy-campaigns pour sa file et la relance.
  const campaignService = require('./ai-engine/campaignService');
  const chatUploadsStore = require('./ai-engine/chatUploads');
  const taskQueue = require('./ai-engine/taskQueue');
  const cmpRoute = (fn) => async (req, res) => {
    try { res.json(await fn(req, 'local')); }
    catch (err) { if (!err.http) console.error('campagnes locales :', err.message); res.status(err.http || 500).json({ error: err.message || 'Erreur interne.', code: err.code || 'INTERNAL' }); }
  };
  app.post('/api/campaigns/recipients', cmpRoute(async (req) => {
    const b = req.body || {};
    const inbound = (b.file && b.file.base64) || (b.image && b.image.base64) || '';
    if (inbound.length > 14 * 1024 * 1024) throw Object.assign(new Error('Fichier trop volumineux (maximum 10 Mo).'), { http: 413, code: 'FILE_TOO_LARGE' });
    const contacts = Array.isArray(b.contacts) ? b.contacts.map(x => ({ phone: x.telephone || x.phone || x.identifier || '', name: x.nom || x.name || '' })) : undefined;
    const file = b.file && b.file.base64 ? { buffer: Buffer.from(b.file.base64, 'base64'), name: b.file.name || 'contacts.csv', type: b.file.type || 'text/csv' } : null;
    const image = b.image && b.image.base64 ? Buffer.from(b.image.base64, 'base64') : null;
    return campaignService.prepareRecipients('local', { text: b.text, rows: contacts, file: file && !/^image\//i.test(file.type) ? file : null, image: image || (file && /^image\//i.test(file.type) ? file.buffer : null) }, { defaultCountryCode: b.defaultCountryCode });
  }));
  app.get('/api/campaigns/recipients/:id', cmpRoute((req) => campaignService.getRecipientsPage('local', req.params.id, req.query)));
  app.post('/api/campaigns/media', cmpRoute(async (req) => {
    const b = req.body || {}; if (!b.base64) throw Object.assign(new Error('Aucun fichier fourni.'), { http: 400, code: 'NO_FILE' });
    if (b.base64.length > 14 * 1024 * 1024) throw Object.assign(new Error('Média trop volumineux (maximum 10 Mo).'), { http: 413, code: 'FILE_TOO_LARGE' });
    return chatUploadsStore.save('local', { originalname: b.name, mimetype: b.type, buffer: Buffer.from(b.base64, 'base64') });
  }));
  app.post('/api/campaigns', cmpRoute((req) => campaignService.createCampaign('local', req.body || {}, null)));
  app.get('/api/campaigns', cmpRoute(async () => ({ campaigns: await campaignService.list('local', localRuntime) })));
  app.get('/api/campaigns/:id', cmpRoute((req) => campaignService.get('local', req.params.id, localRuntime, req.query)));
  app.post('/api/campaigns/:id/launch', cmpRoute((req) => campaignService.launch('local', req.params.id, localRuntime, null)));
  app.post('/api/campaigns/:id/schedule', cmpRoute((req) => campaignService.schedule('local', req.params.id, req.body && req.body.at)));
  app.post('/api/campaigns/:id/pause', cmpRoute((req) => campaignService.control('local', req.params.id, 'pause', localRuntime)));
  app.post('/api/campaigns/:id/resume', cmpRoute((req) => campaignService.control('local', req.params.id, 'resume', localRuntime)));
  app.post('/api/campaigns/:id/cancel', cmpRoute((req) => campaignService.control('local', req.params.id, 'cancel', localRuntime)));
  app.get('/api/campaigns/:id/report', cmpRoute((req) => campaignService.report('local', req.params.id, localRuntime)));
  taskQueue.startWorker(() => ({ LAUNCH_CAMPAIGN: async task => {
    try { return { ok: true, result: await campaignService.launch('local', task.payload.draftId, localRuntime, null) }; }
    catch (err) { return { ok: false, error: err.message, retryable: false }; }
  } }), 30000);

  const knowledgeBase = require('./ai-engine/knowledgeBase');
  const activityIntelligence = require('./ai-engine/activityIntelligence');
  const activityStore = require('./ai-engine/activityStore');
  const aiUsageLedger = require('./ai-engine/aiUsageLedger');
  app.get('/api/docs', (req, res) => {
    if (req.query.q) return res.json({ ok: true, results: knowledgeBase.search(req.query.q, 5) });
    res.json({ ok: true, doc: knowledgeBase.all() });
  });
  app.get('/api/docs/:id', (req, res) => {
    const article = knowledgeBase.get(req.params.id);
    if (!article) return res.status(404).json({ error: 'Article introuvable.' });
    res.json({ ok: true, article });
  });
  app.get('/api/ad-campaigns/new-contacts', async (_req, res) => {
    try { res.json({ ok: true, contacts: await require('./ai-engine/adCampaigns').listNewAdContacts('local') }); }
    catch (err) { console.error('Contacts publicitaires locaux :', err.message); res.status(500).json({ error: 'Registre indisponible.' }); }
  });
  app.get('/api/reports/ai-usage', async (_req, res) => res.json({ ok: true, usage: await aiUsageLedger.summary() }));
  app.get('/api/reports/activity', async (_req, res) => res.json({ ok: true, activity: await activityStore.summary(undefined, 100) }));
  app.get('/api/reports/intelligence', async (req, res) => {
    try { res.json({ ok: true, report: await activityIntelligence.buildReport('local', req.query) }); }
    catch (err) { console.error('Rapport local :', err.message); res.status(500).json({ error: 'Rapport indisponible.' }); }
  });
  app.get('/api/reports/improvements', async (_req, res) => {
    try { const d = await activityIntelligence.loadImprovements('local'); res.json({ ok: true, items: d.items.slice(0, 50) }); }
    catch (err) { res.status(500).json({ error: 'Indisponible.' }); }
  });
  app.post('/api/reports/improvements/refresh', async (_req, res) => {
    try { const r = await activityIntelligence.refresh('local'); res.json({ ok: true, created: r.created.length, open: r.open }); }
    catch (err) { console.error('Diagnostic local :', err.message); res.status(500).json({ error: 'Diagnostic indisponible.' }); }
  });
  app.post('/api/reports/improvements/:id/apply', async (req, res) => {
    try { const r = await activityIntelligence.apply('local', req.params.id, { approvedByOwner: req.body && req.body.approve === true, authorized: false }); res.status(r.ok ? 200 : 400).json(r); }
    catch (err) { res.status(500).json({ error: 'Application impossible.' }); }
  });
  app.post('/api/reports/improvements/:id/measure', async (req, res) => {
    try { const r = await activityIntelligence.measure('local', req.params.id); res.status(r.ok ? 200 : 404).json(r); }
    catch (err) { res.status(500).json({ error: 'Mesure impossible.' }); }
  });
  app.post('/api/reports/analysis', async (req, res) => {
    try { res.json(await activityIntelligence.analyzeWithAgents('local', req.body || {}, require('./ai-engine/authz').issuePrincipal({ tenant: 'local', role: 'OWNER', source: 'local-reports' }))); }
    catch (err) { console.error('Analyse locale :', err.message); res.status(500).json({ error: 'Analyse indisponible.' }); }
  });

  // ---------- Services Métiers (parité API avec le VPS, tenant local) ----------
  app.get('/api/business-services', async (_req, res) => {
    try { res.json({ services: await businessServices.list('local') }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/business-services', async (req, res) => {
    try { res.status(201).json({ service: await businessServices.create('local', req.body || {}) }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/business-services/context', async (_req, res) => {
    try { res.json({ context: await businessServices.getEngineContext('local') }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/business-services/:id', async (req, res) => {
    const service = await businessServices.get('local', req.params.id);
    if (!service) return res.status(404).json({ error: 'Service introuvable.' });
    res.json({ service, summary: businessServices.summary(service) });
  });
  app.put('/api/business-services/:id', async (req, res) => {
    const service = await businessServices.update('local', req.params.id, req.body || {});
    if (!service) return res.status(404).json({ error: 'Service introuvable.' });
    res.json({ service });
  });
  app.delete('/api/business-services/:id', async (req, res) => {
    res.json(await businessServices.remove('local', req.params.id));
  });
  app.post('/api/business-services/:id/connect', async (req, res) => {
    try { res.json(await businessServices.connectApi('local', req.params.id, req.body || {})); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/business-services/:id/test', async (req, res) => {
    try { res.json(await businessServices.testConnection('local', req.params.id)); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/business-services/:id/permissions', async (req, res) => {
    const service = await businessServices.setPermissions('local', req.params.id, (req.body || {}).scopes || []);
    if (!service) return res.status(404).json({ error: 'Service introuvable.' });
    res.json({ service });
  });

  // ---------- Répondeur automatique et politique de conversation ----------
  const conversationPolicy = require('./ai-engine/conversationPolicy');
  app.get('/api/auto-responder', async (_req, res) => {
    try { res.json({ ok: true, settings: await autoResponder.getSettings('local') }); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.post('/api/auto-responder', async (req, res) => {
    try {
      const b = req.body || {}; const patch = {};
      for (const key of ['whatsapp', 'telegram', 'alwaysOn', 'paused', 'groupReplies']) if (typeof b[key] === 'boolean') patch[key] = b[key];
      res.json({ ok: true, settings: await autoResponder.setSettings('local', patch) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
  app.get('/api/conversation-policy', async (_req, res) => {
    try { const policy = await conversationPolicy.get('local'); res.json({ ok: true, policy, resume: conversationPolicy.describe(policy) }); }
    catch (err) { res.status(500).json({ error: 'Indisponible.' }); }
  });
  app.post('/api/conversation-policy', async (req, res) => {
    try {
      const b = req.body || {}; const patch = {};
      if (conversationPolicy.PRIVATE_MODES.includes(b.private)) patch.private = b.private;
      if (conversationPolicy.GROUP_MODES.includes(b.group)) patch.group = b.group;
      if (conversationPolicy.PRESENT_MODES.includes(b.presentServices)) patch.presentServices = b.presentServices;
      if (b.windowDays !== undefined) patch.windowDays = b.windowDays;
      if (b.groupMaxRepliesPer10Min !== undefined) patch.groupMaxRepliesPer10Min = b.groupMaxRepliesPer10Min;
      if (typeof b.aiJudgment === 'boolean') patch.aiJudgment = b.aiJudgment;
      const policy = await conversationPolicy.set('local', patch);
      res.json({ ok: true, policy, resume: conversationPolicy.describe(policy) });
    } catch (_) { res.status(500).json({ error: 'Enregistrement impossible.' }); }
  });
  app.get('/api/auto-responder/status', async (_req, res) => {
    try {
      const settings = await autoResponder.getSettings('local');
      res.json({ ok: true, settings, alwaysOn: !!settings.alwaysOn, sessions: { whatsapp: { connected: whatsapp.isConnected() }, telegram: { connected: telegram.isConnected() } } });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ---------- Communautés : parité locale WhatsApp / Telegram ----------
  const communityService = require('./ai-engine/communityService');
  const communityDiscovery = require('./ai-engine/communityDiscovery');
  const cmChannel = (req) => String((req.body && req.body.channel) || req.query.channel || 'WHATSAPP').toUpperCase();
  const cmLocation = (req) => {
    const b = req.body || {};
    const country = String(b.country || '').trim();
    const city = String(b.city || '').trim();
    const department = String(b.department || '').trim();
    return country || city || department ? { country, city, department } : undefined;
  };
  const cmRoute = (fn) => async (req, res) => {
    const channel = cmChannel(req);
    if (!['WHATSAPP', 'TELEGRAM'].includes(channel)) return res.status(400).json({ ok: false, error: 'Canal inconnu.', code: 'INVALID_CHANNEL' });
    try { res.json(await fn(req, 'local')); }
    catch (err) {
      const http = { RECIPIENTS_NOT_FOUND: 404, NOT_FOUND: 404, JOB_ALREADY_RUNNING: 409, INVALID_STATE: 409 }[err.code] || (err.code ? 400 : 500);
      if (http === 500) console.error('communautés :', err.message);
      res.status(http).json({ ok: false, error: http === 500 ? 'Erreur interne.' : err.message, code: err.code || 'INTERNAL' });
    }
  };
  app.post('/api/communities/groups', cmRoute(async (req, tenant) => {
    const b = req.body || {};
    const input = { channel: cmChannel(req), title: b.title, description: b.description, inviteMessage: b.inviteMessage, text: b.text, recipients: b.recipients, defaultCountryCode: b.defaultCountryCode, timing: b.timing };
    if (b.file && b.file.base64) input.file = { buffer: Buffer.from(b.file.base64, 'base64'), name: b.file.name || 'contacts.csv', type: b.file.type || 'text/csv' };
    if (b.image && b.image.base64) input.image = Buffer.from(b.image.base64, 'base64');
    return { ok: true, group: await communityService.startGroup(tenant, input) };
  }));
  app.get('/api/communities/timing-bounds', (_req, res) => res.json({ ok: true, bounds: communityService.TIMING_BOUNDS }));
  app.post('/api/communities/groups/:id/timing', cmRoute(async (req, tenant) => ({ ok: true, group: await communityService.setTiming(tenant, req.params.id, req.body || {}) })));
  app.get('/api/communities/groups', cmRoute(async (_req, tenant) => ({ ok: true, groups: await communityService.listJobs(tenant) })));
  app.get('/api/communities/groups/:id', cmRoute(async (req, tenant) => {
    const group = await communityService.getJob(tenant, req.params.id);
    if (!group) throw Object.assign(new Error('Groupe introuvable.'), { code: 'NOT_FOUND' });
    return { ok: true, group };
  }));
  app.post('/api/communities/groups/:id/pause', cmRoute(async (req, tenant) => ({ ok: true, group: await communityService.pauseJob(tenant, req.params.id) })));
  app.post('/api/communities/groups/:id/cancel', cmRoute(async (req, tenant) => ({ ok: true, group: await communityService.cancelJob(tenant, req.params.id) })));
  app.post('/api/communities/groups/:id/resume', cmRoute(async (req, tenant) => ({ ok: true, group: await communityService.resumeJob(tenant, req.params.id) })));
  app.post('/api/communities/discover', cmRoute(async (req, tenant) => ({ ok: true, ...(await communityDiscovery.discover(tenant, { channel: cmChannel(req), keywords: req.body && req.body.keywords, limit: req.body && req.body.limit, sync: req.body && req.body.sync === true, location: cmLocation(req) })) })));
  app.get('/api/communities/my-groups', cmRoute(async (req, tenant) => {
    const result = await chatOrchestrator.searchMyGroups(cmChannel(req), { adminOnly: req.query.adminOnly === 'true', subject: req.query.subject }, tenant, { runtime: localRuntime });
    if (!result.ok) throw Object.assign(new Error(result.error || 'GROUP_SEARCH_FAILED'), { code: result.error });
    return result;
  }));
  app.get('/api/communities/directory', cmRoute(async (req, tenant) => ({ ok: true, communities: await contactCrm.listCommunities(tenant, { channel: req.query.channel, keyword: req.query.keyword }) })));
  app.post('/api/communities/sync', cmRoute(async (req, tenant) => ({ ok: true, ...(await communityDiscovery.syncToCrm(tenant, Array.isArray(req.body && req.body.communities) ? req.body.communities.slice(0, 100) : [])) })));
  app.post('/api/communities/discover-people', cmRoute(async (req, tenant) => ({ ok: true, ...(await communityDiscovery.discoverPeople(tenant, { channel: cmChannel(req), keywords: req.body && req.body.keywords, limit: req.body && req.body.limit, sync: req.body && req.body.sync === true, location: cmLocation(req) })) })));
  app.post('/api/communities/join', cmRoute(async (req, tenant) => ({ ok: true, community: await communityDiscovery.joinCommunity(tenant, { channel: cmChannel(req), ref: req.body && req.body.ref }) })));
  app.post('/api/communities/extract-members', cmRoute(async (req, tenant) => ({ ok: true, ...(await communityDiscovery.extractMembers(tenant, { channel: cmChannel(req), ref: req.body && req.body.ref })) })));

  app.get('/api/status', async (req, res) => {
    try {
      res.json({
        connected: whatsapp.isConnected(),
        qr: whatsapp.getQRCode(),
        qrImage: await whatsapp.getQRCodeImage(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Purement informatif désormais (voir lib/selfUpdate.js, qui applique
  // déjà la mise à jour AVANT que ce serveur ne démarre) — utile seulement
  // si une mise à jour vient d'apparaître EN COURS de session (elle ne sera
  // appliquée qu'au prochain redémarrage, jamais en cours de route).
  app.get('/api/update-status', async (req, res) => {
    try {
      const { checkForUpdate } = require('./lib/updateCheck');
      res.json(await checkForUpdate());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/whatsapp/send', async (req, res) => {
    try {
      const { to, text } = req.body || {};
      const result = await whatsapp.sendMessage(to, text);
      res.json({ ok: true, id: result?.id?._serialized || null });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ---------- Extraction de groupes WhatsApp (feuille de route "export Excel")
  // ---------- Le fichier lui-même est produit côté navigateur (SheetJS, voir
  // public/lib/xlsx.full.min.js + public/app.js) à partir de ce JSON — pas de
  // dépendance xlsx côté serveur.
  app.get('/api/whatsapp/groups', async (req, res) => {
    try {
      res.json(await whatsapp.getGroups());
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/whatsapp/groups/:id/members', async (req, res) => {
    try {
      res.json(await whatsapp.getGroupMembers(req.params.id));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // ---------- Telegram (MTProto/GramJS, voir lib/telegram.js) ----------
  // Flux de connexion en 3 étapes (numéro -> code -> mot de passe 2FA
  // éventuel) piloté par polling de GET /api/telegram/status plutôt qu'un
  // WebSocket — le frontend affiche le champ correspondant à `step`.
  app.get('/api/telegram/status', (req, res) => {
    res.json({
      configured: telegram.isConfigured(),
      connected: telegram.isConnected(),
      error: telegram.getLoginError(),
    });
  });

  app.post('/api/telegram/login/start', async (req, res) => {
    try {
      const step = await telegram.startLogin(String(req.body?.phone || '').trim());
      res.json({ step });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/telegram/login/code', async (req, res) => {
    try {
      const step = await telegram.submitCode(String(req.body?.code || '').trim());
      res.json({ step });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/telegram/login/password', async (req, res) => {
    try {
      const step = await telegram.submitPassword(String(req.body?.password || ''));
      res.json({ step });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/telegram/logout', async (req, res) => {
    try {
      await telegram.logout();
      res.json({ ok: true });
    } catch (err) {
      // Seule route de ce fichier sans try/catch jusqu'ici : une erreur
      // imprévue (ex. client.logout() inexistant côté GramJS, voir
      // lib/telegram.js) faisait planter tout le process au lieu de
      // renvoyer une erreur HTTP — corrigé en même temps que le bug lui-même.
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/telegram/send', async (req, res) => {
    try {
      const { to, text } = req.body || {};
      await telegram.sendMessage(to, text);
      res.json({ ok: true });
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/telegram/groups', async (req, res) => {
    try {
      res.json(await telegram.getGroups());
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/telegram/groups/:id/members', async (req, res) => {
    try {
      res.json(await telegram.getGroupMembers(req.params.id));
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  app.get('/api/contacts', (req, res) => {
    res.json(db.listContacts());
  });

  // ---------- Liste noire (voir lib/db.js, appliquée dans
  // lib/campaigns.js#createCampaign) ----------
  app.get('/api/blocklist', (req, res) => {
    const channel = req.query.channel === 'telegram' ? 'telegram' : 'whatsapp';
    res.json(db.getBlocklist(channel));
  });

  app.post('/api/blocklist', (req, res) => {
    const { channel, identifier } = req.body || {};
    const resolvedChannel = channel === 'telegram' ? 'telegram' : 'whatsapp';
    const value = String(identifier || '').trim();
    if (!value) return res.status(400).json({ error: 'Identifiant manquant.' });
    db.addToBlocklist(resolvedChannel, value);
    res.json({ ok: true });
  });

  app.delete('/api/blocklist', (req, res) => {
    const { channel, identifier } = req.body || {};
    const resolvedChannel = channel === 'telegram' ? 'telegram' : 'whatsapp';
    db.removeFromBlocklist(resolvedChannel, String(identifier || '').trim());
    res.json({ ok: true });
  });

  // ---------- Pont WHATSAPP_LOCAL (couche intelligence -> machine PC) ----------
  // Clé d'accès partagée (secret partagé VPS<->PC) : lue de MACHINE_KEY,
  // sinon générée une fois et persistée dans DATA_DIR/machine-key.txt
  // (jamais commitée). Voir lib/machine.js pour le contrat d'actions.
  const machine = require('./lib/machine');
  let machineKey = String(process.env.MACHINE_KEY || '').trim();
  if (!machineKey) {
    const fs = require('fs');
    const keyPath = path.join(DATA_DIR, 'machine-key.txt');
    try {
      if (fs.existsSync(keyPath)) machineKey = fs.readFileSync(keyPath, 'utf8').trim();
      if (!machineKey) {
        machineKey = require('crypto').randomBytes(24).toString('hex');
        fs.writeFileSync(keyPath, machineKey, 'utf8');
      }
    } catch (e) {
      machineKey = require('crypto').randomBytes(24).toString('hex');
    }
    console.log(`Clé machine (WHATSAPP_LOCAL) : ${machineKey} — configurez-la côté orchestrateur.`);
  }

  app.use('/api/machine', (req, res, next) => {
    const provided = String(req.get('x-machine-key') || '').trim();
    const ok = machineKey && provided && provided.length === machineKey.length
      && require('crypto').timingSafeEqual(Buffer.from(provided), Buffer.from(machineKey));
    if (!ok) return res.status(401).json({ error: 'MACHINE_KEY_INVALID' });
    next();
  });

  // Carte machine (Machine view) : ce que cette machine sait faire + état.
  app.get('/api/machine', async (req, res) => {
    try {
      const s = await machine.getStatus();
      res.json(s.result);
    } catch (err) {
      res.status(502).json({ error: err.message });
    }
  });

  // Un job = une action du registre intelligence, exécutée réellement ici.
  app.post('/api/machine/job', async (req, res) => {
    try {
      const { action, payload } = req.body || {};
      const out = await machine.execute(action, payload);
      res.status(out.ok ? 200 : 400).json(out);
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  // ---------- Chat Intelligent (Goal Chat, voir lib/intelligence/goal-chat.js)
  // ---------- Même moteur que le mode VPS (task-parser + human-context-engine),
  // en session mémoire par sessionId. Contrairement au VPS, "run-plan" n'est
  // PAS auto-exécuté ici : le client redirige vers l'onglet Campagnes (canal
  // préréglé) plutôt que de réimplémenter un moteur d'envoi côté chat — le
  // vrai envoi passe toujours par POST /api/campaigns (lib/campaigns.js).
  const goalChatSessions = new Map();
  // Continuation d'intention (offre/paiement/compte, voir
  // ai-engine/chatOrchestrator.js#detectIntent) — équivalent local, en
  // mémoire, de ce que aiStudioStore.js fournit côté VPS via l'historique de
  // session persisté (ce tchat-ci reste stateless côté client par ailleurs,
  // voir goalChatSessions ci-dessus pour le seul état vraiment nécessaire).
  const lastAssistantBySession = new Map();

  // Mémoire de conversation PERSISTANTE et effaçable par discussion (parité VPS,
  // voir lib/intelligence/vps-bridge.js) — l'agent ne repart plus de zéro. Un
  // document par sessionId (storageAdapter local) + cache mémoire. Effacée via
  // l'action 'restart'.
  const CHAT_MEMORY_NAMESPACE = 'chat_intelligent_sessions';
  const sessionHistoryCache = new Map();
  async function getChatHistory(sid) {
    if (sessionHistoryCache.has(sid)) return sessionHistoryCache.get(sid);
    const doc = await businessProfileStore.get(CHAT_MEMORY_NAMESPACE, sid, { messages: [] });
    const messages = Array.isArray(doc.messages) ? doc.messages : [];
    sessionHistoryCache.set(sid, messages);
    return messages;
  }
  function recordChatTurn(sid, userText, assistantText) {
    const h = sessionHistoryCache.get(sid) || [];
    h.push({ role: 'user', text: String(userText || '') });
    if (assistantText) h.push({ role: 'assistant', text: String(assistantText).slice(0, 2000) });
    while (h.length > 40) h.shift();
    sessionHistoryCache.set(sid, h);
    businessProfileStore.set(CHAT_MEMORY_NAMESPACE, sid, { sessionId: sid, messages: h, updatedAt: new Date().toISOString() });
  }
  function clearChatHistory(sid) {
    sessionHistoryCache.delete(sid);
    businessProfileStore.set(CHAT_MEMORY_NAMESPACE, sid, { sessionId: sid, messages: [], updatedAt: new Date().toISOString() });
  }

  // Génère une image et la rapatrie en buffer (aiGateway renvoie une URL) pour
  // que handleGroupPost puisse la publier comme média dans un groupe.
  async function generateImageBuffer(prompt) {
    const r = await aiGateway.generateImage(String(prompt || '').slice(0, 600), { width: 1024, height: 1024 });
    if (r && r.url) {
      const resp = await axios.get(r.url, { responseType: 'arraybuffer', timeout: 60000 });
      return { buffer: Buffer.from(resp.data), mimetype: resp.headers['content-type'] || 'image/jpeg' };
    }
    return null;
  }
  // Pousse un message au client sur son canal (après validation de paiement).
  async function deliverToClientLocal({ channel, from, text }) {
    if (!from) return;
    if (channel === 'TELEGRAM') { if (telegram.isConnected()) await telegram.sendMessage(from, text); }
    else if (whatsapp.isConnected()) await whatsapp.sendMessage(from, text);
  }

  // Dépendances du Chat-Driven Agent Orchestrator — hissées ici (au lieu d'être redéfinies dans la route du
  // tableau de bord plus bas) pour être réutilisables aussi par le canal propriétaire self-chat (ownerDeps.chat,
  // voir ai-engine/assistantLayer.js/ownerChannel.js), qui appelle le MÊME chatOrchestrator.handle().
  const orchestratorDeps = {
    runtime: localRuntime,
    humanContext,
    generateImage: generateImageBuffer,
    deliverToClient: deliverToClientLocal,
    executeOptions: { env: process.env },
  };

  // --- Couche d'assistance générale (self-chat, routage privé/métier, campagnes d'entrée/de groupes) -------------
  // ADAPTATEUR local-client : ai-engine/assistantLayer.js est copié tel quel depuis le VPS (jamais modifié) — il
  // attend des dépendances façon gestionnaire multi-tenant (adapters/whatsappManager.js/telegramManager.js,
  // ai-engine/aiStudioStore.js) qui n'existent pas en mode local mono-compte : adaptées ci-dessous, à la frontière,
  // sans toucher au fichier partagé (voir docs/PORTAGE-LOCAL-MOBILE.md pour le détail de cette investigation).
  const OWNER_CHANNEL_NAMESPACE = 'owner_channel_sessions';
  const OWNER_SESSION_ID = 'local-owner';
  const ownerChannelRef = require('./ai-engine/ownerChannel');
  // aiStudioStore façon VPS (listSessions/getSession/createSession/appendMessages) : ici un seul document fixe,
  // toujours "trouvé" par son titre (mono-compte, pas besoin de vraiment chercher parmi plusieurs sessions).
  const aiStudioStoreLocal = {
    listSessions: async () => [{ id: OWNER_SESSION_ID, title: ownerChannelRef.SESSION_TITLE }],
    getSession: async (t, id) => businessProfileStore.get(OWNER_CHANNEL_NAMESPACE, id, { messages: [] }),
    createSession: async () => ({ id: OWNER_SESSION_ID }),
    appendMessages: async (t, id, msgs) => {
      const doc = await businessProfileStore.get(OWNER_CHANNEL_NAMESPACE, id, { messages: [] });
      doc.messages = (doc.messages || []).concat(msgs).slice(-40);
      businessProfileStore.set(OWNER_CHANNEL_NAMESPACE, id, doc);
    },
  };
  // « Session » au sens attendu par ownerChannel.js (peek().session, getIdentityHints, self-chat...) : whatsapp-web.js
  // n'a pas de LID séparé du numéro (contrairement à Baileys) — getSelfIds() ne renvoie donc que `pn`. Un message de
  // groupe distingue le CHAT (msg.from = le groupe) de l'EXPÉDITEUR réel (msg.author) — jamais confondus ci-dessous.
  const localWhatsappSession = {
    sendMessage: (to, text) => whatsapp.sendMessage(to, text),
    isConnected: () => whatsapp.isConnected(),
    getSelfIds: () => { const n = whatsapp.getConnectedNumber(); return n ? { pn: `${n}@c.us` } : {}; },
    isSelfChatJid: (jid) => { const n = whatsapp.getConnectedNumber(); return !!n && jid === `${n}@c.us`; },
    getIdentityHints: (msg) => ({
      jid: msg.from, senderJid: msg.author || msg.from, altJids: [],
      pushName: (msg._data && msg._data.notifyName) || null, savedName: null, knownName: null,
    }),
    // Pièces jointes en self-chat : non supporté pour l'instant (voir docs/PORTAGE-LOCAL-MOBILE.md) — dégrade
    // proprement, ownerChannel.js capture déjà l'échec de téléchargement (voir son commentaire "0) MÉDIA").
    downloadIncomingMedia: async () => { throw new Error('MEDIA_SELF_CHAT_NOT_SUPPORTED'); },
  };
  const localTelegramSession = {
    sendMessage: (to, text) => telegram.sendMessage(to, text),
    isConnected: () => telegram.isConnected(),
    isSavedMessages: () => true, // déjà filtré en amont par lib/telegram.js#onOwnerMessage (chatId === mon id)
  };
  // Baileys adresse un message par `msg.key.{remoteJid,id,fromMe}` + `msg.message.conversation` (voir
  // ownerChannel.js#WHATSAPP, jamais modifié ici pour rester resynchronisable tel quel) — whatsapp-web.js expose
  // directement `msg.from`/`msg.id`/`msg.body`. Construit l'enveloppe attendue à la frontière, sans toucher au
  // fichier partagé (même principe que les autres adaptations de ce dossier).
  function shimBaileysMessage(msg) {
    return { key: { remoteJid: msg.from, id: msg.id && msg.id._serialized, fromMe: !!msg.fromMe }, message: { conversation: msg.body || '' } };
  }
  const whatsappManagerStub = {
    peek: () => ({ session: localWhatsappSession }),
    setOwnerMessageHandler: (cb) => {
      whatsapp.onOwnerMessage((msg) => cb({ tenantId: 'local', session: localWhatsappSession, msg: shimBaileysMessage(msg) }));
    },
  };
  const telegramManagerStub = {
    setOwnerMessageHandler: (cb) => {
      telegram.onOwnerMessage((msg) => cb({ tenantId: 'local', session: localTelegramSession, msg }));
    },
  };
  const assistant = assistantLayer.create({
    whatsappManager: whatsappManagerStub,
    telegramManager: telegramManagerStub,
    autoResponder,
    getRuntime: () => localRuntime,
    chatOrchestrator,
    aiStudioStore: aiStudioStoreLocal,
    llmFallbackEngine,
    platformOrchestrator,
    chatDeps: () => orchestratorDeps,
  });
  assistant.start();

  app.post('/api/intelligence/goal-chat', async (req, res) => {
    const { message, sessionId, action } = req.body || {};
    let state = sessionId ? goalChatSessions.get(sessionId) : null;
    if (!state) {
      state = goalChat.createSession({});
      goalChatSessions.set(state.sessionId, state);
    }
    if (action === 'restart') {
      goalChatSessions.delete(state.sessionId);
      lastAssistantBySession.delete(state.sessionId);
      clearChatHistory(state.sessionId);
      const fresh = goalChat.createSession({});
      goalChatSessions.set(fresh.sessionId, fresh);
      return res.json({ ok: true, sessionId: fresh.sessionId, kind: 'question', reply: goalChat.WELCOME });
    }
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Le champ "message" est requis (ou action:"restart").' });
    }

    // Chat-Driven Agent Orchestrator — consulté EN PREMIER (offre/rapport/
    // paiement/compte/campagne/inbox/groupes/récurrence/CRM), avant le pipeline
    // goal-chat brut existant. Retombe proprement dessus si rien n'est détecté.
    const lastAssistantMessage = lastAssistantBySession.get(state.sessionId) || null;
    const orchestrated = await chatOrchestrator.handle(
      { text: message, history: await getChatHistory(state.sessionId), sessionId: state.sessionId, lastAssistantMessage, tenantId: 'local', principal: LOCAL_OWNER_PRINCIPAL },
      orchestratorDeps,
    ).catch((err) => {
      console.warn('Chat-Driven Agent Orchestrator (local) — échec, repli sur goal-chat brut :', err.message);
      return null;
    });

    if (orchestrated) {
      lastAssistantBySession.set(state.sessionId, {
        isPlanningQuestion: !!orchestrated.isPlanningQuestion,
        intent: orchestrated.intent || null,
      });
      recordChatTurn(state.sessionId, message, orchestrated.text);
      return res.json({
        ok: true,
        sessionId: state.sessionId,
        reply: { text: orchestrated.text },
        kind: orchestrated.actionLog ? 'plan' : 'question',
        actionLog: orchestrated.actionLog || null,
      });
    }

    const out = goalChat.step(state, { message, parser: taskParser, humanContext });
    recordChatTurn(state.sessionId, message, out && out.reply && out.reply.text);
    res.json(Object.assign({ ok: true, sessionId: state.sessionId }, out));
  });

  // Notifications asynchrones (escalade prospect, feedback client, voir
  // ai-engine/emotionalCloser.js + ai-engine/platformOrchestrator.js) —
  // sondé périodiquement par le frontend (public/intelligence.js), vidé à
  // chaque appel (affichage "une seule fois", comme un toast).
  app.get('/api/notifications', (req, res) => {
    res.json({ notifications: platformOrchestrator.drainNotifications() });
  });

  // ---------- Page Connexions : historique unifié WhatsApp + Telegram ----------
  app.get('/api/history', (req, res) => {
    res.json(db.listSentHistory(100));
  });

  app.post('/api/whatsapp/logout', async (req, res) => {
    try {
      await whatsapp.logout();
      // Relance immédiatement une session vierge (nouveau QR) plutôt que de
      // laisser whatsapp-web.js inactif jusqu'au prochain redémarrage complet
      // du serveur - même esprit que logoutWhatsApp() côté mobile/webapp.
      whatsapp.connect().catch((err) => {
        console.error('Erreur lors de la reconnexion WhatsApp après déconnexion :', err.message);
      });
      res.json({ ok: true });
    } catch (err) {
      console.error('Erreur lors de la déconnexion WhatsApp :', err.stack || err.message);
      res.status(500).json({ error: err.message });
    }
  });

  // Import manuel ou CSV (déjà parsé côté navigateur, voir public/app.js) :
  // accepte un tableau de { telephone, nom } ou de simples numéros.
  app.post('/api/contacts/import', (req, res) => {
    const entries = Array.isArray(req.body?.contacts) ? req.body.contacts : [];
    let count = 0;
    for (const entry of entries) {
      const telephone = typeof entry === 'string' ? entry : entry.telephone;
      const nom = typeof entry === 'string' ? null : entry.nom;
      const digits = String(telephone || '').replace(/\D/g, '');
      if (!digits) continue;
      db.upsertContact({ jid: `${digits}@s.whatsapp.net`, nom, telephone: digits });
      count += 1;
    }
    res.json({ imported: count });
  });

  app.get('/api/messages/:jid', (req, res) => {
    res.json(db.listMessages(req.params.jid));
  });

  // ---------- Campagnes locales (voir lib/campaigns.js) ----------
  app.get('/api/legacy-campaigns', (req, res) => {
    res.json(campaigns.listCampaigns());
  });

  app.post('/api/legacy-campaigns', (req, res) => {
    try {
      const { name, recipients, text, delayMinMs, delayMaxMs, channel, media, batchSize, batchPauseMs } = req.body || {};
      const campaign = campaigns.createCampaign(name, recipients, { text, delayMinMs, delayMaxMs, channel, media, batchSize, batchPauseMs });
      res.json(campaign);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/legacy-campaigns/:id', (req, res) => {
    const campaign = campaigns.getCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campagne introuvable.' });
    res.json(campaign);
  });

  app.post('/api/legacy-campaigns/:id/start', (req, res) => {
    try {
      campaigns.startCampaign(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/legacy-campaigns/:id/pause', (req, res) => {
    try {
      campaigns.pauseCampaign(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/legacy-campaigns/:id/cancel', (req, res) => {
    try {
      campaigns.cancelCampaign(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Relance Manuelle Express (voir public/relance.js) : trace un envoi
  // déclenché manuellement via deep link, sans passer par la boucle
  // automatique de lib/campaigns.js#runLoop.
  app.post('/api/legacy-campaigns/:id/mark-sent', (req, res) => {
    try {
      campaigns.markManualSent(req.params.id, String(req.body?.to || ''));
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Passerelle IA (jamais de clé fournisseur ici, voir lib/aiGateway.js).
  app.post('/api/ai/text', async (req, res) => {
    try {
      const { prompt, history, mode, skillKey } = req.body || {};
      const result = await aiGateway.generateText(prompt, { history, mode, skillKey });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.response?.data?.error || err.message });
    }
  });

  app.post('/api/ai/image', async (req, res) => {
    try {
      const { prompt, width, height } = req.body || {};
      const result = await aiGateway.generateImage(prompt, { width, height });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.response?.data?.error || err.message });
    }
  });

  // ---------- Creative Director (Studio Média Prédictif, voir
  // public/media-studio.js) — parité avec POST /api/media/creative-direction
  // côté VPS (index.js racine) : même prompt structuré JSON, réutilise
  // aiGateway.generateText au lieu de dupliquer une cascade LLM ici.
  const MEDIA_CREATIVE_SECTORS = ['restauration', 'immobilier', 'ecommerce', 'hightech', 'formation'];
  const MEDIA_CREATIVE_FORMATS = ['9:16', '1:1', '16:9', '4:5'];

  function extractJsonBlock(rawText) {
    const match = String(rawText || '').match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch (err) {
      return null;
    }
  }

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

  app.post('/api/media/creative-direction', async (req, res) => {
    const concept = String((req.body || {}).concept || '').trim();
    if (!concept) {
      return res.status(400).json({ error: 'Décrivez le visuel avant de demander une direction créative IA.' });
    }
    const instructionPrompt = [
      'Réponds UNIQUEMENT avec un objet JSON valide (aucun texte avant/après, aucun markdown), exactement dans ce format :',
      `{"detectedSector":"une valeur parmi ${MEDIA_CREATIVE_SECTORS.join('|')}","marketingHook":"accroche courte et percutante en français pour une affiche","imagePromptEnglish":"prompt visuel photoréaliste ultra-détaillé en anglais avec éclairage et détails HD, pour un générateur d'image IA","videoScript":"script court en français pour une voix off vidéo (2 à 3 phrases)","suggestedFormats":["deux valeurs parmi ${MEDIA_CREATIVE_FORMATS.join(', ')}"]}`,
      `Demande du client : "${concept}"`,
    ].join('\n');

    try {
      const { text: llmText, provider } = await aiGateway.generateText(instructionPrompt, { mode: 'json' });
      const directive = parseCreativeDirective(llmText);
      if (!directive) throw new Error('Aucun JSON de directive créative exploitable dans la réponse du LLM.');
      res.json({ directive, provider });
    } catch (err) {
      console.warn('Creative Director IA — cascade LLM indisponible :', err.message);
      res.status(503).json({ error: 'Direction créative IA indisponible pour le moment — renseignez les champs manuellement.' });
    }
  });

  // Vidéo IA (image-to-video, job asynchrone — voir lib/aiGateway.js#startVideo/
  // pollVideo). Le client doit d'abord obtenir une image (voir /api/ai/image)
  // avant de soumettre son URL ici.
  app.post('/api/ai/video/start', async (req, res) => {
    try {
      const { imageUrl, prompt, seed, preferredProvider } = req.body || {};
      const result = await aiGateway.startVideo(imageUrl, { prompt, seed, preferredProvider });
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.response?.data?.error || err.message });
    }
  });

  app.post('/api/ai/video/poll', async (req, res) => {
    try {
      const { jobId } = req.body || {};
      const result = await aiGateway.pollVideo(jobId);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err.response?.data?.error || err.message });
    }
  });

  // ---------- Génération de livre PDF (voir lib/pdf/ebookGenerator.js)
  // ----------
  // Rédaction séquentielle des chapitres (jamais un seul gros appel
  // multi-chapitres, voir index.js racine#executeGenerateBook) : un modèle
  // gratuit à quota de sortie limité tronquerait une réponse trop longue.
  // pdfkit lui-même n'a besoin d'aucun réseau — seul aiGateway.generateText
  // (via la passerelle Cloudflare) appelle l'extérieur.
  app.post('/api/ebook/generate', async (req, res) => {
    try {
      // Parité avec public/dashboard.html (Studio IA > Générateur de Livres) :
      // ebookGenerator.js (racine, copié à l'identique ici) supporte déjà
      // tous ces champs (spec.subtitle/author/date/watermarkText/
      // coverImageBuffer/logoImageBuffer/introduction/conclusion) — seule
      // cette route ne les exposait pas encore. Plus de plafond à 5
      // chapitres (le VPS n'en impose pas non plus).
      const {
        title, subtitle, author, date, watermarkText, introduction, conclusion,
        chapterTopics, coverImageBase64, logoImageBase64,
      } = req.body || {};
      const topics = Array.isArray(chapterTopics) ? chapterTopics : [];
      if (topics.length === 0) {
        return res.status(400).json({ error: 'Aucun sujet de chapitre à rédiger.' });
      }

      const chapters = [];
      for (const topic of topics) {
        const chapterPrompt = `Chapitre à rédiger intégralement pour le livre "${title}" : "${topic}"`;
        // eslint-disable-next-line no-await-in-loop -- rédaction séquentielle volontaire
        const { text: content } = await aiGateway.generateText(chapterPrompt, { mode: 'longform' });
        chapters.push({ title: String(topic).slice(0, 150), content: String(content || '').slice(0, 6000) });
      }

      const pdfBuffer = await ebookGenerator.generateEbookPdf({
        title: String(title || 'Livre généré par IA').slice(0, 150),
        subtitle: subtitle ? String(subtitle).slice(0, 200) : undefined,
        author: author ? String(author).slice(0, 150) : undefined,
        date: date ? String(date).slice(0, 60) : undefined,
        watermarkText: watermarkText ? String(watermarkText).slice(0, 60) : undefined,
        introduction: introduction ? String(introduction).slice(0, 6000) : undefined,
        conclusion: conclusion ? String(conclusion).slice(0, 6000) : undefined,
        coverImageBuffer: coverImageBase64 ? Buffer.from(coverImageBase64, 'base64') : undefined,
        logoImageBuffer: logoImageBase64 ? Buffer.from(logoImageBase64, 'base64') : undefined,
        chapters,
      });
      res.set('Content-Type', 'application/pdf');
      res.set('Content-Disposition', `attachment; filename="${String(title || 'livre').replace(/[^a-z0-9]+/gi, '_').slice(0, 80)}.pdf"`);
      res.send(pdfBuffer);
    } catch (err) {
      res.status(502).json({ error: err.response?.data?.error || err.message });
    }
  });

  if (db.getFacebookCaptureSettings()?.enabled) startFacebookCapture();
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Interface locale disponible sur http://localhost:${PORT}`);
    open(`http://localhost:${PORT}`).catch(() => {
      console.warn('Impossible d\'ouvrir automatiquement le navigateur — ouvrez l\'URL ci-dessus manuellement.');
    });
  });

  // Filtrage privé/pro + closing émotionnel auto (voir
  // ai-engine/emotionalCloser.js, ai-engine/message-triage.js) — même
  // prudence par défaut que le VPS : AUTO_CLOSE_PROSPECTS doit valoir
  // exactement "true" pour activer l'envoi réel. Désactivé par défaut, un
  // agent qui répondrait automatiquement à de vrais clients sans
  // activation explicite serait une action à risque.
  // Réponse toujours en TEXTE ici, même si le client a parlé — limitation
  // ASSUMÉE : whatsapp-web.js/GramJS (lib/whatsapp.js, lib/telegram.js)
  // n'exposent pas encore d'envoi de note vocale côté local-client
  // (contrairement au VPS, voir adapters/whatsappEngineBaileys.js#sendVoiceNote/
  // adapters/telegram.js#sendVoiceNote) — la transcription des notes
  // vocales ENTRANTES fonctionne pleinement, seule la synthèse de réponses
  // vocales SORTANTES reste à porter ici.
  async function sendCustomerReply(channel, text, to) {
    if (channel === 'WHATSAPP') return whatsapp.sendMessage(to, text);
    return telegram.sendMessage(to, text);
  }

  async function handleIncomingCustomerMessage(channel, msg) {
    let text = channel === 'WHATSAPP' ? String(msg.body || '') : String(msg.message || '');
    const isVoice = channel === 'WHATSAPP' ? msg.type === 'ptt' : !!msg.voice;
    const from = channel === 'WHATSAPP' ? msg.from : String(msg.chatId || msg.senderId || '');
    const messageId = channel === 'WHATSAPP' ? (msg.id && msg.id._serialized) || null : (msg.id != null ? String(msg.id) : null);
    const hasAttachment = channel === 'WHATSAPP' ? !!msg.hasMedia : !!(msg.media || msg.photo || msg.document);
    const isGroupMsg = channel === 'WHATSAPP' && /@g\.us$/i.test(String(from || ''));

    if (!text.trim() && isVoice) {
      try {
        let buffer;
        if (channel === 'WHATSAPP') {
          const media = await msg.downloadMedia();
          buffer = Buffer.from(media.data, 'base64');
        } else {
          buffer = await msg.downloadMedia();
        }
        const { text: raw, language } = await voiceProcessor.transcribeAudio(buffer, 'audio/ogg', 'voice.ogg');
        text = (await voiceProcessor.translateToFrench(raw, language)).trim();
      } catch (err) {
        console.error(`voiceProcessor — échec de transcription d'une note vocale entrante (${channel}) :`, err.message);
        return;
      }
    }
    if (!text.trim() || !from) return;

    // IDENTITÉ RÉELLE du contact (nom -> vrai numéro -> « non identifié ») : utilisée par les campagnes ci-dessous,
    // la mémoire et le routage. Le self-chat propriétaire est déjà géré séparément (voir whatsapp.onOwnerMessage/
    // telegram.onOwnerMessage plus haut) : ce chemin-ci ne reçoit jamais de message du propriétaire lui-même.
    const identity = await assistant.resolveIdentity({ channel, tenantId: 'local', session: channel === 'WHATSAPP' ? localWhatsappSession : null, msg }).catch((err) => {
      console.error(`contactIdentity (local, ${channel}) :`, err.message);
      return null;
    });

    // CAMPAGNES DE GROUPES (WhatsApp uniquement) : intérêt d'un membre / preuve de paiement d'un prospect
    // (expéditeur RÉEL, jamais l'identifiant du groupe).
    if (channel === 'WHATSAPP') {
      try {
        const gc = isGroupMsg
          ? await assistant.groupEntry({ tenantId: 'local', session: localWhatsappSession, msg, text, from, messageId, hasAttachment })
          : await assistant.leadDm({ tenantId: 'local', jid: from, identity, text, hasAttachment, messageId });
        if (gc && gc.handled) return;
      } catch (err) { console.error(`groupCampaigns (local) :`, err.message); }
    }

    // Historique PERSISTANT (>= 7 jours) — enregistre chaque message entrant
    // pour la mémoire opérationnelle + la réponse au dernier message.
    const senderNameHist = (identity && identity.displayName) || (channel === 'WHATSAPP'
      ? (msg._data && msg._data.notifyName) || null
      : (msg.sender && (msg.sender.firstName || msg.sender.username)) || null);
    conversationHistory.record('local', {
      channel, direction: 'in', party: from, name: senderNameHist, text,
      ts: channel === 'WHATSAPP' ? (msg.timestamp || Math.floor(Date.now() / 1000)) : (Number(msg.date) > 0 ? Number(msg.date) : Math.floor(Date.now() / 1000)),
      chatId: from, hasMedia: hasAttachment,
    });

    // Preuve de paiement manuel entrante (Human-in-the-Loop) — priorité sur le
    // closing. handleClientProof n'accorde jamais d'accès (enregistre + fiche
    // admin) ; l'accusé auto au client n'est envoyé que si AUTO_PAYMENT_VALIDATION.
    if (!isGroupMsg && manualPaymentValidator.looksLikePaymentProof(text, hasAttachment)) {
      const ack = await manualPaymentValidator.handleClientProof({ tenantId: 'local', channel, from, text, hasAttachment, identity })
        .catch((err) => { console.error('manualPaymentValidator (local) :', err.message); return null; });
      if (ack && AUTO_PAYMENT_VALIDATION) await sendCustomerReply(channel, ack, from).catch(() => {});
      return;
    }

    // CAMPAGNE D'ENTRÉE PUBLICITAIRE (WhatsApp uniquement) : nouveau contact reconnu -> message initial EXACT du
    // propriétaire (idempotent, voir ai-engine/adCampaigns.js).
    if (channel === 'WHATSAPP') {
      try {
        const ad = await assistant.adEntry({ tenantId: 'local', channel, msg, text, from, messageId, identity });
        if (ad && ad.handled) return;
      } catch (err) { console.error(`adCampaigns (local) :`, err.message); }
    }

    // COUCHE D'ASSISTANCE GÉNÉRALE : conversations privées/quotidiennes (réponse sûre, alerte du propriétaire,
    // handoff) avant le moteur commercial. Les conversations métier retombent sur autoResponder/Jarvis ci-dessous.
    try {
      const routed = await assistant.route({ tenantId: 'local', channel, session: channel === 'WHATSAPP' ? localWhatsappSession : null, msg, text, from, messageId, hasAttachment, identity });
      if (routed && routed.handled) return;
    } catch (err) { console.error(`assistantLayer.route (local) :`, err.message); }

    // AUTONOMIE CONVERSATIONNELLE (priorité, si activée pour ce compte+canal) : CYRUS tient la conversation tout
    // seul — mémoire du contact -> IA ancrée sur les Services Métiers réels -> envoi vérifié -> sauvegarde. On ne
    // retombe sur le repli historique ci-dessous QUE si l'auto-réponse est explicitement désactivée (DISABLED).
    const autoOut = await autoResponder.handleIncoming(
      { tenantId: 'local', channel, from, name: senderNameHist, text, messageId },
      { runtime: localRuntime, identity },
    ).catch((err) => {
      console.error(`autoResponder (local, ${channel}) :`, err.message);
      return { skipped: 'ERROR' };
    });
    if (!autoOut || autoOut.skipped !== 'DISABLED') return;

    const classification = messageTriage.classify(text);
    if (classification.category === 'business') {
      const profile = await businessProfileStore.get('business_profiles', 'local', { offers: [], faq: [] });
      messageTriage.recordFaqSignal(profile, text);
      businessProfileStore.set('business_profiles', 'local', profile);

      // CRM : mémorise + auto-étiquette le contact ; message d'accueil au 1er
      // contact (gated AUTO_ENGAGE_NEW_CONTACTS), puis on laisse la suite au closer.
      const senderName = channel === 'WHATSAPP'
        ? (msg._data && msg._data.notifyName) || null
        : (msg.sender && (msg.sender.firstName || msg.sender.username)) || null;
      try {
        const seen = await contactCrm.recordSeen('local', { channel, from, name: senderName });
        if (seen.isNew && AUTO_ENGAGE_NEW_CONTACTS) {
          const welcome = (profile && profile.welcomeMessage) || process.env.WELCOME_MESSAGE
            || 'Bonjour 👋 Merci de nous avoir écrit ! Dites-moi ce qui vous intéresse, je vous réponds tout de suite.';
          await sendCustomerReply(channel, welcome, from).catch((err) => console.error('Message d\'accueil (local) :', err.message));
          return;
        }
      } catch (err) {
        console.error(`contactCrm.recordSeen (local, ${channel}) :`, err.message);
      }
    }
    if (!AUTO_CLOSE_PROSPECTS || classification.category !== 'business') return;

    try {
      const reply = await emotionalCloser.handleCustomerMessage({ tenantId: 'local', channel, from, text });
      if (reply) await sendCustomerReply(channel, reply, from);
    } catch (err) {
      console.error(`emotionalCloser (local) — échec de traitement (${channel}) :`, err.message);
    }
  }

  whatsapp.onIncomingMessage((msg) => {
    handleIncomingCustomerMessage('WHATSAPP', msg).catch((err) => {
      console.error('Erreur dans le traitement intelligent d\'un message WhatsApp entrant :', err.message);
    });
  });
  telegram.onIncomingMessage((msg) => {
    handleIncomingCustomerMessage('TELEGRAM', msg).catch((err) => {
      console.error('Erreur dans le traitement intelligent d\'un message Telegram entrant :', err.message);
    });
  });

  // Tick des TÂCHES RÉCURRENTES (mono-poste 'local') — parité VPS. Chaque
  // minute : exécute les tâches dues du jour via localRuntime.sendToGroups
  // (markRun avant envoi = idempotent).
  let recurringTickRunning = false;
  async function runRecurringTasksTickLocal() {
    if (recurringTickRunning) return;
    recurringTickRunning = true;
    try {
      const now = new Date();
      const tasks = await recurringTasks.list('local');
      for (const task of tasks) {
        if (!recurringTasks.isDue(task, now)) continue;
        await recurringTasks.markRun('local', task.id, now);
        localRuntime.sendToGroups({ channel: task.channel, target: task.target, text: task.message, tenantId: 'local' })
          .then((out) => { if (!out || out.ok === false) console.warn(`Tâche récurrente ${task.id} : envoi non abouti (${(out && out.error) || 'inconnu'}).`); })
          .catch((err) => console.error(`Tâche récurrente ${task.id} (local) :`, err.message));
      }
    } catch (err) {
      console.error('Cycle des tâches récurrentes (local) :', err.message);
    } finally {
      recurringTickRunning = false;
    }
  }
  const recurringInterval = setInterval(() => { runRecurringTasksTickLocal(); }, 60 * 1000);
  if (recurringInterval.unref) recurringInterval.unref();

  whatsapp.connect().catch((err) => {
    console.error('Erreur lors de la connexion WhatsApp :', err.message);
  });
  telegram.connect().catch((err) => {
    console.error('Erreur lors de la connexion Telegram :', err.message);
  });
}

main().catch((err) => {
  console.error('Erreur fatale au démarrage :', err.message);
  process.exit(1);
});
