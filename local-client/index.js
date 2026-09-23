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
  app.get('/api/campaigns', (req, res) => {
    res.json(campaigns.listCampaigns());
  });

  app.post('/api/campaigns', (req, res) => {
    try {
      const { name, recipients, text, delayMinMs, delayMaxMs, channel, media, batchSize, batchPauseMs } = req.body || {};
      const campaign = campaigns.createCampaign(name, recipients, { text, delayMinMs, delayMaxMs, channel, media, batchSize, batchPauseMs });
      res.json(campaign);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.get('/api/campaigns/:id', (req, res) => {
    const campaign = campaigns.getCampaign(req.params.id);
    if (!campaign) return res.status(404).json({ error: 'Campagne introuvable.' });
    res.json(campaign);
  });

  app.post('/api/campaigns/:id/start', (req, res) => {
    try {
      campaigns.startCampaign(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/campaigns/:id/pause', (req, res) => {
    try {
      campaigns.pauseCampaign(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  app.post('/api/campaigns/:id/cancel', (req, res) => {
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
  app.post('/api/campaigns/:id/mark-sent', (req, res) => {
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
  // (déjà Firebase en premier) appelle l'extérieur.
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

  app.listen(PORT, () => {
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
