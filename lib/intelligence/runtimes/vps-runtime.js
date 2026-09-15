// VPS RUNTIME — bras d'exécution réel de la couche intelligence (VPS_BAILEYS)
// -----------------------------------------------------------------------------
// Relie la couche intelligence (lib/intelligence/*) aux moteurs RÉELS déjà en
// production sur ce serveur : whatsappManager / telegramManager (sessions +
// moteurs de campagne), campaignEngine / telegramCampaignEngine (files
// d'envoi), social-adapters (replyComment, video), licenses (clés d'accès).
//
// RÈGLES D'OR (garanties identiques à celles du bridge) :
//   - ZÉRO effet de bord par défaut : chaque méthode enveloppe son appel en
//     try/catch et renvoie { ok:false, error } — jamais un throw qui ferait
//     échouer le moteur d'automatisation.
//   - NE TOUCHE PAS à la gestion de sessions/connexion : il consomme
//     whatsappManager.getOrCreate()/telegramManager.getOrCreate() comme le
//     fait déjà index.js (dispatchScheduledWhatsapp/Telegram).
//   - Résolution de session par payload.tenantId, repli sur le tenant admin
//     (__admin__, auto-reconnecté au boot) quand l'identifiant est 'default'
//     ou ne nomme pas une session réelle.
//
// Le registre des 12 actions reste la source unique du dispatch :
// l'objet renvoyé expose (1) les méthodes concrètes attendues par
// action-executor (extractMembers, sendCampaign, sendMessage, replyComment,
// generateVideo, pauseCampaign, resumeCampaign, generateAccessKey) ET
// (2) execute(action, payload, meta) qui délègue à une instance interne du
// registre branchée sur ces mêmes méthodes — parité exacte avec le mode
// ZERO_VPS.

'use strict';

const path = require('path');

