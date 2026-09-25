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

const { AsyncLocalStorage } = require('async_hooks');
const path = require('path');
const actionLedger = require(path.join(__dirname, '..', '..', '..', 'ai-engine', 'actionLedger.js'));
const messageHistory = require(path.join(__dirname, '..', '..', '..', 'ai-engine', 'messageHistory.js'));

// Extrait un identifiant de confirmation RÉEL du résultat d'envoi selon le
// moteur (Baileys .key.id / whatsapp-web.js .id._serialized / GramJS .id).
// null = pas de preuve d'envoi -> jamais un SUCCESS.
function extractConfirmationId(result) {
  if (!result) return null;
  if (result.key && result.key.id) return String(result.key.id);
  if (result.id && result.id._serialized) return String(result.id._serialized);
  if (result.id != null) return String(result.id);
  return null;
}

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

  // Contexte isolé par appel asynchrone : évite qu'une action simultanée d'un
  // autre tenant remplace la session ou la machine de FOLLOW_UP.
  const callContext = new AsyncLocalStorage();

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
  // payload demande recipientsSource:'extract'. Le cache est isolé par tenant
  // et canal; les membres d'un compte ne sont jamais réutilisés par un autre.
  const contacts = new Map();
  function channelKey(channel, tenantId) { return `${String(tenantId || '').trim()}::${String(channel || 'WHATSAPP').toUpperCase()}`; }
  function currentTenant() { const ctx = callContext.getStore(); return ctx && ctx.tenantId ? ctx.tenantId : null; }
  const contactsStore = {
    putContacts: async (channel, members) => {
      contacts.set(channelKey(channel, currentTenant()), Array.isArray(members) ? members : []);
      return true;
    },
    getContacts: async (channel) => contacts.get(channelKey(channel, currentTenant())) || [],
  };
  function getExtracted(channel) { return contacts.get(channelKey(channel, currentTenant())) || []; }

  // ---------------------------------------------------------------------------
  // Résolution de session : tenant effectif pour une action.
  // ---------------------------------------------------------------------------
  function sessionTenant(payload) {
    const raw = currentTenant() || (payload && payload.tenantId) || '';
    const t = String(raw).trim();
    if (!t || t === 'default' || t === 'ZERO_VPS') return null;
    return t;
  }

  function waEntry(tenantId) {
    if (!whatsappManager || !tenantId) return null;
    try { return whatsappManager.getOrCreate(tenantId); } catch (e) { return null; }
  }
  function tgEntry(tenantId) {
    if (!telegramManager || !tenantId) return null;
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
        const tgStatus = await entry.campaignEngine.start(recipients, p.text || p.message || '', {
          media: p.media || null,
          recipientType: p.recipientType === 'groups' ? 'groups' : 'contacts',
          name: p.name || null,
          idempotencyKey: p.idempotencyKey || null,
        });
        return { ok: true, result: { channel: ch, tenantId: tenant, recipients: recipients.length, status: 'started', campaignId: (tgStatus && tgStatus.id) || null } };
      }
      // WHATSAPP (défaut)
      const entry = waEntry(tenant);
      if (!entry || !entry.campaignEngine) return { ok: false, error: 'RUNTIME_MISSING:whatsappManager' };
      const sequence = Array.isArray(p.sequence) && p.sequence.length
        ? p.sequence
        : [{ type: 'text', text: p.text || p.message || '' }];
      const waStatus = await entry.campaignEngine.start(recipients, {
        name: p.name || null,
        idempotencyKey: p.idempotencyKey || null,
        sequence,
        sequenceDelayMinMs: (p.minDelayMs || p.sequenceDelayMinMs || 2) * 1000,
        sequenceDelayMaxMs: (p.maxDelayMs || p.sequenceDelayMaxMs || 5) * 1000,
        duplicateWindowHours: p.duplicateWindowHours || 48,
        enqueueIfBusy: p.enqueueIfBusy !== false,
      });
      return { ok: true, result: { channel: ch, tenantId: tenant, recipients: recipients.length, status: 'started', campaignId: (waStatus && waStatus.id) || null } };
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
    const ctx = callContext.getStore() || {};
    if (ch === 'WHATSAPP' && ctx.machine) {
      const out = await httpJob(ctx.machine, 'FOLLOW_UP', { to, text }, d);
      return { ok: !!(out && out.ok), error: (out && out.error) || null };
    }
    const tenant = sessionTenant({ tenantId: ctx.tenantId });
    if (!tenant) return { ok: false, error: 'TENANT_REQUIRED' };
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
      // Priorité à l'historique PERSISTANT (7 jours, survit au redémarrage) ;
      // repli sur le tampon live de l'adaptateur s'il est vide (juste après un
      // (re)démarrage, avant tout enregistrement persistant).
      let messages = [];
      try {
        const persisted = await messageHistory.getRecent(tenant, ch, limit);
        messages = (persisted || []).map((m) => ({
          from: m.chatId || m.party, number: m.number, name: m.name, text: m.text,
          hasMedia: m.hasMedia, isGroup: String(m.chatId || m.party).endsWith('@g.us'), ts: m.ts,
          direction: m.direction,
        }));
      } catch (e) { messages = []; }
      if (!messages.length) messages = session.getRecentMessages(limit) || [];
      return { ok: true, channel: ch, connected, paired, connectedNumber, messages };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // ENVOI VÉRIFIÉ — le cœur de "l'exécution réelle" : crée une action au
  // registre (actionLedger), envoie RÉELLEMENT, n'annonce SUCCESS que sur
  // identifiant de confirmation réel, sinon FAILED/PENDING. Enregistre le
  // message sortant dans l'historique persistant. Jamais de faux positif.
  async function sendMessageVerified(payload) {
    const p = payload || {};
    const ch = String(p.channel || 'WHATSAPP').toUpperCase();
    const tenant = sessionTenant(p);
    if (!tenant) return { ok: false, status: 'FAILED', error: 'TENANT_REQUIRED' };
    const to = p.to;
    const text = p.text;
    const action = await actionLedger.create(tenant, { type: 'SEND_MESSAGE', channel: ch, target: to, payload: { text } });
    await actionLedger.markInProgress(tenant, action.id);
    try {
      if (!to) { await actionLedger.markFailed(tenant, action.id, 'MISSING_RECIPIENT'); return { ok: false, status: 'FAILED', actionId: action.id, error: 'MISSING_RECIPIENT' }; }
      const entry = ch === 'TELEGRAM' ? tgEntry(tenant) : waEntry(tenant);
      const session = entry && entry.session;
      if (!session || typeof session.sendMessage !== 'function') {
        await actionLedger.markFailed(tenant, action.id, 'RUNTIME_MISSING:' + ch);
        return { ok: false, status: 'FAILED', actionId: action.id, error: 'RUNTIME_MISSING:' + ch };
      }
      if (typeof session.isConnected === 'function' && !session.isConnected()) {
        await actionLedger.markFailed(tenant, action.id, 'NOT_CONNECTED');
        return { ok: false, status: 'FAILED', actionId: action.id, error: 'NOT_CONNECTED', channel: ch, to };
      }
      let result;
      if (ch === 'TELEGRAM') {
        result = await session.sendMessage(to, text);
      } else {
        const { normalizeJid } = require(path.join(__dirname, '..', '..', '..', 'lib', 'whatsappRecipients.js'));
        result = await session.sendMessage(normalizeJid(to), text);
      }
      const confirmationId = extractConfirmationId(result);
      if (confirmationId) {
        await actionLedger.markSuccess(tenant, action.id, { confirmationId, channel: ch });
        await messageHistory.record(tenant, { channel: ch, direction: 'out', party: to, text, ts: Math.floor(Date.now() / 1000), confirmationId, messageId: confirmationId });
        return { ok: true, status: 'SUCCESS', actionId: action.id, confirmationId, channel: ch, to };
      }
      await actionLedger.markPending(tenant, action.id, 'aucun identifiant de confirmation renvoyé par la plateforme');
      return { ok: false, status: 'PENDING', actionId: action.id, channel: ch, to };
    } catch (e) {
      await actionLedger.markFailed(tenant, action.id, String((e && e.message) || e));
      return { ok: false, status: 'FAILED', actionId: action.id, error: String((e && e.message) || e), channel: ch, to };
    }
  }

  // Envoi VÉRIFIÉ d'un MÉDIA (image/pdf/vidéo…) + légende à un contact direct.
  // Même garantie que sendMessageVerified : SUCCESS seulement avec un identifiant
  // réel, sinon PENDING/FAILED. media = { buffer, mimetype, filename, caption }.
  async function sendMediaVerified(payload) {
    const p = payload || {};
    const ch = String(p.channel || 'WHATSAPP').toUpperCase();
    const tenant = sessionTenant(p);
    const to = p.to;
    const media = p.media || {};
    const caption = p.caption || media.caption || p.text || '';
    const action = await actionLedger.create(tenant, { type: 'SEND_MEDIA', channel: ch, target: to, payload: { caption, filename: media.filename || null } });
    await actionLedger.markInProgress(tenant, action.id);
    try {
      if (!to) { await actionLedger.markFailed(tenant, action.id, 'MISSING_RECIPIENT'); return { ok: false, status: 'FAILED', actionId: action.id, error: 'MISSING_RECIPIENT' }; }
      if (!media.buffer) { await actionLedger.markFailed(tenant, action.id, 'MISSING_MEDIA'); return { ok: false, status: 'FAILED', actionId: action.id, error: 'MISSING_MEDIA' }; }
      const entry = ch === 'TELEGRAM' ? tgEntry(tenant) : waEntry(tenant);
      const session = entry && entry.session;
      if (!session || typeof session.sendMedia !== 'function') {
        await actionLedger.markFailed(tenant, action.id, 'RUNTIME_MISSING:sendMedia:' + ch);
        return { ok: false, status: 'FAILED', actionId: action.id, error: 'RUNTIME_MISSING:sendMedia:' + ch };
      }
      if (typeof session.isConnected === 'function' && !session.isConnected()) {
        await actionLedger.markFailed(tenant, action.id, 'NOT_CONNECTED');
        return { ok: false, status: 'FAILED', actionId: action.id, error: 'NOT_CONNECTED', channel: ch, to };
      }
      let dest = to;
      if (ch !== 'TELEGRAM') { const { normalizeJid } = require(path.join(__dirname, '..', '..', '..', 'lib', 'whatsappRecipients.js')); dest = normalizeJid(to); }
      const result = await session.sendMedia(dest, { buffer: media.buffer, mimetype: media.mimetype || 'application/octet-stream', filename: media.filename || 'media', caption });
      const confirmationId = extractConfirmationId(result);
      if (confirmationId) {
        await actionLedger.markSuccess(tenant, action.id, { confirmationId, channel: ch });
        await messageHistory.record(tenant, { channel: ch, direction: 'out', party: to, text: caption || '[média]', ts: Math.floor(Date.now() / 1000), confirmationId, hasMedia: true });
        return { ok: true, status: 'SUCCESS', actionId: action.id, confirmationId, channel: ch, to };
      }
      await actionLedger.markPending(tenant, action.id, 'aucun identifiant de confirmation renvoyé par la plateforme');
      return { ok: false, status: 'PENDING', actionId: action.id, channel: ch, to };
    } catch (e) {
      await actionLedger.markFailed(tenant, action.id, String((e && e.message) || e));
      return { ok: false, status: 'FAILED', actionId: action.id, error: String((e && e.message) || e), channel: ch, to };
    }
  }

  // ---------------------------------------------------------------------------
  // LIST_GROUPS — liste les groupes du compte avec le rôle (isAdmin) et la
  // taille, sur le canal demandé. Permet à l'agent de cibler "les groupes dont
  // je suis admin", "les groupes contenant tel mot", etc.
  // ---------------------------------------------------------------------------
  async function listGroups(payload) {
    const p = payload || {};
    const ch = String(p.channel || 'WHATSAPP').toUpperCase();
    const tenant = sessionTenant(p);
    try {
      const entry = ch === 'TELEGRAM' ? tgEntry(tenant) : waEntry(tenant);
      const session = entry && entry.session;
      if (!session) return { ok: false, error: ch === 'TELEGRAM' ? 'RUNTIME_MISSING:telegram' : 'RUNTIME_MISSING:whatsapp' };
      const connected = typeof session.isConnected === 'function' ? session.isConnected() : null;
      const paired = typeof session.isPaired === 'function' ? session.isPaired() : null;
      if (typeof session.getGroupsSummary !== 'function') {
        return { ok: false, error: 'RUNTIME_MISSING:getGroupsSummary', connected, paired };
      }
      const groups = (await session.getGroupsSummary()) || [];
      return { ok: true, channel: ch, connected, paired, groups };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // ---------------------------------------------------------------------------
  // SEND_TO_GROUPS — publie un message (et éventuellement un média) DANS les
  // groupes ciblés (on écrit au chat de groupe, on n'extrait pas les membres).
  // target = {kind:'named'|'subject'|'admin'|'all', value}. Média passé en
  // objet {buffer,mimetype,...} EN MÉMOIRE (jamais via un payload JSON) — cette
  // méthode est appelée directement par ai-engine/chatOrchestrator.js et par le
  // tick des tâches récurrentes (index.js), pas via le registre d'actions.
  // Délai aléatoire entre groupes (anti-flood), jamais bloquant sur un échec.
  // ---------------------------------------------------------------------------
  function matchGroups(groups, target) {
    const t = target || {};
    const kind = t.kind || 'all';
    const val = t.value ? String(t.value).trim().toLowerCase() : '';
    if (kind === 'admin') return groups.filter((g) => g.isAdmin);
    if ((kind === 'named' || kind === 'subject') && val) {
      const exact = groups.filter((g) => (g.name || '').toLowerCase() === val);
      if (kind === 'named' && exact.length) return exact;
      return groups.filter((g) => (g.name || '').toLowerCase().includes(val));
    }
    return groups; // 'all'
  }

  async function resolveGroups(payload) {
    const p = payload || {};
    const ch = String(p.channel || 'WHATSAPP').toUpperCase();
    const tenant = sessionTenant(p);
    const entry = ch === 'TELEGRAM' ? tgEntry(tenant) : waEntry(tenant);
    const session = entry && entry.session;
    if (!session || typeof session.getGroupsSummary !== 'function') return { ok: false, error: 'RUNTIME_MISSING:getGroupsSummary', session: null, groups: [] };
    const all = (await session.getGroupsSummary()) || [];
    let targets;
    if (Array.isArray(p.groupIds) && p.groupIds.length) {
      const ids = new Set(p.groupIds.map(String));
      targets = all.filter((g) => ids.has(String(g.id)));
    } else {
      targets = matchGroups(all, p.target);
    }
    if (p.limit) targets = targets.slice(0, p.limit);
    return { ok: true, session, groups: targets, totalGroups: all.length };
  }

  async function sendToGroups(payload) {
    const p = payload || {};
    const ch = String(p.channel || 'WHATSAPP').toUpperCase();
    try {
      const r = await resolveGroups(p);
      if (!r.ok) return { ok: false, error: r.error };
      const session = r.session;
      const targets = r.groups;
      if (!targets.length) return { ok: false, error: 'NO_MATCHING_GROUP', matched: 0, totalGroups: r.totalGroups };
      const media = p.media && p.media.buffer ? p.media : null;
      const text = p.text || (media && media.caption) || '';
      const results = [];
      for (const g of targets) {
        try {
          if (media && typeof session.sendMedia === 'function') {
            await session.sendMedia(g.id, { buffer: media.buffer, mimetype: media.mimetype, filename: media.filename || 'media', caption: text });
          } else {
            await session.sendMessage(g.id, text);
          }
          results.push({ id: g.id, name: g.name, ok: true });
        } catch (e) {
          results.push({ id: g.id, name: g.name, ok: false, error: String((e && e.message) || e) });
        }
        await new Promise((res) => setTimeout(res, 1200 + Math.floor(Math.random() * 1800)));
      }
      const sent = results.filter((x) => x.ok).length;
      return { ok: sent > 0, channel: ch, sent, total: targets.length, results };
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
    const tenant = sessionTenant(p);
    if (!tenant) return { ok: false, error: 'TENANT_REQUIRED' };
    const principal = require(path.join(__dirname, '..', '..', '..', 'ai-engine', 'authz.js')).currentPrincipal();
    if (!principal || principal.role !== 'ADMIN') return { ok: false, error: 'ADMIN_REQUIRED' };
    if (principal.tenant !== tenant) return { ok: false, error: 'TENANT_MISMATCH' };
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
  // Statut RÉEL des campagnes d'un tenant (lecture du moteur persistant) + file de continuité manuelle.
  async function getCampaignStatus(payload) {
    const p = payload || {};
    const ch = String(p.channel || 'WHATSAPP').toUpperCase();
    const tenant = sessionTenant(p);
    try {
      const entry = ch === 'TELEGRAM' ? tgEntry(tenant) : waEntry(tenant);
      if (!entry || !entry.campaignEngine) return { ok: false, error: 'RUNTIME_MISSING:campaignEngine' };
      const eng = entry.campaignEngine;
      if (p.campaignId) {
        const st = eng.getStatus(p.campaignId);
        if (!st) return { ok: false, error: 'CAMPAIGN_NOT_FOUND' };
        const manual = typeof eng.getManualRelaunchQueue === 'function' ? eng.getManualRelaunchQueue(p.campaignId) : [];
        return { ok: true, result: Object.assign({}, st, { results: p.withResults ? st.results : undefined, manualQueue: manual.length }) };
      }
      const list = eng.listCampaigns().map((c) => Object.assign({}, c, { results: undefined }));
      return { ok: true, result: { channel: ch, campaigns: list } };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  async function getCampaignRecipients(payload) {
    const p = payload || {};
    const ch = String(p.channel || 'WHATSAPP').toUpperCase();
    const tenant = sessionTenant(p);
    try {
      const entry = ch === 'TELEGRAM' ? tgEntry(tenant) : waEntry(tenant);
      if (!entry || !entry.campaignEngine || typeof entry.campaignEngine.getRecipients !== 'function') return { ok: false, error: 'RUNTIME_MISSING:campaignEngine' };
      const rows = entry.campaignEngine.getRecipients(p.campaignId || undefined);
      return rows ? { ok: true, result: { recipients: rows } } : { ok: false, error: 'CAMPAIGN_NOT_FOUND' };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  async function stopCampaign(payload) {
    const p = payload || {};
    const ch = String(p.channel || 'WHATSAPP').toUpperCase();
    const tenant = sessionTenant(p);
    try {
      const entry = ch === 'TELEGRAM' ? tgEntry(tenant) : waEntry(tenant);
      if (!entry || !entry.campaignEngine) return { ok: false, error: 'RUNTIME_MISSING:campaignEngine' };
      entry.campaignEngine.stop(p.campaignId || undefined);
      return { ok: true };
    } catch (e) { return { ok: false, error: String((e && e.message) || e) }; }
  }

  async function getConnectionStatus(payload) {
    const tenant = sessionTenant(payload);
    const state = (entry) => {
      if (!entry) return { available: false };
      const s = entry.session;
      return { available: true, connected: s && typeof s.isConnected === 'function' ? !!s.isConnected() : null };
    };
    return { ok: true, result: { tenantId: tenant, whatsapp: state(waEntry(tenant)), telegram: state(tgEntry(tenant)) } };
  }

  const registryMod = require(path.join(__dirname, '..', 'action-executor.js'));
  const methods = {
    extractMembers,
    sendCampaign,
    sendMessage,
    getRecentMessages,
    sendMessageVerified,
    listGroups,
    sendToGroups,
    resolveGroups,
    replyComment,
    generateVideo,
    pauseCampaign,
    resumeCampaign,
    getCampaignStatus,
    getCampaignRecipients,
    stopCampaign,
    getConnectionStatus,
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
      const tenantId = m.tenantId || p.tenantId || null;
      // Les métadonnées émises par la file d'exécution sont la source de
      // vérité. Un payload reçu du client ne peut pas changer de compte.
      if (tenantId) p.tenantId = String(tenantId);
      if (!p.engine && m.engine) p.engine = m.engine;
      if (!p.machine && (m.machine || p.engine === 'WHATSAPP_LOCAL')) p.machine = m.machine || 'WHATSAPP_LOCAL';
      const context = { machine: machineTarget(p), tenantId: tenantId && String(tenantId) };
      return callContext.run(context, () => executor.execute(action, p, Object.assign({}, m, tenantId ? { tenantId: String(tenantId) } : {})));
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
