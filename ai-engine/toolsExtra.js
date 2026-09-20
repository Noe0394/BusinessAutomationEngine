// Outils supplémentaires du ToolRegistry (contacts, campagnes, file/planification, CRM, diagnostic,
// notifications, rapports). Chacun est branché sur un service réel ; sans service, il échoue
// honnêtement (RUNTIME_MISSING / OCR_ENGINE_MISSING...) — jamais de faux succès.
const pipeline = require('./contactsPipeline');
const ocrProvider = require('./ocrProvider');
const chatUploads = require('./chatUploads');
const contactCrm = require('./contactCrm');
const messageHistory = require('./messageHistory');
const taskQueue = require('./taskQueue');
const storageAdapter = require('./storageAdapter');
const activityStore = require('./activityStore');
const notifications = require('./notifications');
const continuity = require('./campaignContinuity');
const campaignService = require('./campaignService');
const { launchDraft } = campaignService;

const fail = (code, message, retryable) => ({ ok: false, error: { code, message: message || code, retryable: !!retryable } });
const sanitize = (id) => String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';
const uid = (p) => `${p}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const chan = (c) => String(c || 'WHATSAPP').toUpperCase();

async function readUploadText(tenant, fileId) {
  const meta = await chatUploads.get(tenant, fileId);
  if (!meta) return { error: fail('FILE_NOT_FOUND') };
  if (meta.hasText && meta.text) return { text: meta.text, meta };
  return { meta };
}

async function rowsFromUpload(tenant, fileId) {
  const r = await readUploadText(tenant, fileId);
  if (r.error) return r;
  const XLSX = require('xlsx');
  try {
    let wb;
    if (r.text) wb = XLSX.read(r.text, { type: 'string' });
    else {
      const f = await chatUploads.readFile(tenant, fileId);
      if (!f) return { error: fail('FILE_NOT_FOUND') };
      wb = XLSX.read(f.buffer, { type: 'buffer' });
    }
    return { rows: XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]) };
  } catch (e) { return { error: fail('PARSE_ERROR', e.message) }; }
}

// ---------- brouillons de campagne (persistés) ----------
async function loadDrafts(tenant) { return storageAdapter.get('campaign_drafts', sanitize(tenant), { tenant: sanitize(tenant), drafts: {} }); }
async function saveDrafts(tenant, doc) { return storageAdapter.set('campaign_drafts', sanitize(tenant), doc); }

// Gestionnaires de la file durable (utilisés par le worker) : exécutent réellement l'action.
function queueHandlers(tenant, runtime) {
  return {
    LAUNCH_CAMPAIGN: async (task) => {
      const doc = await loadDrafts(tenant);
      const draft = doc.drafts[task.payload.draftId];
      if (!draft) return { ok: false, error: 'DRAFT_NOT_FOUND', retryable: false };
      const out = await launchDraft(tenant, draft, runtime);
      if (out.ok) { draft.status = 'launched'; draft.launchedAt = Date.now(); draft.startedAt = draft.launchedAt; draft.engineCampaignId = out.result.campaignId || null; await saveDrafts(tenant, doc); }
      return out.ok ? { ok: true, result: out.result } : { ok: false, error: out.error.message, retryable: out.error.retryable };
    },
    SEND_MESSAGE: async (task) => {
      if (!runtime || typeof runtime.sendMessageVerified !== 'function') return { ok: false, error: 'RUNTIME_MISSING', retryable: true };
      const out = await runtime.sendMessageVerified({ channel: task.payload.channel, to: task.payload.to, text: task.payload.text, tenantId: tenant });
      if (out.status === 'SUCCESS') return { ok: true, result: { confirmationId: out.confirmationId } };
      return { ok: false, error: out.error || out.status, retryable: true };
    },
  };
}

const TOOLS = {
  // ================= CONTACTS =================
  parseContacts: {
    description: 'Extrait les contacts (numéro + nom) d\'un texte collé (virgules, points-virgules, retours à la ligne, tirets...) ou d\'un CSV.',
    permission: null, risk: 'READ',
    inputSchema: { text: { type: 'string', required: true, description: 'Texte ou CSV à analyser.' } },
    async execute(args) { const list = pipeline.parseContacts(args.text); return { ok: true, result: { count: list.length, contacts: list.slice(0, 200) } }; },
  },
  extractPhoneNumbers: {
    description: 'Extrait uniquement les numéros de téléphone d\'un texte quelconque.',
    permission: null, risk: 'READ',
    inputSchema: { text: { type: 'string', required: true } },
    async execute(args) { const n = pipeline.extractPhoneNumbers(args.text); return { ok: true, result: { count: n.length, numbers: n.slice(0, 500) } }; },
  },
  normalizeContacts: {
    description: 'Normalise des numéros au format international (chiffres seuls). Indicatif pays par défaut : DEFAULT_COUNTRY_CODE ou defaultCountryCode.',
    permission: null, risk: 'READ',
    inputSchema: { text: { type: 'string', required: true }, defaultCountryCode: { type: 'string' } },
    async execute(args) {
      const list = pipeline.normalizeContacts(pipeline.parseContacts(args.text), { defaultCountryCode: args.defaultCountryCode });
      return { ok: true, result: { count: list.length, contacts: list.slice(0, 200).map((c) => ({ name: c.name, normalized: c.normalized, issue: c.normalizeIssue })) } };
    },
  },
  deduplicateContacts: {
    description: 'Retire les doublons d\'une liste de contacts (texte) après normalisation.',
    permission: null, risk: 'READ',
    inputSchema: { text: { type: 'string', required: true }, defaultCountryCode: { type: 'string' } },
    async execute(args) {
      const { unique, duplicates } = pipeline.deduplicateContacts(pipeline.normalizeContacts(pipeline.parseContacts(args.text), { defaultCountryCode: args.defaultCountryCode }));
      return { ok: true, result: { unique: unique.length, duplicates: duplicates.length } };
    },
  },
  validateContacts: {
    description: 'Valide des numéros (longueur, indicatif, suites suspectes) et liste les invalides avec la raison.',
    permission: null, risk: 'READ',
    inputSchema: { text: { type: 'string', required: true }, defaultCountryCode: { type: 'string' } },
    async execute(args) {
      const { valid, invalid } = pipeline.validateContacts(pipeline.normalizeContacts(pipeline.parseContacts(args.text), { defaultCountryCode: args.defaultCountryCode }));
      return { ok: true, result: { valid: valid.length, invalid: invalid.length, invalidList: invalid.slice(0, 50).map((c) => ({ raw: c.phone, reason: c.reason })) } };
    },
  },
  prepareContactsFromSource: {
    description: 'Pipeline complet (lecture -> normalisation -> doublons -> validation -> destinataires) depuis un texte collé OU un fichier joint (Excel/CSV, fileId). Renvoie un rapport réel (valides, doublons, invalides, incertains) et un identifiant de liste (recipientsDraftId) utilisable pour créer une campagne.',
    permission: null, risk: 'LOW_WRITE',
    inputSchema: { text: { type: 'string' }, fileId: { type: 'string' }, defaultCountryCode: { type: 'string' } },
    async execute(args, ctx) {
      let src = { text: args.text };
      if (!args.text && args.fileId) {
        const r = await rowsFromUpload(ctx.tenant, args.fileId);
        if (r.error) return r.error;
        src = { rows: r.rows };
      }
      try {
        const out = await campaignService.prepareRecipients(ctx.tenant, src, { defaultCountryCode: args.defaultCountryCode });
        const c = out.counts;
        return { ok: true, result: { recipientsDraftId: out.recipientsId, report: { parsed: c.total, duplicates: c.duplicate, invalid: c.invalid, uncertain: c.uncertain, valid: c.valid }, invalidSample: out.rows.filter((r) => r.state !== 'valid' && r.state !== 'duplicate').slice(0, 10).map((r) => ({ raw: r.raw, reason: r.reason })) } };
      } catch (e) { return fail(e.code || 'PREPARE_FAILED', e.message); }
    },
  },
  extractNumbersFromImage: {
    description: 'Extrait les numéros de téléphone d’une photo jointe (OCR déterministe). Les valeurs incertaines sont marquées « incertain » (jamais devinées) et exclues de l’envoi.',
    permission: null, risk: 'LOW_WRITE',
    inputSchema: { fileId: { type: 'string', required: true }, defaultCountryCode: { type: 'string' } },
    async execute(args, ctx) {
      const f = await chatUploads.readFile(ctx.tenant, args.fileId).catch(() => null);
      if (!f) return fail('FILE_NOT_FOUND');
      try {
        const out = await campaignService.prepareRecipients(ctx.tenant, { image: f.buffer }, { ocr: ctx.ocr || ocrProvider, defaultCountryCode: args.defaultCountryCode });
        const c = out.counts;
        return { ok: true, result: { recipientsDraftId: out.recipientsId, report: { parsed: c.total, duplicates: c.duplicate, invalid: c.invalid, uncertain: c.uncertain, valid: c.valid }, needsReview: out.rows.filter((r) => r.state === 'uncertain').map((r) => r.number) } };
      } catch (e) { return fail(e.code || 'OCR_FAILED', e.message); }
    },
  },

  // ================= CAMPAGNES =================
  createCampaignDraft: {
    description: 'Crée/configure une campagne (brouillon) : canal, destinataires issus de prepareContactsFromSource, message, média joint facultatif, programmation facultative. N’envoie rien. Elle apparaît dans l’onglet Campagnes.',
    permission: null, risk: 'LOW_WRITE',
    inputSchema: {
      recipientsDraftId: { type: 'string', required: true }, text: { type: 'string', required: true },
      channel: { type: 'string' }, name: { type: 'string' }, mediaFileId: { type: 'string' }, includeOptOut: { type: 'boolean', description: 'true pour inclure aussi les contacts qui avaient demandé l’arrêt (sur ordre explicite de l’utilisateur).' },
    },
    async execute(args, ctx) {
      try {
        const c = await campaignService.createCampaign(ctx.tenant, { recipientsId: args.recipientsDraftId, text: args.text, channel: args.channel, name: args.name || `Campagne ${new Date().toISOString().slice(0, 16)}`, mediaFileId: args.mediaFileId, includeOptOut: args.includeOptOut === true }, ctx.allowedModules);
        return { ok: true, result: { draftId: c.id, channel: c.channel, recipients: c.recipients ? c.recipients.valid : null, hasMedia: c.hasMedia } };
      } catch (e) { return fail(e.code === 'RECIPIENTS_NOT_FOUND' ? 'DRAFT_NOT_FOUND' : (e.code || 'CREATE_FAILED'), e.message); }
    },
  },
  launchCampaign: {
    description: 'Lance réellement une campagne (moteur de campagne existant : cadence, protections anti-blocage, reprise conservées). Action sensible : nécessite confirmation.',
    permission: 'messages:send', risk: 'WRITE',
    inputSchema: { draftId: { type: 'string', required: true } },
    async prepare(args, ctx) {
      const doc = await loadDrafts(ctx.tenant);
      const d = doc.drafts[args.draftId];
      if (!d || d.kind !== 'campaign') return { ok: false, preview: {}, warnings: ['DRAFT_NOT_FOUND'] };
      const opt = d.includeOptOut ? new Set() : await contactCrm.optedOutSet(ctx.tenant, d.channel);
      const excluded = d.recipients.filter((r) => opt.has(contactCrm.identityOf(r.telephone))).length;
      return { ok: true, preview: { channel: d.channel, recipients: d.recipients.length - excluded, excludedOptOut: excluded, text: d.text.slice(0, 300), media: !!d.mediaFileId }, warnings: d.status === 'launched' ? ['DEJA_LANCEE'] : [] };
    },
    async execute(args, ctx) {
      try {
        const c = await campaignService.launch(ctx.tenant, args.draftId, ctx.runtime, ctx.allowedModules);
        return { ok: true, result: { status: 'started', campaignId: c.engineCampaignId, recipients: c.recipients ? c.recipients.valid : null } };
      } catch (e) { return fail(e.code === 'INVALID_STATE' ? 'ALREADY_LAUNCHED' : (e.code === 'NOT_FOUND' ? 'DRAFT_NOT_FOUND' : (e.code || 'LAUNCH_FAILED')), e.message); }
    },
    async verify(result) { return { verified: !!result && result.status === 'started' }; },
  },
  scheduleCampaign: {
    description: 'Programme le lancement d’une campagne à une date/heure (ISO). La file durable la lancera même si l’interface est fermée.',
    permission: 'messages:send', risk: 'WRITE',
    inputSchema: { draftId: { type: 'string', required: true }, at: { type: 'string', required: true, description: 'Date/heure ISO 8601 (ex. 2026-09-21T18:00:00Z).' } },
    async execute(args, ctx) {
      try {
        const c = await campaignService.schedule(ctx.tenant, args.draftId, args.at);
        return { ok: true, result: { taskId: c.taskId, runAt: c.runAt, deduplicated: c.deduplicated } };
      } catch (e) { return fail(e.code === 'NOT_FOUND' ? 'DRAFT_NOT_FOUND' : (e.code || 'SCHEDULE_FAILED'), e.message); }
    },
  },
  monitorCampaign: {
    description: 'Suivi réel d’une campagne : état (en cours, protection détectée, mode continuité...), progression, tableau des destinataires.',
    permission: null, risk: 'READ', inputSchema: { campaignId: { type: 'string', required: true } },
    async execute(args, ctx) {
      try { return { ok: true, result: await campaignService.get(ctx.tenant, args.campaignId, ctx.runtime, { limit: 20 }) }; }
      catch (e) { return fail(e.code || 'NOT_FOUND', e.message); }
    },
  },
  getCampaignProgress: {
    description: 'Progression chiffrée d’une campagne (total, envoyés, en attente, échecs, pourcentage).',
    permission: null, risk: 'READ', inputSchema: { campaignId: { type: 'string', required: true } },
    async execute(args, ctx) {
      try { const c = await campaignService.get(ctx.tenant, args.campaignId, ctx.runtime, { limit: 1 }); return { ok: true, result: { state: c.state, progress: c.progress } }; }
      catch (e) { return fail(e.code || 'NOT_FOUND', e.message); }
    },
  },
  listCampaigns: {
    description: 'Liste toutes les campagnes (brouillons, programmées, en cours, terminées) avec leur état réel.',
    permission: null, risk: 'READ', inputSchema: {},
    async execute(args, ctx) { const list = await campaignService.list(ctx.tenant, ctx.runtime); return { ok: true, result: { count: list.length, campaigns: list.slice(0, 50).map((c) => ({ id: c.id, name: c.name, channel: c.channel, state: c.state, progress: c.progress || null })) } }; },
  },
  pauseCampaign: {
    description: 'Met en pause une campagne en cours.', permission: 'messages:send', risk: 'LOW_WRITE',
    inputSchema: { channel: { type: 'string' }, campaignId: { type: 'string' } },
    async execute(args, ctx) {
      if (!ctx.runtime || !ctx.runtime.pauseCampaign) return fail('RUNTIME_MISSING');
      const out = await ctx.runtime.pauseCampaign({ channel: chan(args.channel), campaignId: args.campaignId, tenantId: ctx.tenant });
      return out.ok ? { ok: true, result: { paused: true } } : fail('PAUSE_FAILED', out.error);
    },
  },
  resumeCampaign: {
    description: 'Reprend une campagne en pause.', permission: 'messages:send', risk: 'LOW_WRITE',
    inputSchema: { channel: { type: 'string' }, campaignId: { type: 'string' } },
    async execute(args, ctx) {
      if (!ctx.runtime || !ctx.runtime.resumeCampaign) return fail('RUNTIME_MISSING');
      const out = await ctx.runtime.resumeCampaign({ channel: chan(args.channel), campaignId: args.campaignId, tenantId: ctx.tenant });
      return out.ok ? { ok: true, result: { resumed: true } } : fail('RESUME_FAILED', out.error);
    },
  },
  cancelCampaign: {
    description: 'Annule définitivement une campagne (les destinataires restants ne recevront rien).', permission: 'messages:send', risk: 'SENSITIVE',
    inputSchema: { channel: { type: 'string' }, campaignId: { type: 'string' } },
    async execute(args, ctx) {
      if (!ctx.runtime || !ctx.runtime.stopCampaign) return fail('RUNTIME_MISSING');
      const out = await ctx.runtime.stopCampaign({ channel: chan(args.channel), campaignId: args.campaignId, tenantId: ctx.tenant });
      return out.ok ? { ok: true, result: { cancelled: true } } : fail('CANCEL_FAILED', out.error);
    },
  },
  getCampaignStatus: {
    description: 'Statut réel d\'une campagne (progression, protection réseau, file de continuité manuelle) ou liste des campagnes du canal.',
    permission: null, risk: 'READ',
    inputSchema: { channel: { type: 'string' }, campaignId: { type: 'string' } },
    async execute(args, ctx) {
      if (!ctx.runtime || !ctx.runtime.getCampaignStatus) return fail('RUNTIME_MISSING');
      const out = await ctx.runtime.getCampaignStatus({ channel: chan(args.channel), campaignId: args.campaignId, tenantId: ctx.tenant });
      return out.ok ? { ok: true, result: out.result } : fail('STATUS_FAILED', out.error);
    },
  },
  generateCampaignReport: {
    description: 'Rapport d’une campagne : totaux réels, durée, canal, continuité utilisée, erreurs, et export CSV par destinataire.',
    permission: null, risk: 'READ',
    inputSchema: { campaignId: { type: 'string', required: true } },
    async execute(args, ctx) {
      try { return { ok: true, result: await campaignService.report(ctx.tenant, args.campaignId, ctx.runtime) }; }
      catch (e) { return fail(e.code || 'REPORT_FAILED', e.message); }
    },
  },

  queryMemory: {
    description: 'Interroge la mémoire des 7 derniers jours : dernière discussion avec quelqu’un, ce qu’un client a dit (hier, aujourd’hui…), qui a parlé d’un sujet, combien de personnes ont demandé quelque chose, résumé d’une conversation. Renvoie des faits précis (dates, heures, extraits) et l’étendue réelle de la mémoire.',
    permission: null, risk: 'READ',
    inputSchema: { question: { type: 'string', required: true, description: 'La question, formulée comme l’utilisateur l’a posée.' } },
    async execute(args, ctx) {
      const out = await require('./memoryQuery').answer(ctx.tenant, String(args.question), { llm: ctx.llm });
      return { ok: true, result: { answer: out.text, data: out.data } };
    },
  },

  getAutoReplyStatus: {
    description: 'État réel du répondeur automatique : réglages (toujours actif, pause), sessions WhatsApp/Telegram et tentatives de reconnexion.',
    permission: null, risk: 'READ', inputSchema: {},
    async execute(args, ctx) {
      const autoResponder = require('./autoResponder');
      const settings = await autoResponder.getSettings(ctx.tenant);
      const conn = ctx.runtime && ctx.runtime.getConnectionStatus ? await ctx.runtime.getConnectionStatus({ tenantId: ctx.tenant }) : null;
      return { ok: true, result: { settings, sessions: conn && conn.ok ? conn.result : null, keeper: require('./responderKeeper').status(ctx.tenant) } };
    },
  },
  setAutoReply: {
    description: 'Règle le répondeur automatique : alwaysOn=true (actif en permanence sur WhatsApp et Telegram), paused (pause), whatsapp/telegram, groupReplies.',
    permission: null, risk: 'LOW_WRITE',
    inputSchema: { alwaysOn: { type: 'boolean' }, paused: { type: 'boolean' }, whatsapp: { type: 'boolean' }, telegram: { type: 'boolean' }, groupReplies: { type: 'boolean' } },
    async execute(args, ctx) {
      const patch = {};
      for (const k of ['alwaysOn', 'paused', 'whatsapp', 'telegram', 'groupReplies']) if (typeof args[k] === 'boolean') patch[k] = args[k];
      if (!Object.keys(patch).length) return fail('NOTHING_TO_UPDATE', 'Aucun réglage fourni.');
      const s = await require('./autoResponder').setSettings(ctx.tenant, patch);
      return { ok: true, result: { whatsapp: s.whatsapp, telegram: s.telegram, alwaysOn: !!s.alwaysOn, paused: !!s.paused, groupReplies: !!s.groupReplies } };
    },
  },

  // ================= FILE / PLANIFICATION =================
  getQueueStatus: {
    description: 'État de la file de tâches durable (en attente, en cours, terminées, échouées, bloquées).', permission: null, risk: 'READ', inputSchema: {},
    async execute(args, ctx) { return { ok: true, result: await taskQueue.status(ctx.tenant) }; },
  },
  listTasks: {
    description: 'Liste les tâches planifiées/en file (filtrables par état).', permission: null, risk: 'READ', inputSchema: { state: { type: 'string' } },
    async execute(args, ctx) {
      const tasks = await taskQueue.list(ctx.tenant, { state: args.state });
      return { ok: true, result: { count: tasks.length, tasks: tasks.slice(-50).map((t) => ({ id: t.id, type: t.type, state: t.state, runAt: new Date(t.runAt).toISOString(), attempts: t.attempts, error: t.error })) } };
    },
  },
  cancelTask: {
    description: 'Annule une tâche planifiée non terminée.', permission: null, risk: 'LOW_WRITE', inputSchema: { taskId: { type: 'string', required: true } },
    async execute(args, ctx) { const t = await taskQueue.cancel(ctx.tenant, args.taskId); return t ? { ok: true, result: { cancelled: true } } : fail('TASK_NOT_CANCELLABLE'); },
  },

  // ================= CRM / CLIENTS =================
  createCustomer: {
    description: 'Crée (ou met à jour) un client dans le CRM.', permission: null, risk: 'LOW_WRITE',
    inputSchema: { phone: { type: 'string', required: true }, name: { type: 'string' }, channel: { type: 'string' }, tags: { type: 'array' } },
    async execute(args, ctx) {
      const c = await contactCrm.recordSeen(ctx.tenant, { channel: chan(args.channel), from: args.phone, name: args.name });
      if (Array.isArray(args.tags) && args.tags.length) await contactCrm.addTags(ctx.tenant, chan(args.channel), args.phone, args.tags);
      return { ok: true, result: { key: c.contact.key, isNew: c.isNew } };
    },
  },
  getCustomer: {
    description: 'Fiche client (étiquettes, étape, achats, refus).', permission: null, risk: 'READ',
    inputSchema: { phone: { type: 'string', required: true }, channel: { type: 'string' } },
    async execute(args, ctx) { const c = await contactCrm.getContact(ctx.tenant, chan(args.channel), args.phone); return c ? { ok: true, result: c } : fail('CUSTOMER_NOT_FOUND'); },
  },
  updateCustomer: {
    description: 'Met à jour un client (nom, étape, notes, champs).', permission: null, risk: 'LOW_WRITE',
    inputSchema: { phone: { type: 'string', required: true }, channel: { type: 'string' }, name: { type: 'string' }, stage: { type: 'string' }, notes: { type: 'string' } },
    async execute(args, ctx) { const c = await contactCrm.updateContact(ctx.tenant, chan(args.channel), args.phone, { name: args.name, stage: args.stage, notes: args.notes }); return { ok: true, result: { key: c.key, stage: c.stage } }; },
  },
  deleteCustomer: {
    description: 'Supprime définitivement un client du CRM.', permission: null, risk: 'SENSITIVE',
    inputSchema: { phone: { type: 'string', required: true }, channel: { type: 'string' } },
    async execute(args, ctx) { const ok = await contactCrm.removeContact(ctx.tenant, chan(args.channel), args.phone); return ok ? { ok: true, result: { deleted: true } } : fail('CUSTOMER_NOT_FOUND'); },
  },
  tagCustomer: {
    description: 'Ajoute des étiquettes à un client.', permission: null, risk: 'LOW_WRITE',
    inputSchema: { phone: { type: 'string', required: true }, tags: { type: 'array', required: true }, channel: { type: 'string' } },
    async execute(args, ctx) { const c = await contactCrm.addTags(ctx.tenant, chan(args.channel), args.phone, args.tags); return { ok: true, result: { tags: c.tags } }; },
  },
  getCustomerHistory: {
    description: 'Derniers messages échangés avec un client (fenêtre 7 jours).', permission: null, risk: 'READ',
    inputSchema: { phone: { type: 'string', required: true }, channel: { type: 'string' }, limit: { type: 'number' } },
    async execute(args, ctx) {
      const msgs = await messageHistory.getConversation(ctx.tenant, chan(args.channel), args.phone, Math.min(Number(args.limit) || 20, 50));
      return { ok: true, result: { count: msgs.length, messages: msgs.map((m) => ({ direction: m.direction, text: m.text, at: m.at })) } };
    },
  },
  segmentCustomers: {
    description: 'Segmente les clients par étiquette et/ou étape.', permission: null, risk: 'READ',
    inputSchema: { tag: { type: 'string' }, stage: { type: 'string' }, channel: { type: 'string' } },
    async execute(args, ctx) {
      let items = await contactCrm.list(ctx.tenant, { tag: args.tag, channel: args.channel ? chan(args.channel) : undefined });
      if (args.stage) items = items.filter((c) => c.stage === args.stage);
      return { ok: true, result: { count: items.length, sample: items.slice(0, 20).map((c) => ({ from: c.from, name: c.name, stage: c.stage })) } };
    },
  },

  // ================= DIAGNOSTIC =================
  getSystemStatus: {
    description: 'Diagnostic réel : connexions WhatsApp/Telegram, file de tâches, dernières erreurs. À utiliser pour expliquer pourquoi quelque chose ne fonctionne plus.',
    permission: null, risk: 'READ', inputSchema: {},
    async execute(args, ctx) {
      const conn = ctx.runtime && ctx.runtime.getConnectionStatus ? await ctx.runtime.getConnectionStatus({ tenantId: ctx.tenant }) : null;
      const queue = await taskQueue.status(ctx.tenant);
      const act = await activityStore.summary(null, 60);
      const errors = (act.events || []).filter((a) => a.status === 'error' && (!a.tenant || a.tenant === ctx.tenant)).slice(0, 5);
      const problems = [];
      if (conn && conn.ok) {
        if (conn.result.whatsapp.available && conn.result.whatsapp.connected === false) problems.push('WHATSAPP_DECONNECTE');
        if (conn.result.telegram.available && conn.result.telegram.connected === false) problems.push('TELEGRAM_DECONNECTE');
      } else problems.push('STATUT_CONNEXION_INDISPONIBLE');
      try {
        const rs = await require('./autoResponder').getSettings(ctx.tenant);
        if (!rs.whatsapp && !rs.telegram) problems.push('REPONDEUR_DESACTIVE');
        else if (rs.paused) problems.push('REPONDEUR_EN_PAUSE');
      } catch (e) { /* non bloquant */ }
      if (queue.stuck) problems.push(`TACHES_BLOQUEES:${queue.stuck}`);
      if (queue.overdue) problems.push(`TACHES_EN_RETARD:${queue.overdue}`);
      return { ok: true, result: { connections: conn && conn.result, queue, recentErrors: errors.map((e) => ({ action: e.action, detail: e.detail, at: e.ts })), problems } };
    },
  },

  // ================= MÉDIAS =================
  getMediaMetadata: {
    description: 'Métadonnées d’un média ou fichier joint (nom, type, taille).', permission: null, risk: 'READ',
    inputSchema: { fileId: { type: 'string', required: true } },
    async execute(args, ctx) { const m = await chatUploads.get(ctx.tenant, args.fileId); return m ? { ok: true, result: { id: m.id, name: m.name, type: m.type, size: m.size, textual: m.textual } } : fail('FILE_NOT_FOUND'); },
  },
  validateMedia: {
    description: 'Vérifie qu’un média est utilisable sur un canal (type et taille : image/vidéo/audio/document).', permission: null, risk: 'READ',
    inputSchema: { fileId: { type: 'string', required: true }, channel: { type: 'string' } },
    async execute(args, ctx) {
      const m = await chatUploads.get(ctx.tenant, args.fileId);
      if (!m) return fail('FILE_NOT_FOUND');
      const limits = { image: 16 * 1024 * 1024, video: 64 * 1024 * 1024, audio: 16 * 1024 * 1024, application: 100 * 1024 * 1024, text: 100 * 1024 * 1024 };
      const kind = String(m.type || '').split('/')[0];
      const max = limits[kind];
      const problems = [];
      if (!max) problems.push('TYPE_NON_SUPPORTE');
      else if (m.size > max) problems.push('TROP_VOLUMINEUX');
      if (chan(args.channel) === 'TELEGRAM' && m.size > 50 * 1024 * 1024) problems.push('TELEGRAM_LIMITE_50MO');
      return { ok: true, result: { valid: !problems.length, problems, kind, size: m.size } };
    },
  },
  attachCampaignMedia: {
    description: 'Attache un média joint à un brouillon de campagne WhatsApp.', permission: null, risk: 'LOW_WRITE',
    inputSchema: { draftId: { type: 'string', required: true }, fileId: { type: 'string', required: true } },
    async execute(args, ctx) {
      const m = await chatUploads.get(ctx.tenant, args.fileId);
      if (!m) return fail('FILE_NOT_FOUND');
      const doc = await loadDrafts(ctx.tenant);
      const d = doc.drafts[args.draftId];
      if (!d || d.kind !== 'campaign') return fail('DRAFT_NOT_FOUND');
      if (d.status === 'launched') return fail('ALREADY_LAUNCHED');
      d.mediaFileId = args.fileId;
      await saveDrafts(ctx.tenant, doc);
      return { ok: true, result: { draftId: d.id, media: m.name } };
    },
  },
  generateStatistics: {
    description: 'Statistiques réelles du jour (messages, réponses automatiques, outils, erreurs) et du CRM (contacts par étiquette).', permission: null, risk: 'READ', inputSchema: {},
    async execute(args, ctx) {
      const act = await activityStore.summary(null, 1);
      const crm = await contactCrm.counts(ctx.tenant);
      return { ok: true, result: { date: act.date, activity: act.counts, contacts: crm } };
    },
  },

  // ================= NOTIFICATIONS =================
  createNotification: {
    description: 'Crée une notification pour le vendeur (visible dans l\'interface).', permission: null, risk: 'LOW_WRITE',
    inputSchema: { title: { type: 'string', required: true }, body: { type: 'string' }, level: { type: 'string' } },
    async execute(args, ctx) { const n = await notifications.create(ctx.tenant, args); return { ok: true, result: { id: n.id } }; },
  },
  getNotifications: {
    description: 'Liste les notifications (non lues par défaut).', permission: null, risk: 'READ', inputSchema: { all: { type: 'boolean' } },
    async execute(args, ctx) { const items = await notifications.list(ctx.tenant, args.all); return { ok: true, result: { count: items.length, items: items.slice(-30) } }; },
  },
  markNotificationRead: {
    description: 'Marque une notification comme lue.', permission: null, risk: 'LOW_WRITE', inputSchema: { id: { type: 'string', required: true } },
    async execute(args, ctx) { return (await notifications.markRead(ctx.tenant, args.id)) ? { ok: true, result: { read: true } } : fail('NOTIFICATION_NOT_FOUND'); },
  },

  // ================= CAMPAGNES D'ENTRÉE FACEBOOK ADS (Service Métier) =================
  configureFacebookAdCampaign: {
    description: 'Crée ou met à jour, dans un SERVICE MÉTIER, une campagne Facebook Ads : période, produit, critères d\'entrée (message d\'entrée + variantes, identifiants/liens d\'annonce), MESSAGE INITIAL EXACT envoyé aux nouveaux contacts, règles de continuation, statut. Le message initial n\'est jamais reformulé.',
    permission: null, risk: 'LOW_WRITE',
    inputSchema: {
      initialMessage: { type: 'string', required: true, description: 'Texte EXACT à envoyer au nouveau contact (conservé tel quel).' },
      name: { type: 'string', description: 'Nom de la campagne / publication.' },
      serviceName: { type: 'string', description: 'Service métier concerné (créé s\'il n\'existe pas et createService=true).' },
      productName: { type: 'string' }, startDate: { type: 'string', description: 'AAAA-MM-JJ' }, endDate: { type: 'string', description: 'AAAA-MM-JJ' },
      entryMessages: { type: 'string', description: 'Messages d\'entrée reconnus (séparés par « ; » ou retour ligne).' },
      adIds: { type: 'string' }, sourceUrls: { type: 'string' }, refs: { type: 'string' },
      continuationRules: { type: 'string' }, requireAdReferral: { type: 'boolean' }, matchAnyFacebookAd: { type: 'boolean' }, newContactsOnly: { type: 'boolean' },
      createService: { type: 'boolean' }, status: { type: 'string', description: 'active | inactive' },
    },
    resultSchema: { campaignId: 'string', serviceId: 'string' }, errorSchema: { code: 'string' },
    async execute(args, ctx) {
      const ads = require('./adCampaigns');
      const day = (v, end) => { if (!v) return undefined; const t = Date.parse(String(v).length <= 10 ? `${v}T${end ? '23:59:59.999' : '00:00:00'}` : v); return Number.isFinite(t) ? t : undefined; };
      return ads.configure(ctx.tenant, {
        initialMessage: args.initialMessage, name: args.name, serviceName: args.serviceName, productName: args.productName,
        startAt: day(args.startDate, false), endAt: day(args.endDate, true), entryMessages: args.entryMessages, adIds: args.adIds, sourceUrls: args.sourceUrls, refs: args.refs,
        continuationRules: args.continuationRules, requireAdReferral: args.requireAdReferral, matchAnyFacebookAd: args.matchAnyFacebookAd,
        newContactsOnly: args.newContactsOnly, createService: args.createService, status: args.status,
      });
    },
  },
  listFacebookAdCampaigns: {
    description: 'Liste les campagnes Facebook Ads configurées (service, période, statut réel ACTIVE/EXPIRED/INACTIVE, message initial).',
    permission: null, risk: 'READ', inputSchema: {},
    async execute(args, ctx) {
      const ads = require('./adCampaigns');
      const all = await ads.listAll(ctx.tenant);
      return { ok: true, result: { count: all.length, campaigns: all.map((c) => ({ id: c.id, name: c.name, service: c.serviceName, product: c.productName, status: ads.statusOf(c), startAt: c.startAt, endAt: c.endAt, initialMessage: c.initialMessage, entryMessages: c.criteria.entryMessages })) } };
    },
  },
  setFacebookAdCampaignStatus: {
    description: 'Active ou désactive une campagne Facebook Ads (par nom ou identifiant).',
    permission: null, risk: 'LOW_WRITE', inputSchema: { campaign: { type: 'string', required: true }, active: { type: 'boolean', required: true } },
    async execute(args, ctx) { return require('./adCampaigns').setStatus(ctx.tenant, args.campaign, args.active === true); },
  },

  // ================= CAMPAGNES DE GROUPES ADMINISTRÉS (Service Métier + scheduler) =================
  createGroupCampaign: {
    description: 'Crée une campagne programmée qui cible TOUS les groupes WhatsApp dont le nom contient un mot-clé ET où le compte connecté est réellement administrateur : durée, horaires multiples, messages fournis, service/produit concerné, objectif. La liste des groupes est figée avec leurs vrais noms. Les membres intéressés reçoivent en privé l\'offre du Service métier.',
    permission: null, risk: 'WRITE',
    inputSchema: {
      keyword: { type: 'string', required: true, description: 'Mot-clé contenu dans le NOM des groupes.' },
      days: { type: 'number', required: true, description: 'Durée en jours.' },
      times: { type: 'string', required: true, description: 'Horaires HH:MM séparés par des virgules (ex. 08:00,12:00,18:00).' },
      messages: { type: 'string', required: true, description: 'Messages fournis, séparés par une ligne « ||| » (1 message = pour tous les horaires ; autant que d\'horaires = un par horaire).' },
      serviceName: { type: 'string' }, productName: { type: 'string' }, courseId: { type: 'string' }, name: { type: 'string' },
      goalAmount: { type: 'number' }, goalCurrency: { type: 'string' }, goalPeriod: { type: 'string' }, createService: { type: 'boolean' },
    },
    resultSchema: { campaignId: 'string' }, errorSchema: { code: 'string' },
    async execute(args, ctx) {
      const gc = require('./groupCampaigns'); const parser = require('./groupCampaignParser');
      const times = String(args.times || '').split(/[,;\s]+/).map((t) => t.trim()).filter((t) => /^\d{1,2}:\d{2}$/.test(t)).map((t) => t.padStart(5, '0')).sort();
      const messages = String(args.messages || '').split(/\n?\|\|\|\n?/).map((m) => m.trim()).filter(Boolean);
      const slots = parser.assignMessages(times, messages);
      const target = await gc.resolveTargets(ctx.tenant, args.keyword, ctx.runtime, 'WHATSAPP');
      if (!target.ok) return fail(target.error === 'NOT_CONNECTED' ? 'WHATSAPP_NOT_CONNECTED' : target.error, target.error === 'NOT_CONNECTED' ? 'WhatsApp n\'est pas connecté.' : undefined, true);
      if (!target.groups.length) return { ok: false, error: { code: 'NO_ADMIN_GROUP', message: target.notAdmin.length ? `Des groupes correspondent mais tu n'y es pas administrateur : ${target.notAdmin.join(', ')}.` : `Aucun groupe ne contient « ${args.keyword} » (${target.total} groupe(s) au total).`, notAdmin: target.notAdmin } };
      const r = await gc.create(ctx.tenant, {
        keyword: args.keyword, groups: target.groups, days: args.days, slots, name: args.name, serviceName: args.serviceName, productName: args.productName,
        courseId: args.courseId, createService: args.createService, goal: args.goalAmount ? { amount: Number(args.goalAmount), currency: args.goalCurrency || 'FCFA', period: args.goalPeriod || null } : null,
      });
      if (r.ok) r.result.notAdmin = target.notAdmin;
      return r;
    },
  },
  listGroupCampaigns: {
    description: 'Liste les campagnes de groupes (statut, groupes ciblés, horaires, messages envoyés).', permission: null, risk: 'READ', inputSchema: {},
    async execute(args, ctx) { const all = await require('./groupCampaigns').list(ctx.tenant); return { ok: true, result: { count: all.length, campaigns: all.map((c) => ({ id: c.id, name: c.name, status: c.status, groups: c.groups.map((g) => g.name), slots: c.slots.map((s) => s.time), endAt: c.endAt, sent: c.sends.filter((x) => x.ok).length })) } }; },
  },
  stopGroupCampaign: {
    description: 'Arrête une campagne de groupes (par nom ou identifiant).', permission: null, risk: 'LOW_WRITE', inputSchema: { campaign: { type: 'string' } },
    async execute(args, ctx) { return require('./groupCampaigns').stop(ctx.tenant, args.campaign); },
  },
  setGroupCampaignGoal: {
    description: 'Définit l\'objectif commercial d\'une campagne de groupes (ex. 1 000 000 FCFA sur le mois).', permission: null, risk: 'LOW_WRITE',
    inputSchema: { amount: { type: 'number', required: true }, currency: { type: 'string' }, period: { type: 'string' }, campaign: { type: 'string' } },
    async execute(args, ctx) { return require('./groupCampaigns').setGoal(ctx.tenant, args.campaign, { amount: Number(args.amount), currency: args.currency || 'FCFA', period: args.period || null }); },
  },
  getGroupCampaignReport: {
    description: 'Rapport RÉEL d\'une campagne de groupes : messages envoyés par créneau, prospects, preuves reçues, paiements confirmés, progression vers l\'objectif.', permission: null, risk: 'READ',
    inputSchema: { campaign: { type: 'string' } },
    async execute(args, ctx) { return require('./groupCampaigns').report(ctx.tenant, args.campaign); },
  },

  // ================= CONTINUITÉ (protection -> mode assisté) =================
  getCampaignFallback: {
    description: 'Liste les campagnes basculées en mode assisté (protection réseau) avec leur fiche de continuité et la file manuelle restante.',
    permission: null, risk: 'READ', inputSchema: { channel: { type: 'string' } },
    async execute(args, ctx) {
      const list = await continuity.list(ctx.tenant);
      const rows = [];
      for (const fb of list) {
        let manual = null;
        if (ctx.runtime && ctx.runtime.getCampaignStatus && fb.status === 'manual_fallback') {
          const st = await ctx.runtime.getCampaignStatus({ channel: fb.channel, campaignId: fb.parentCampaignId, tenantId: ctx.tenant });
          manual = st.ok ? st.result.manualQueue : null;
        }
        rows.push(Object.assign({}, fb, { manualQueue: manual }));
      }
      return { ok: true, result: { count: rows.length, fallbacks: rows } };
    },
  },
};

module.exports = { TOOLS, queueHandlers, launchDraft };