function createVpsRuntime(deps) {
  const d = deps || {};
  const whatsappManager = d.whatsappManager || null;
  const telegramManager = d.telegramManager || null;
  const licenses = d.licenses || null;
  const logger = d.logger || ((...a) => console.log('[vps-runtime]', ...a));

  // Machines cibles (Machine view) : WHATSAPP_LOCAL route les actions WhatsApp
  // vers le PC de l'utilisateur via HTTP (local-client). Aucune machine
  // configurée => comportement existant inchangé (zéro-régression).
  const machines = require(path.join(__dirname, '..', 'machines.js')).createMachineRegistry({
    env: d.env || process.env,
    http: d.http || null,
  });
  function machineTarget(payload) {
    const p = payload || {};
    const target = p.machine || (p.engine === 'WHATSAPP_LOCAL' ? 'WHATSAPP_LOCAL' : null);
    return target && machines.has(target) ? machines.get(target) : null;
  }
  const { httpJob } = require(path.join(__dirname, '..', 'machines.js'));

  // Contexte de l'appel en cours : mémorise la machine cible résolue par
  // execute() pour que sendMessage (FOLLOW_UP direct, signature sans payload)
  // sache vers qui router. Assigné de façon synchrone au début de chaque
  // execute() — sûr en mono-thread : aucun await entre l'affectation et la
  // lecture par la première action dispatchée.
  const callContext = { machine: null };

  // Chargeurs paresseux des modules sociaux (jamais requis si inutilisés).
  let _socialMod = null;
  let _videoMod = null;
  function socialMod() {
    if (_socialMod) return _socialMod;
    try {
      const createSocialAdapters = require(path.join(__dirname, '..', '..', '..', 'social-adapters', 'index.js')).createSocialAdapters;
      _socialMod = createSocialAdapters({ humanContext: d.humanContext || null, publishers: createPublishers() });
    } catch (e) { _socialMod = null; }
    return _socialMod;
  }
  function createPublishers() {
    const { createPublishers: mk } = require(path.join(__dirname, '..', '..', '..', 'social-adapters', 'publishers.js'));
    return mk({ facebook: d.facebook || null, media: d.mediaPublisher || null, youtubeReply: d.youtubeReply || null, humanContext: d.humanContext || null });
  }
  function videoMod() {
    if (_videoMod) return _videoMod;
    try { _videoMod = require(path.join(__dirname, '..', '..', '..', 'social-adapters', 'video-generator.js')); }
    catch (e) { _videoMod = null; }
    return _videoMod;
  }

  // Contacts extraits (EXTRACT_MEMBERS) -> bruts pour SEND_CAMPAIGN quand le
  // payload demande recipientsSource:'extract'. Stockés par canal en mémoire
  // (cycle de vie du process). Le registre d'actions appelle putContacts
  // (canal, membres) sans tenant : les membres portent déjà leur 'to' résolu
  // par extractMembers, clé de ré-usage suffisante pour la campagne suivante.
  const contacts = new Map();
  function channelKey(channel) { return String(channel || 'WHATSAPP').toUpperCase(); }
  const contactsStore = {
    putContacts: async (channel, members) => {
      contacts.set(channelKey(channel), Array.isArray(members) ? members : []);
      return true;
    },
    getContacts: async (channel) => contacts.get(channelKey(channel)) || [],
  };
  function getExtracted(channel) { return contacts.get(channelKey(channel)) || []; }

  // ---------------------------------------------------------------------------
  // Résolution de session : tenant effectif pour une action.
  // ---------------------------------------------------------------------------
  function sessionTenant(payload) {
    const raw = (payload && payload.tenantId) || 'default';
    const t = String(raw).trim();
    if (t && t !== 'default' && t !== 'ZERO_VPS') return t;
    return (whatsappManager && whatsappManager.ADMIN_TENANT_ID) || '__admin__';
  }

  function waEntry(tenantId) {
    if (!whatsappManager) return null;
    try { return whatsappManager.getOrCreate(tenantId); } catch (e) { return null; }
  }
  function tgEntry(tenantId) {
    if (!telegramManager) return null;
    try { return telegramManager.getOrCreate(tenantId); } catch (e) { return null; }
  }

  // ---------------------------------------------------------------------------
  // 1. EXTRACT_MEMBERS — participants réels d'un groupe/canal.
  //    WhatsApp : session.getGroupParticipants (Baileys). Les participants au
  //    format @lid (identité anonyme récente WhatsApp, sans numéro exploitable
  //    pour une campagne) sont filtrés comme dans le reste du dépôt.
  //    Telegram : session.getGroupMembers (ajouté à adapters/telegram.js).
  // ---------------------------------------------------------------------------
  async function extractMembers(channel, groupId, payload) {
    const ch = String(channel || (payload && payload.channel) || 'WHATSAPP').toUpperCase();
    if (ch === 'WHATSAPP') {
      const target = machineTarget(payload);
      if (target) {
        const out = await httpJob(target, 'EXTRACT_MEMBERS', Object.assign({ channel: ch, groupId: groupId || null }, payload), d);
        if (out.ok && out.result) {
          const members = Array.isArray(out.result.members) ? out.result.members : [];
          if (store && members.length) await store.putContacts('WHATSAPP', members);
          return members;
        }
        logger(`extractMembers: machine ${target.id} injoignable (${out.error || 'erreur'})`);
        return [];
      }
    }
    const tenant = sessionTenant(payload);
    try {
      if (ch === 'WHATSAPP') {
        const entry = waEntry(tenant);
        const session = entry && entry.session;
        if (!session || typeof session.getGroupParticipants !== 'function') return [];
        const participants = await session.getGroupParticipants(groupId);
        return (participants || [])
          .filter((p) => p && p.id && !p.id.includes('@lid'))
          .map((p) => ({ id: p.id, to: p.id, nom: (p.name || p.pushName || p.notify || ''), source: 'whatsapp' }));
      }
      if (ch === 'TELEGRAM') {
        const entry = tgEntry(tenant);
        const session = entry && entry.session;
        if (!session || typeof session.getGroupMembers !== 'function') return [];
        const members = await session.getGroupMembers(groupId, { limit: (payload && payload.limit) || 200 });
        return (members || []).map((m) => ({
          id: m.id != null ? String(m.id) : null,
          to: m.username || m.phone || (m.id != null ? String(m.id) : null),
          nom: m.name || m.firstName || '',
          username: m.username || null,
          phone: m.phone || null,
          source: 'telegram',
        })).filter((m) => m.to);
      }
      return [];
    } catch (e) {
      logger(`extractMembers:${ch} échec (${String((e && e.message) || e)})`);
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // 2. SEND_CAMPAIGN — injecte dans le moteur de campagne du canal.
  //    WhatsApp : campaignEngine.start(recipients, { name, sequence, délais,
  //    duplicateWindowHours, enqueueIfBusy }) — mêmes options que
  //    dispatchScheduledWhatsapp. Recipients : payload.recipients, ou les
  //    contacts extraits si recipientsSource === 'extract'.
  //    Telegram : telegramCampaignEngine.start(recipients, message, { media,
  //    recipientType 'groups'|'contacts' }) — mêmes options que
  //    dispatchScheduledTelegram.
  // ---------------------------------------------------------------------------
  async function sendCampaign(payload) {
    const p = payload || {};
    const ch = String(p.channel || 'WHATSAPP').toUpperCase();
    // Machine cible : WHATSAPP_LOCAL reçoit la campagne entière (moteur local).
    if (ch === 'WHATSAPP') {
      const target = machineTarget(p);
      if (target) {
        let recipients = Array.isArray(p.recipients) ? p.recipients : [];
        if (!recipients.length && (p.recipientsSource === 'extract' || p.source === 'extract')) {
          recipients = getExtracted(ch).map((m) => m.to || m.id).filter(Boolean);
        }
        if (!recipients.length) return { ok: false, error: 'EMPTY_RECIPIENTS', channel: ch };
        const job = Object.assign({ channel: ch, recipients, text: p.text || p.message || '', name: p.name, start: p.start !== false }, p);
        const out = await httpJob(target, 'SEND_CAMPAIGN', job, d);
        if (out.ok) return { ok: true, result: { channel: ch, machine: target.id, campaignId: out.result.campaignId || null, status: out.result.status || 'started', recipients: recipients.length } };
        return { ok: false, channel: ch, error: out.error || 'MACHINE_JOB_FAILED' };
      }
    }
    const tenant = sessionTenant(p);
    let recipients = Array.isArray(p.recipients) ? p.recipients : [];
    if (!recipients.length && (p.recipientsSource === 'extract' || p.source === 'extract')) {
      recipients = getExtracted(ch).map((m) => m.to || m.id).filter(Boolean);
    }
    if (!recipients.length) return { ok: false, error: 'EMPTY_RECIPIENTS', channel: ch };

    try {
      if (ch === 'TELEGRAM') {
        const entry = tgEntry(tenant);
        if (!entry || !entry.campaignEngine) return { ok: false, error: 'RUNTIME_MISSING:telegramManager' };
        await entry.campaignEngine.start(recipients, p.text || p.message || '', {
          media: p.media || null,
          recipientType: p.recipientType === 'groups' ? 'groups' : 'contacts',
          name: p.name || null,
        });
        return { ok: true, result: { channel: ch, tenantId: tenant, recipients: recipients.length, status: 'started' } };
      }
      // WHATSAPP (défaut)
      const entry = waEntry(tenant);
      if (!entry || !entry.campaignEngine) return { ok: false, error: 'RUNTIME_MISSING:whatsappManager' };
      const sequence = Array.isArray(p.sequence) && p.sequence.length
        ? p.sequence
        : [{ type: 'text', text: p.text || p.message || '' }];
      await entry.campaignEngine.start(recipients, {
        name: p.name || null,
        sequence,
        sequenceDelayMinMs: (p.minDelayMs || p.sequenceDelayMinMs || 2) * 1000,
        sequenceDelayMaxMs: (p.maxDelayMs || p.sequenceDelayMaxMs || 5) * 1000,
        duplicateWindowHours: p.duplicateWindowHours || 48,
        enqueueIfBusy: p.enqueueIfBusy !== false,
      });
      return { ok: true, result: { channel: ch, tenantId: tenant, recipients: recipients.length, status: 'started' } };
    } catch (e) {
      return { ok: false, channel: ch, error: String((e && e.message) || e) };
    }
  }

  // ---------------------------------------------------------------------------
  // 3. SEND_MESSAGE — envoi direct (FOLLOW_UP, manuel).
  //    WhatsApp : JID normalisé (lib/whatsappRecipients#normalizeJid).
  //    Telegram : résolution username/téléphone (resolveRecipient) puis envoi.
  // ---------------------------------------------------------------------------
  async function sendMessage(channel, to, text) {
    const ch = String(channel || 'WHATSAPP').toUpperCase();
    if (ch === 'WHATSAPP' && callContext.machine) {
      const out = await httpJob(callContext.machine, 'FOLLOW_UP', { to, text }, d);
      return { ok: !!(out && out.ok), error: (out && out.error) || null };
    }
    const tenant = sessionTenant({});
    try {
      if (ch === 'TELEGRAM') {
        const entry = tgEntry(tenant);
        const session = entry && entry.session;
        if (!session || typeof session.resolveRecipient !== 'function') return { ok: false, error: 'RUNTIME_MISSING:telegram' };
        const chat = await session.resolveRecipient(to);
        await session.sendMessage(chat, text);
        return { ok: true };
      }
      const entry = waEntry(tenant);
      const session = entry && entry.session;
      if (!session || typeof session.sendMessage !== 'function') return { ok: false, error: 'RUNTIME_MISSING:whatsapp' };
      const { normalizeJid } = require(path.join(__dirname, '..', '..', '..', 'lib', 'whatsappRecipients.js'));
      await session.sendMessage(normalizeJid(to), text);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // ---------------------------------------------------------------------------
  // READ_RECENT_MESSAGES — lit les derniers messages RÉELLEMENT reçus sur le
  // canal (tampon en mémoire de l'adaptateur, voir
  // adapters/whatsappEngineBaileys.js#getRecentMessages) + l'état de connexion
  // et le numéro connecté. Permet à l'agent de prouver qu'il est bien branché
  // sur le WhatsApp/Telegram du vendeur et de citer un vrai message/expéditeur.
  // ---------------------------------------------------------------------------
  async function getRecentMessages(payload) {
    const p = payload || {};
    const ch = String(p.channel || 'WHATSAPP').toUpperCase();
    const tenant = sessionTenant(p);
    const limit = p.limit || 10;
    try {
      const entry = ch === 'TELEGRAM' ? tgEntry(tenant) : waEntry(tenant);
      const session = entry && entry.session;
      if (!session) return { ok: false, error: ch === 'TELEGRAM' ? 'RUNTIME_MISSING:telegram' : 'RUNTIME_MISSING:whatsapp' };
      const connected = typeof session.isConnected === 'function' ? session.isConnected() : null;
      const paired = typeof session.isPaired === 'function' ? session.isPaired() : null;
      const connectedNumber = typeof session.getConnectedNumber === 'function' ? session.getConnectedNumber() : null;
      if (typeof session.getRecentMessages !== 'function') {
        return { ok: false, error: 'RUNTIME_MISSING:getRecentMessages', connected, paired, connectedNumber };
      }
      const messages = session.getRecentMessages(limit) || [];
      return { ok: true, channel: ch, connected, paired, connectedNumber, messages };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // ---------------------------------------------------------------------------
  // 6. REPLY_COMMENT — réponse à un commentaire social (Facebook réel, sinon
  //    erreur du même type que publishers.js, jamais d'envoi simulé).
  // 7. GENERATE_VIDEO — délègue à lib/media/videoAiEngine (cascade fal/Replicate/HF).
  // 8./9. PAUSE_CAMPAIGN / RESUME_CAMPAIGN — bascule du moteur de campagne.
  // 12. GENERATE_ACCESS_KEY — vraie licence via licenses.createLicense.
  // ---------------------------------------------------------------------------
  async function replyComment(channel, commentId, text, payload) {
    const ch = String(channel || (payload && payload.channel) || 'FACEBOOK').toUpperCase();
    const adapters = socialMod();
    if (!adapters || typeof adapters.replyComment !== 'function') return { ok: false, error: 'RUNTIME_MISSING:socialAdapters' };
    try { return await adapters.replyComment(ch, commentId, text, payload); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  async function generateVideo(payload) {
    const gen = videoMod();
    if (!gen || typeof gen.generateVideo !== 'function') return { ok: false, error: 'RUNTIME_MISSING:video-generator' };
    try { return await gen.generateVideo(payload); }
    catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  async function pauseCampaign(payload) {
    const p = payload || {};
    const ch = String(p.channel || 'WHATSAPP').toUpperCase();
    if (ch === 'WHATSAPP' && machineTarget(p)) {
      const out = await httpJob(machineTarget(p), 'PAUSE_CAMPAIGN', { campaignId: p.campaignId || null }, d);
      return { ok: !!(out && out.ok), error: (out && out.error) || null };
    }
    const tenant = sessionTenant(p);
    try {
      const engine = (ch === 'TELEGRAM' ? tgEntry(tenant) : waEntry(tenant));
      if (!engine || !engine.campaignEngine) return { ok: false, error: 'RUNTIME_MISSING:campaignEngine' };
      engine.campaignEngine.pause(p.campaignId || undefined);
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  async function resumeCampaign(payload) {
    const p = payload || {};
    const ch = String(p.channel || 'WHATSAPP').toUpperCase();
    if (ch === 'WHATSAPP' && machineTarget(p)) {
      const out = await httpJob(machineTarget(p), 'RESUME_CAMPAIGN', { campaignId: p.campaignId || null }, d);
      return { ok: !!(out && out.ok), error: (out && out.error) || null };
    }
    const tenant = sessionTenant(p);
    try {
      const engine = (ch === 'TELEGRAM' ? tgEntry(tenant) : waEntry(tenant));
      if (!engine || !engine.campaignEngine) return { ok: false, error: 'RUNTIME_MISSING:campaignEngine' };
      await engine.campaignEngine.resume(p.campaignId || undefined);
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  async function generateAccessKey(payload) {
    const p = payload || {};
    try {
      if (licenses && typeof licenses.createLicense === 'function') {
        const license = await licenses.createLicense({
          note: p.sku || p.note || 'Générée par la couche intelligence',
          allowedModules: Array.isArray(p.allowedModules) ? p.allowedModules : undefined,
        });
        return { ok: true, accessKey: license.key, sku: p.sku || null, kind: 'license', issuedAt: license.createdAt };
      }
      return { ok: false, error: 'RUNTIME_MISSING:licenses' };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  // ---------------------------------------------------------------------------
  // 13. SCHEDULE_FOLLOWUP — délègue à queues/scheduled_messages.js (même file
  //     de programmation multi-canal que /api/scheduled-messages, consommée
  //     par le tick périodique existant dans index.js#runScheduledMessagesTick
  //     — aucun second ordonnanceur introduit ici).
  // ---------------------------------------------------------------------------
  const scheduledMessages = require(path.join(__dirname, '..', '..', '..', 'queues', 'scheduled_messages.js'));
  async function scheduleFollowUp(payload) {
    const p = payload || {};
    if (!p.to || !p.text || !p.scheduledAt) return { ok: false, error: 'MISSING_TO_TEXT_OR_SCHEDULED_AT' };
    try {
      const entry = scheduledMessages.create({
        channel: String(p.channel || 'WHATSAPP').toLowerCase(),
        recipientType: null,
        recipients: [p.to],
        message: p.text,
        scheduledAt: new Date(p.scheduledAt).toISOString(),
      });
      return { ok: true, result: { id: entry.id, scheduledAt: entry.scheduledAt } };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  // ---------------------------------------------------------------------------
  // Dispatch via le registre partagé des 18 actions (parité ZERO_VPS/VPS).
  // ---------------------------------------------------------------------------
  const registryMod = require(path.join(__dirname, '..', 'action-executor.js'));
  const methods = {
    extractMembers,
    sendCampaign,
    sendMessage,
    getRecentMessages,
    replyComment,
    generateVideo,
    pauseCampaign,
    resumeCampaign,
    generateAccessKey,
    scheduleFollowUp,
  };
  const executor = registryMod.createActionExecutor({
    runtime: methods,
    humanContext: d.humanContext || null,
    env: d.env || process.env,
    store: contactsStore,
    firebaseBase: d.firebaseBase || null,
    http: d.http || null, // transport HTTP pour CREATE_USER_ACCOUNT (null = fetch global)
    llm: d.llm || null, // async (prompt, history, context) => texte, pour ANSWER_STUDENT_QUERY
  });

  return Object.assign(methods, {
    execute: (action, payload, meta) => {
      const p = Object.assign({}, payload || {});
      const m = meta || {};
      if (!p.engine && m.engine) p.engine = m.engine;
      if (!p.machine && (m.machine || p.engine === 'WHATSAPP_LOCAL')) p.machine = m.machine || 'WHATSAPP_LOCAL';
      callContext.machine = machineTarget(p);
      return executor.execute(action, p, m);
    },
    machines,
    actionExecutor: executor,
    _state: () => ({
      tenants: {
        whatsapp: whatsappManager ? (whatsappManager.listActiveEntries ? whatsappManager.listActiveEntries().length : 'n/a') : null,
        telegram: telegramManager ? (telegramManager.listActiveEntries ? telegramManager.listActiveEntries().length : 'n/a') : null,
      },
      contactsByTenant: contacts.size,
    }),
  });
}

module.exports = { createVpsRuntime };