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
function channelPermitted(channel, ctx) {
  if (!Array.isArray(ctx && ctx.allowedModules)) return ctx && ctx.allowedModules === null;
  const value = String(channel || '').toLowerCase();
  if (value === 'facebook_page' || value.startsWith('facebook')) return true;
  if (['instagram', 'youtube', 'tiktok'].includes(value)) return ctx.allowedModules.includes('studio_video');
  return ctx.allowedModules.includes(value);
}

async function readUploadText(tenant, fileId) {
  const meta = await chatUploads.get(tenant, fileId);
  if (!meta) return { error: fail('FILE_NOT_FOUND') };
  if (meta.hasText && meta.text) return { text: meta.text, meta };
  return { meta };
}

// Fichier joint -> source de destinataires pour campaignService.prepareRecipients : le binaire ORIGINAL est relu et confié à
// l'extracteur unique (toutes les feuilles, en-têtes détectés, CSV/TSV/VCF/JSON) — le même que celui du Web, de WhatsApp et de
// Telegram. Jamais un parseur de plus.
async function rowsFromUpload(tenant, fileId) {
  const f = await chatUploads.readFile(tenant, fileId).catch(() => null);
  if (!f) return { error: fail('FILE_NOT_FOUND') };
  return { file: { buffer: f.buffer, name: f.meta.name, type: f.meta.type } };
}

// ---------- brouillons de campagne (persistés) ----------
async function loadDrafts(tenant) { return storageAdapter.get('campaign_drafts', sanitize(tenant), { tenant: sanitize(tenant), drafts: {} }); }
async function saveDrafts(tenant, doc) { return storageAdapter.setDurable('campaign_drafts', sanitize(tenant), doc); }

// Gestionnaires de la file durable (utilisés par le worker) : exécutent réellement l'action.
function queueHandlers(tenant, runtime, allowedModules) {
  if (allowedModules === undefined) {
    const authz = require('./authz');
    const principal = authz.currentPrincipal();
    allowedModules = authz.isPrincipal(principal) && (principal.role === 'ADMIN' || principal.tenant === String(tenant))
      ? principal.allowedModules : [];
  }
  return {
    LAUNCH_CAMPAIGN: async (task) => {
      const doc = await loadDrafts(tenant);
      const draft = doc.drafts[task.payload.draftId];
      if (!draft) return { ok: false, error: 'DRAFT_NOT_FOUND', retryable: false };
      const out = await launchDraft(tenant, draft, runtime, allowedModules);
      if (out.ok) { draft.status = 'launched'; draft.launchedAt = Date.now(); draft.startedAt = draft.launchedAt; draft.engineCampaignId = out.result.campaignId || null; await saveDrafts(tenant, doc); }
      return out.ok ? { ok: true, result: out.result } : { ok: false, error: out.error.message, retryable: out.error.retryable };
    },
    // Relance / suivi client : la décision (10 vérifications) est reprise AU MOMENT d'envoyer, jamais à la planification.
    FOLLOW_UP: async (task) => {
      const followUps = await require('./customerLifecycle').listFollowUps(tenant);
      const followUp = followUps.find((item) => item.id === task.payload.followUpId);
      if (!followUp) return { ok: false, error: 'NOT_FOUND', retryable: false };
      if (!channelPermitted(followUp.contact && followUp.contact.channel, { allowedModules })) return { ok: false, error: 'MODULE_NOT_ALLOWED', retryable: false };
      const out = await require('./customerLifecycle').runFollowUp(tenant, task.payload.followUpId, { runtime });
      if (out.ok || out.skipped) return { ok: true, result: { decision: out.decision ? out.decision.action : undefined, skipped: out.skipped } };
      return { ok: false, error: out.error || 'FOLLOW_UP_FAILED', retryable: out.error !== 'NOT_FOUND' };
    },
    SEND_MESSAGE: async (task) => {
      if (!channelPermitted(task.payload.channel, { allowedModules })) return { ok: false, error: 'MODULE_NOT_ALLOWED', retryable: false };
      if (!runtime || typeof runtime.sendMessageVerified !== 'function') return { ok: false, error: 'RUNTIME_MISSING', retryable: true };
      const out = await runtime.sendMessageVerified({ channel: task.payload.channel, to: task.payload.to, text: task.payload.text, tenantId: tenant });
      if (out.status === 'SUCCESS') return { ok: true, result: { confirmationId: out.confirmationId } };
      const error = String(out.error || out.status || 'SEND_FAILED');
      // Retry seulement les refus qui surviennent avant tout envoi. Une
      // erreur réseau après l'appel de la plateforme est ambiguë; la rejouer
      // pourrait envoyer deux fois le même message.
      const definitelyNotSent = error === 'NOT_CONNECTED' || error === 'MISSING_RECIPIENT' || error.startsWith('RUNTIME_MISSING');
      return { ok: false, error, retryable: definitelyNotSent };
    },
  };
}

const TOOLS = {
  getRecentMessages: {
    feature: 'conversations_messaging', capabilities: ['read', 'search', 'inbox'],
    description: 'Lit les derniers messages réellement reçus sur WhatsApp ou Telegram avec expéditeur, contenu, date et état de connexion. Outil de consultation; ne répond ni n’envoie de message.',
    permission: null, risk: 'READ',
    inputSchema: { channel: { type: 'string', required: true, description: 'WHATSAPP ou TELEGRAM.' }, limit: { type: 'number', description: 'Nombre maximal de messages (1–100).' } },
    async execute(args, ctx) {
      const executor = ctx.runtime && ctx.runtime.actionExecutor;
      if (!executor || typeof executor.execute !== 'function') return fail('RUNTIME_MISSING:READ_RECENT_MESSAGES');
      const out = await executor.execute('READ_RECENT_MESSAGES', { channel: chan(args.channel), limit: Math.max(1, Math.min(100, Number(args.limit) || 10)), tenantId: ctx.tenant }, { tenantId: ctx.tenant });
      if (!out || out.ok !== true) return fail(out && out.error || 'READ_RECENT_MESSAGES_FAILED');
      return { ok: true, result: out.result || null };
    },
    async verify(result) { return { verified: !!result && typeof result.connected === 'boolean' && (result.connected === false || Array.isArray(result.messages)) }; },
  },
  listMyContacts: {
    feature: 'contacts_crm', capabilities: ['list', 'search', 'count', 'filter'],
    description: 'Recherche dans les contacts réels du CRM Cyrus et renvoie leurs noms, numéros, étiquettes et achats enregistrés. Filtres facultatifs par étiquette, canal ou nom/numéro.',
    permission: null, risk: 'READ',
    inputSchema: { tag: { type: 'string' }, channel: { type: 'string' }, query: { type: 'string' }, limit: { type: 'number' } },
    async execute(args, ctx) {
      const counts = await contactCrm.counts(ctx.tenant);
      let contacts = await contactCrm.list(ctx.tenant, { tag: args.tag, channel: args.channel && chan(args.channel) });
      if (args.query) {
        const q = String(args.query).toLowerCase();
        contacts = contacts.filter((c) => `${c.name || ''} ${c.from || ''} ${(c.tags || []).join(' ')}`.toLowerCase().includes(q));
      }
      const limit = Math.max(1, Math.min(500, Number(args.limit) || 100));
      return { ok: true, result: { count: contacts.length, totalInCrm: counts.total || 0, byTag: counts.byTag || {}, truncated: contacts.length > limit, contacts: contacts.slice(0, limit) } };
    },
    async verify(result) { return { verified: !!result && Array.isArray(result.contacts) && Number.isFinite(result.count) }; },
  },
  // ================= FORMATIONS : base de connaissances pédagogique (accompagnement des apprenants) =================
  ingestCourse: {
    description: 'Ajoute du contenu à la base de connaissances d\'une FORMATION (créée si nécessaire) à partir d\'un fichier joint (PDF, DOCX, texte, Excel, audio/vidéo transcrits) via fileId, ou d\'un texte : structure module → chapitre → leçon détectée, indexation pour la recherche ciblée. category : official (contenu officiel, défaut), complementary (connaissances complémentaires), faq (questions fréquentes validées), internal (notes internes, jamais montrées aux apprenants). Peut lier la formation à un Service métier (serviceId).',
    permission: null, risk: 'LOW_WRITE',
    confirmWhenTainted: (a) => !a || !a.category || a.category === 'official', // le contenu officiel ne change pas sur la foi d'un fichier sans confirmation du propriétaire
    inputSchema: { course: { type: 'string', required: true, description: 'Nom de la formation.' }, fileId: { type: 'string', description: 'Support joint (f_xxx).' }, text: { type: 'string', description: 'Contenu en texte.' }, category: { type: 'string', description: 'official | complementary | faq | internal' }, serviceId: { type: 'string', description: 'Service métier à lier.' }, description: { type: 'string' } },
    async execute(args, ctx) {
      const ck = require('./courseKnowledge');
      try {
        if (args.serviceId || args.description) await ck.createCourse(ctx.tenant, { name: args.course, serviceId: args.serviceId, description: args.description });
        let text = args.text; let name = 'saisie'; let fileId = null;
        if (args.fileId) {
          const f = await chatUploads.readFile(ctx.tenant, args.fileId); if (!f) return fail('FILE_NOT_FOUND');
          const ext = await require('./mediaPipeline').extractFullText({ buffer: f.buffer, mimetype: f.meta.type, filename: f.meta.name });
          if (!ext.ok) return fail(ext.error || 'EXTRACTION_FAILED', 'Le support n\'a pas pu être lu : aucun contenu n\'a été ajouté.');
          text = ext.text; name = f.meta.name; fileId = f.meta.id;
        }
        if (!text) return fail('NO_CONTENT', 'Fournissez un fichier ou un texte.');
        const r = await ck.ingest(ctx.tenant, args.course, { text }, { category: args.category || 'official', sourceName: name, fileId });
        return { ok: true, result: r };
      } catch (e) { return fail(e.code || 'INGEST_FAILED', e.message); }
    },
    async verify(result) { return { verified: !!(result && result.chunks > 0) }; },
  },
  listCourses: {
    description: 'Liste les formations connues (modules, nombre d\'extraits officiels/FAQ/compléments/notes internes, Service métier et groupes liés).',
    permission: null, risk: 'READ', inputSchema: {},
    async execute(args, ctx) { const list = await require('./courseKnowledge').listCourses(ctx.tenant); return { ok: true, result: { total: list.length, courses: list } }; },
  },
  searchCourse: {
    description: 'Recherche CIBLÉE dans la base de connaissances des formations (extraits pertinents avec leur chemin module › chapitre › leçon et leur source). Pour répondre à une question de contenu, résumer un chapitre, vérifier une recette.',
    permission: null, risk: 'READ',
    inputSchema: { query: { type: 'string', required: true }, course: { type: 'string', description: 'Nom de la formation (facultatif).' }, includeInternal: { type: 'boolean' } },
    async execute(args, ctx) {
      const ck = require('./courseKnowledge');
      const c = args.course ? await ck.findCourse(ctx.tenant, args.course) : null;
      const owner = args.includeInternal === true || args.includeInternal === 'true';
      const hits = await ck.search(ctx.tenant, args.query, { courseId: c && c.id, limit: 6, audience: owner ? 'owner' : 'learner', categories: owner ? ck.CATEGORIES : undefined });
      return { ok: true, result: { found: hits.length, extracts: hits.map((h) => ({ path: h.path, category: h.category, source: h.source, text: h.text.slice(0, 700), score: h.score })) } };
    },
  },
  linkCourse: {
    description: 'Lie une formation à un Service métier et/ou à un GROUPE (WhatsApp/Telegram) : dans ce groupe, Cyrus répondra aux questions de formation (autoAnswer). groupName ou groupId pour le groupe.',
    permission: null, risk: 'LOW_WRITE',
    inputSchema: { course: { type: 'string', required: true }, serviceId: { type: 'string' }, channel: { type: 'string', description: 'WHATSAPP (défaut) ou TELEGRAM.' }, groupId: { type: 'string' }, groupName: { type: 'string' }, autoAnswer: { type: 'boolean', description: 'false pour lier sans réponses automatiques.' } },
    async execute(args, ctx) {
      const ck = require('./courseKnowledge'); const channel = chan(args.channel);
      try {
        if (args.serviceId) await ck.linkService(ctx.tenant, args.course, args.serviceId);
        let groupId = args.groupId; let groupName = args.groupName;
        if (!groupId && groupName) {
          const mgr = channel === 'TELEGRAM' ? require('../adapters/telegramManager') : require('../adapters/whatsappManager');
          const session = mgr.getOrCreate(ctx.tenant).session;
          const list = session && typeof session.getGroupsSummary === 'function' ? await session.getGroupsSummary() : [];
          const q = String(groupName).toLowerCase(); const hits = list.filter((g) => String(g.name).toLowerCase().includes(q));
          if (hits.length !== 1) return fail(hits.length ? 'GROUP_AMBIGUOUS' : 'GROUP_NOT_FOUND', hits.length ? 'Plusieurs groupes correspondent : précisez le nom complet.' : 'Aucun groupe de ce nom sur le compte connecté.');
          groupId = String(hits[0].id); groupName = hits[0].name;
        }
        let course;
        if (groupId) course = await ck.linkGroup(ctx.tenant, args.course, { channel, id: groupId, name: groupName, autoAnswer: !(args.autoAnswer === false || args.autoAnswer === 'false') });
        else course = await ck.findCourse(ctx.tenant, args.course);
        if (!course) return fail('COURSE_NOT_FOUND');
        return { ok: true, result: { course: course.name, serviceId: course.serviceId || null, groups: course.groups || [] } };
      } catch (e) { return fail(e.code || 'LINK_FAILED', e.message); }
    },
  },
  listFaqCandidates: {
    description: 'Questions d\'apprenants qui reviennent souvent (candidates de FAQ, NON validées). Le contenu officiel n\'est jamais modifié automatiquement.',
    permission: null, risk: 'READ', inputSchema: { min: { type: 'number' } },
    async execute(args, ctx) { const list = await require('./courseKnowledge').faqCandidates(ctx.tenant, { min: args.min }); return { ok: true, result: { total: list.length, candidates: list.map((e) => ({ id: e.id, question: e.question, count: e.count, answeredFromCourse: e.answeredFromCourse })) } }; },
  },
  promoteFaq: {
    description: 'Valide une question fréquente en FAQ officielle de la formation, avec la réponse fournie par le propriétaire (action explicite).',
    permission: null, risk: 'LOW_WRITE',
    inputSchema: { id: { type: 'string', required: true }, answer: { type: 'string', required: true } },
    async execute(args, ctx) { try { return { ok: true, result: await require('./courseKnowledge').promoteFaq(ctx.tenant, String(args.id), args.answer) }; } catch (e) { return fail(e.code || 'PROMOTE_FAILED', e.message); } },
  },

  // ================= COMMUNAUTÉS (création/invitation de groupes, découverte) =================
  createCommunityGroup: {
    description: 'Crée un groupe WhatsApp ou Telegram avec un nom et une liste de contacts (fichier Excel/CSV joint via fileId, liste préparée via recipientsDraftId, ou texte collé) : ajoute les participants dans le respect de leur confidentialité et, pour ceux qui ont restreint l\'ajout direct, envoie AUTOMATIQUEMENT le lien d\'invitation officiel en message privé. Le traitement continue en arrière-plan ; suivi via getCommunityGroupStatus. Action sensible : confirmation.',
    permission: 'messages:send', risk: 'WRITE',
    inputSchema: {
      channel: { type: 'string', description: 'WHATSAPP (défaut) ou TELEGRAM.' }, title: { type: 'string', required: true, description: 'Nom du groupe.' },
      description: { type: 'string' }, fileId: { type: 'string', description: 'Fichier de contacts joint (Excel/CSV/image OCR), ex. f_xxx.' },
      recipientsDraftId: { type: 'string', description: 'Liste déjà préparée par prepareContactsFromSource.' }, text: { type: 'string', description: 'Contacts collés en texte.' },
      inviteMessage: { type: 'string', description: 'Message d\'invitation (variables {nom} {groupe} {lien}).' },
      batchSize: { type: 'number', description: 'Nombre de personnes par lot avant une pause (défaut : cadence de sécurité standard).' },
      delayBetweenItems: { type: 'number', description: 'Délai en millisecondes entre deux personnes (ex. « 10 secondes » → 10000).' },
      delayBetweenBatches: { type: 'number', description: 'Délai en millisecondes entre deux lots (ex. « 2 minutes » → 120000).' },
      pauseEveryNBatches: { type: 'number', description: 'Pause plus longue toutes les N lots (0 = désactivé).' },
      pauseDuration: { type: 'number', description: 'Durée en millisecondes de cette pause plus longue.' },
      initialDelay: { type: 'number', description: 'Délai en millisecondes avant le tout premier ajout.' },
      maxItems: { type: 'number', description: 'Nombre maximal de personnes traitées pour cette reprise (le reste attend la reprise suivante).' },
    },
    async prepare(args, ctx) {
      let count = null;
      try {
        if (args.recipientsDraftId) { const d = (await storageAdapter.get('campaign_drafts', sanitize(ctx.tenant), { drafts: {} })).drafts[args.recipientsDraftId]; count = d && d.rows ? d.rows.filter((r) => r.state === 'valid').length : null; }
        else if (args.fileId) { const f = await chatUploads.readFile(ctx.tenant, args.fileId); if (f) count = require('./contactExtractor').extractFromFile({ buffer: f.buffer, name: f.meta.name, type: f.meta.type }).entries.length; }
        else if (args.text) count = require('./contactExtractor').extractFromText(args.text, 'texte').length;
      } catch (e) { count = null; }
      return { ok: !!args.title, preview: { channel: chan(args.channel), title: String(args.title || '').slice(0, 100), contactsDetectes: count, regle: 'Ajout direct seulement si la confidentialité le permet ; sinon lien d\'invitation en message privé. Cadence lente, pause automatique en cas de limitation.' }, warnings: count === 0 ? ['AUCUN_CONTACT_DETECTE'] : [] };
    },
    async execute(args, ctx) {
      const input = { channel: chan(args.channel), title: args.title, description: args.description, inviteMessage: args.inviteMessage };
      if (!channelPermitted(input.channel, ctx)) return fail('MODULE_NOT_ALLOWED');
      const timing = {}; for (const k of ['batchSize', 'delayBetweenItems', 'delayBetweenBatches', 'pauseEveryNBatches', 'pauseDuration', 'initialDelay', 'maxItems']) if (args[k] !== undefined) timing[k] = args[k];
      if (Object.keys(timing).length) input.timing = timing;
      if (args.recipientsDraftId) input.recipientsId = args.recipientsDraftId;
      else if (args.fileId) {
        const f = await chatUploads.readFile(ctx.tenant, args.fileId); if (!f) return fail('FILE_NOT_FOUND');
        if (/^image\//.test(f.meta.type || '')) input.image = f.buffer; else input.file = { buffer: f.buffer, name: f.meta.name, type: f.meta.type };
      } else if (args.text) input.text = args.text;
      else return fail('NO_RECIPIENTS', 'Fournissez un fichier, une liste préparée ou des contacts en texte.');
      try { const job = await require('./communityService').startGroup(ctx.tenant, input, ctx.allowedModules); return { ok: true, result: { jobId: job.id, status: job.status, channel: job.channel, title: job.title, total: job.counts.total } }; }
      catch (e) { return fail(e.code || 'GROUP_START_FAILED', e.message); }
    },
    async verify(result) { return { verified: !!(result && result.jobId) }; },
  },
  listMyCommunityGroups: {
    feature: 'communities', capabilities: ['list', 'search', 'select-existing-group'],
    description: 'Liste les groupes réellement accessibles sur le compte WhatsApp ou Telegram connecté, avec leur identifiant de plateforme, nom, nombre de membres et droits admin. Pour sélectionner un groupe existant ou « mes groupes ». Ne confond pas avec les groupes publics enregistrés dans le CRM.',
    permission: null, risk: 'READ',
    inputSchema: { channel: { type: 'string', description: 'WHATSAPP ou TELEGRAM (WhatsApp par défaut).' }, query: { type: 'string', description: 'Filtre facultatif sur le nom.' }, limit: { type: 'number', description: 'Nombre maximal de groupes à retourner (1–500).' } },
    async execute(args, ctx) {
      try {
        const channel = chan(args.channel);
        const groups = await require('./communityService').listExistingGroups(ctx.tenant, channel, args.query);
        // Pour une recherche ciblée, joindre seulement les liens réellement
        // retournés par WhatsApp (jamais reconstruits depuis un ID de groupe).
        if (channel === 'WHATSAPP' && args.query && groups.length <= 5) {
          const session = require('../adapters/whatsappManager').getOrCreate(ctx.tenant).session;
          if (session && typeof session.getGroupInviteLink === 'function') {
            for (const group of groups) {
              try { const link = await session.getGroupInviteLink(group.id); if (link) group.link = String(link); } catch (e) { /* lien facultatif */ }
            }
          }
        }
        const limit = Math.max(1, Math.min(500, Number(args.limit) || 100));
        return { ok: true, result: { total: groups.length, truncated: groups.length > limit, groups: groups.slice(0, limit) } };
      } catch (e) { return fail(e.code || 'GROUP_LIST_FAILED', e.message); }
    },
  },
  extractMyCommunityGroupMembers: {
    feature: 'communities', capabilities: ['extract-existing-group-members', 'verified-platform-data'],
    description: 'Extrait les membres réellement visibles dans un groupe WhatsApp/Telegram déjà rejoint (identifiant interne ou nom exact non ambigu). Lecture seulement. WhatsApp ne révèle pas les numéros des membres anonymisés par LID; ceux-ci sont omis.',
    permission: null, risk: 'READ',
    inputSchema: { channel: { type: 'string' }, groupId: { type: 'string' }, groupName: { type: 'string' } },
    async execute(args, ctx) {
      try {
        const svc = require('./communityService');
        const group = await svc.resolveExistingGroup(ctx.tenant, args.channel || 'WHATSAPP', { groupId: args.groupId, groupName: args.groupName, requireAdmin: false });
        const members = await svc.DRIVERS[group.channel](ctx.tenant).membersOf(group.id);
        if (!Array.isArray(members)) return fail('GROUP_EXTRACTION_FAILED', 'La plateforme n’a pas fourni la liste des membres.');
        return { ok: true, result: { group: { id: group.id, name: group.name }, total: members.length, members: members.slice(0, 500) } };
      } catch (e) { return fail(e.code || 'GROUP_EXTRACTION_FAILED', e.message); }
    },
  },
  addMembersToExistingCommunityGroup: {
    feature: 'communities', capabilities: ['add-members-to-existing-group', 'text', 'existing-list', 'cyrus-contacts', 'excel', 'csv', 'group-extraction', 'deduplicate', 'membership-check', 'persisted-progress', 'pause', 'resume', 'stop', 'verify'],
    description: 'Ajoute une liste de contacts à un groupe WHATSAPP/TELEGRAM QUI EXISTE DÉJÀ. Sélectionne le groupe réel par son nom exact (ou son ID de plateforme), puis prend les contacts depuis text, un fichier Excel/CSV/image en pièce jointe (fileId), une liste déjà préparée (recipientsDraftId), le CRM Cyrus (source=crm) ou l’extraction des membres d’un autre groupe (memberSourceGroupId/memberSourceGroupName). Déduplique, vérifie les opt-out et membres déjà présents, persiste la progression et les erreurs dans le moteur Communauté, puis vérifie la liste réelle des membres. N’invente aucun groupe. Confirme immédiatement seulement que le job a démarré; consulte getCommunityGroupStatus pour son résultat final.',
    permission: 'messages:send', risk: 'WRITE',
    inputSchema: {
      channel: { type: 'string', description: 'WHATSAPP par défaut ou TELEGRAM.' },
      groupName: { type: 'string', description: 'Nom exact du groupe existant.' }, groupId: { type: 'string', description: 'ID réel du groupe, si déjà connu.' },
      source: { type: 'string', description: 'crm ou group; le défaut accepte le texte/fichier/liste préparée.' }, crmTag: { type: 'string' },
      memberSourceGroupId: { type: 'string' }, memberSourceGroupName: { type: 'string' },
      recipientsDraftId: { type: 'string' }, fileId: { type: 'string', description: 'ID d’un fichier Excel/CSV/texte/image déjà joint et détenu par ce compte.' },
      text: { type: 'string', description: 'Numéros/@usernames fournis dans le message.' },
    },
    async prepare(args, ctx) {
      const svc = require('./communityService');
      const group = await svc.resolveExistingGroup(ctx.tenant, args.channel || 'WHATSAPP', { groupId: args.groupId, groupName: args.groupName }).catch((e) => ({ name: null, id: null, error: e.message }));
      let contacts = null;
      try {
        if (args.source === 'crm') contacts = (await require('./contactCrm').list(ctx.tenant, { channel: args.channel || 'WHATSAPP', tag: args.crmTag })).length;
        else if (args.text) contacts = require('./contactExtractor').extractFromText(args.text, 'texte').entries.length;
        else if (args.fileId) { const f = await chatUploads.readFile(ctx.tenant, args.fileId); contacts = f && require('./contactExtractor').extractFromFile({ buffer: f.buffer, name: f.meta.name, type: f.meta.type }).entries.length; }
      } catch (e) { contacts = null; }
      return { ok: !!group.id && (contacts == null || contacts > 0), preview: { group: group.name, groupId: group.id, contactsDetectes: contacts, source: args.source || (args.fileId ? 'file' : (args.recipientsDraftId ? 'list' : 'text')) }, warnings: group.error ? [group.error] : (contacts === 0 ? ['AUCUN_CONTACT_DETECTE'] : []) };
    },
    async execute(args, ctx) {
      const channel = chan(args.channel);
      const input = { channel, existingGroupId: args.groupId, groupName: args.groupName, source: args.source, crm: args.source === 'crm', crmTag: args.crmTag, memberSourceGroupId: args.memberSourceGroupId, memberSourceGroupName: args.memberSourceGroupName };
      if (args.recipientsDraftId) input.recipientsId = args.recipientsDraftId;
      else if (args.fileId) {
        const f = await chatUploads.readFile(ctx.tenant, args.fileId); if (!f) return fail('FILE_NOT_FOUND');
        if (/^image\//.test(f.meta.type || '')) input.image = f.buffer; else input.file = { buffer: f.buffer, name: f.meta.name, type: f.meta.type };
      } else if (args.text) input.text = args.text;
      else if (args.source !== 'crm' && args.source !== 'group' && !args.memberSourceGroupId && !args.memberSourceGroupName) return fail('NO_RECIPIENTS', 'Fournissez du texte, une liste préparée, un fichier, les contacts Cyrus ou un groupe source.');
      try {
        const job = await require('./communityService').addMembersToGroup(ctx.tenant, input, ctx.allowedModules);
        return { ok: true, result: { jobId: job.id, operation: job.operation, status: job.status, channel: job.channel, group: job.group, total: job.counts.total, duplicateInput: job.counts.duplicate_input } };
      } catch (e) { return fail(e.code || 'ADD_MEMBERS_FAILED', e.message); }
    },
    async verify(result, args, ctx) {
      if (!result || !result.jobId) return { verified: false };
      const job = await require('./communityService').getJob(ctx.tenant, result.jobId);
      return { verified: !!job && job.operation === 'ADD_TO_EXISTING' && !!job.group && job.group.id === result.group.id && job.title === result.group.subject, jobId: result.jobId, groupId: job && job.group && job.group.id, status: job && job.status };
    },
  },
  configureGroupTiming: {
    description: 'Règle la temporisation (cadence) de la création/alimentation d\'un groupe : taille des lots, délai entre deux personnes, pause entre deux lots, pause plus longue toutes les N lots, délai initial, nombre maximal de personnes par reprise. Le traitement doit être en pause pour changer sa cadence (sinon : « mets d\'abord l\'ajout en pause »).',
    permission: null, risk: 'LOW_WRITE',
    inputSchema: {
      jobId: { type: 'string', required: true }, batchSize: { type: 'number' }, delayBetweenItems: { type: 'number' }, delayBetweenBatches: { type: 'number' },
      pauseEveryNBatches: { type: 'number' }, pauseDuration: { type: 'number' }, initialDelay: { type: 'number' }, maxItems: { type: 'number' }, autoPauseOnError: { type: 'boolean' },
    },
    async execute(args, ctx) {
      const patch = {}; for (const k of ['batchSize', 'delayBetweenItems', 'delayBetweenBatches', 'pauseEveryNBatches', 'pauseDuration', 'initialDelay', 'maxItems', 'autoPauseOnError']) if (args[k] !== undefined) patch[k] = args[k];
      try { const job = await require('./communityService').setTiming(ctx.tenant, args.jobId, patch); return { ok: true, result: { jobId: job.id, timing: job.timing } }; }
      catch (e) { return fail(e.code || 'TIMING_UPDATE_FAILED', e.message); }
    },
    async verify(result, args, ctx) { const j = await require('./communityService').getJob(ctx.tenant, args.jobId); return { verified: !!j && JSON.stringify(j.timing) === JSON.stringify(result.timing) }; },
  },
  getCommunityGroupStatus: {
    description: 'Progression et rapport RÉELS d\'une création de groupe (ajoutés, invitations envoyées en message privé, déjà membres, absents de la plateforme, refus, échecs). Sans jobId : liste des derniers groupes.',
    permission: null, risk: 'READ',
    inputSchema: { jobId: { type: 'string' } },
    async execute(args, ctx) {
      const svc = require('./communityService');
      if (!args.jobId) return { ok: true, result: { groups: (await svc.listJobs(ctx.tenant)).slice(0, 10) } };
      const j = await svc.getJob(ctx.tenant, String(args.jobId)); return j ? { ok: true, result: j } : fail('NOT_FOUND');
    },
  },
  discoverCommunities: {
    description: 'Découvre des groupes/canaux PUBLICS par mots-clés sectoriels. Telegram : recherche globale officielle (canaux/groupes publics + liens). WhatsApp : liens d\'invitation d\'annuaires publics, vérifiés auprès de WhatsApp. Ne rejoint rien. sync=true les enregistre dans le CRM.',
    permission: null, risk: 'READ',
    inputSchema: { channel: { type: 'string', description: 'TELEGRAM ou WHATSAPP.' }, keywords: { type: 'string', required: true, description: 'Mots-clés séparés par des virgules.' }, limit: { type: 'number' }, sync: { type: 'boolean', description: 'true pour enregistrer les résultats dans le CRM.' } },
    async execute(args, ctx) {
      try { const out = await require('./communityDiscovery').discover(ctx.tenant, { channel: args.channel, keywords: args.keywords, limit: args.limit, sync: args.sync === true || args.sync === 'true' }); return { ok: true, result: { channel: out.channel, keywords: out.keywords, total: out.results.length, synced: out.synced, communities: out.results.slice(0, 30) } }; }
      catch (e) { return fail(e.code || 'DISCOVERY_FAILED', e.message); }
    },
  },
  listCommunities: {
    description: 'Liste les communautés (groupes/canaux publics) déjà enregistrées dans le CRM, filtrables par canal ou mot-clé.',
    permission: null, risk: 'READ',
    inputSchema: { channel: { type: 'string' }, keyword: { type: 'string' } },
    async execute(args, ctx) { const items = await contactCrm.listCommunities(ctx.tenant, { channel: args.channel, keyword: args.keyword }); return { ok: true, result: { total: items.length, communities: items.slice(0, 40) } }; },
  },

  // ================= SPÉCIALISTES (bibliothèque Agency Agents, sous la tutelle de l'Orchestrateur) =================
  listSpecialists: {
    description: 'Liste les spécialistes internes disponibles (catalogue Agency Agents) avec leur statut pour ce compte ; filtrable par division, capacité ou statut. Consultation seulement.',
    permission: null, risk: 'READ',
    inputSchema: { division: { type: 'string' }, capability: { type: 'string' }, status: { type: 'string', description: 'active | disabled | blocked' }, query: { type: 'string' } },
    async execute(args, ctx) {
      const reg = require('./agents/agentRegistry');
      let items = await reg.list({ tenant: ctx.tenant, division: args.division, capability: args.capability, status: args.status });
      if (args.query) { const q = String(args.query).toLowerCase(); items = items.filter((a) => `${a.agentId} ${a.name} ${a.description}`.toLowerCase().includes(q)); }
      return { ok: true, result: { total: items.length, summary: reg.summary(), specialists: items.slice(0, 40).map((a) => ({ agentId: a.agentId, name: a.name, specialty: a.specialty, capabilities: a.capabilities.slice(0, 6), status: a.status, riskLevel: a.riskLevel, audiences: a.audiences })) } };
    },
  },
  setSpecialistStatus: {
    description: 'Active ou désactive un spécialiste interne POUR CE COMPTE (les agents bloqués ne peuvent pas être activés). À utiliser quand le propriétaire demande de désactiver/réactiver un spécialiste.',
    permission: null, risk: 'LOW_WRITE',
    inputSchema: { agentId: { type: 'string', required: true }, status: { type: 'string', required: true, description: 'active | disabled' } },
    async execute(args, ctx) {
      const out = await require('./agents/agentRegistry').setStatus(String(args.agentId), String(args.status), { tenant: ctx.tenant, by: ctx.principal && ctx.principal.userId });
      return out.ok ? { ok: true, result: out } : { ok: false, error: { code: out.error, message: out.reason || out.error } };
    },
  },

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
        src = { file: r.file };
      }
      try {
        const out = await campaignService.prepareRecipients(ctx.tenant, src, { defaultCountryCode: args.defaultCountryCode, allowedModules: ctx.allowedModules });
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
        const out = await campaignService.prepareRecipients(ctx.tenant, { image: f.buffer }, { ocr: ctx.ocr || ocrProvider, defaultCountryCode: args.defaultCountryCode, allowedModules: ctx.allowedModules });
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
        const c = await campaignService.schedule(ctx.tenant, args.draftId, args.at, ctx.allowedModules);
        return { ok: true, result: { taskId: c.taskId, runAt: c.runAt, deduplicated: c.deduplicated } };
      } catch (e) { return fail(e.code === 'NOT_FOUND' ? 'DRAFT_NOT_FOUND' : (e.code || 'SCHEDULE_FAILED'), e.message); }
    },
  },
  monitorCampaign: {
    description: 'Suivi réel d’une campagne : état (en cours, protection détectée, mode continuité...), progression, tableau des destinataires.',
    permission: null, risk: 'READ', inputSchema: { campaignId: { type: 'string', required: true } },
    async execute(args, ctx) {
      try {
        const campaign = await campaignService.get(ctx.tenant, args.campaignId, ctx.runtime, { limit: 20 }, ctx.allowedModules);
        return { ok: true, result: campaign };
      }
      catch (e) { return fail(e.code || 'NOT_FOUND', e.message); }
    },
  },
  getCampaignProgress: {
    description: 'Progression chiffrée d’une campagne (total, envoyés, en attente, échecs, pourcentage).',
    permission: null, risk: 'READ', inputSchema: { campaignId: { type: 'string', required: true } },
    async execute(args, ctx) {
      try { const c = await campaignService.get(ctx.tenant, args.campaignId, ctx.runtime, { limit: 1 }, ctx.allowedModules); return { ok: true, result: { state: c.state, progress: c.progress } }; }
      catch (e) { return fail(e.code || 'NOT_FOUND', e.message); }
    },
  },
  listCampaigns: {
    description: 'Liste toutes les campagnes (brouillons, programmées, en cours, terminées) avec leur état réel.',
    permission: null, risk: 'READ', inputSchema: {},
    async execute(args, ctx) { const list = await campaignService.list(ctx.tenant, ctx.runtime, ctx.allowedModules); return { ok: true, result: { count: list.length, campaigns: list.slice(0, 50).map((c) => ({ id: c.id, name: c.name, channel: c.channel, state: c.state, progress: c.progress || null })) } }; },
  },
  pauseCampaign: {
    description: 'Met en pause une campagne en cours.', permission: 'messages:send', risk: 'LOW_WRITE',
    inputSchema: { channel: { type: 'string' }, campaignId: { type: 'string' } },
    async execute(args, ctx) {
      if (!ctx.runtime || !ctx.runtime.pauseCampaign) return fail('RUNTIME_MISSING');
      if (!channelPermitted(args.channel, ctx)) return fail('MODULE_NOT_ALLOWED');
      const out = await ctx.runtime.pauseCampaign({ channel: chan(args.channel), campaignId: args.campaignId, tenantId: ctx.tenant });
      return out.ok ? { ok: true, result: { paused: true } } : fail('PAUSE_FAILED', out.error);
    },
  },
  resumeCampaign: {
    description: 'Reprend une campagne en pause.', permission: 'messages:send', risk: 'LOW_WRITE',
    inputSchema: { channel: { type: 'string' }, campaignId: { type: 'string' } },
    async execute(args, ctx) {
      if (!ctx.runtime || !ctx.runtime.resumeCampaign) return fail('RUNTIME_MISSING');
      if (!channelPermitted(args.channel, ctx)) return fail('MODULE_NOT_ALLOWED');
      const out = await ctx.runtime.resumeCampaign({ channel: chan(args.channel), campaignId: args.campaignId, tenantId: ctx.tenant });
      return out.ok ? { ok: true, result: { resumed: true } } : fail('RESUME_FAILED', out.error);
    },
  },
  cancelCampaign: {
    description: 'Annule définitivement une campagne (les destinataires restants ne recevront rien).', permission: 'messages:send', risk: 'SENSITIVE',
    inputSchema: { channel: { type: 'string' }, campaignId: { type: 'string' } },
    async execute(args, ctx) {
      if (!ctx.runtime || !ctx.runtime.stopCampaign) return fail('RUNTIME_MISSING');
      if (!channelPermitted(args.channel, ctx)) return fail('MODULE_NOT_ALLOWED');
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
      if (!channelPermitted(args.channel, ctx)) return fail('MODULE_NOT_ALLOWED');
      const out = await ctx.runtime.getCampaignStatus({ channel: chan(args.channel), campaignId: args.campaignId, tenantId: ctx.tenant });
      return out.ok ? { ok: true, result: out.result } : fail('STATUS_FAILED', out.error);
    },
  },
  generateCampaignReport: {
    description: 'Rapport d’une campagne : totaux réels, durée, canal, continuité utilisée, erreurs, et export CSV par destinataire.',
    permission: null, risk: 'READ',
    inputSchema: { campaignId: { type: 'string', required: true } },
    async execute(args, ctx) {
      try { const result = await campaignService.report(ctx.tenant, args.campaignId, ctx.runtime, ctx.allowedModules); return { ok: true, result }; }
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
      const act = await activityStore.summary(null, 60, ctx.tenant);
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
      return { ok: true, result: { connections: conn && conn.result, queue, taskWorker: taskQueue.workerStatus(), recentErrors: errors.map((e) => ({ action: e.action, detail: e.detail, at: e.ts })), problems } };
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
      const act = await activityStore.summary(null, 1, ctx.tenant);
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
    requiredModule: 'whatsapp',
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
    async verify(result, args, ctx) {
      const campaign = result && result.campaignId ? await require('./groupCampaigns').get(ctx.tenant, result.campaignId) : null;
      return { verified: !!campaign && campaign.keyword === args.keyword && campaign.groups.length > 0 && campaign.slots.length > 0 };
    },
  },
  listGroupCampaigns: {
    description: 'Liste les campagnes de groupes (statut, groupes ciblés, horaires, messages envoyés).', permission: null, risk: 'READ', inputSchema: {},
    async execute(args, ctx) { const all = await require('./groupCampaigns').list(ctx.tenant); return { ok: true, result: { count: all.length, campaigns: all.map((c) => ({ id: c.id, name: c.name, status: c.status, groups: c.groups.map((g) => g.name), slots: c.slots.map((s) => s.time), endAt: c.endAt, sent: c.sends.filter((x) => x.ok).length })) } }; },
  },
  stopGroupCampaign: {
    requiredModule: 'whatsapp',
    description: 'Arrête une campagne de groupes (par nom ou identifiant).', permission: null, risk: 'LOW_WRITE', inputSchema: { campaign: { type: 'string' } },
    async execute(args, ctx) { return require('./groupCampaigns').stop(ctx.tenant, args.campaign); },
    async verify(result, args, ctx) { const c = result && result.campaignId ? await require('./groupCampaigns').get(ctx.tenant, result.campaignId) : null; return { verified: !!c && c.status === 'stopped' }; },
  },
  setGroupCampaignGoal: {
    requiredModule: 'whatsapp',
    description: 'Définit l\'objectif commercial d\'une campagne de groupes (ex. 1 000 000 FCFA sur le mois).', permission: null, risk: 'LOW_WRITE',
    inputSchema: { amount: { type: 'number', required: true }, currency: { type: 'string' }, period: { type: 'string' }, campaign: { type: 'string' } },
    async execute(args, ctx) { return require('./groupCampaigns').setGoal(ctx.tenant, args.campaign, { amount: Number(args.amount), currency: args.currency || 'FCFA', period: args.period || null }); },
    async verify(result, args, ctx) { const c = result && result.campaignId ? await require('./groupCampaigns').get(ctx.tenant, result.campaignId) : null; return { verified: !!c && !!c.goal && Number(c.goal.amount) === Number(args.amount) && c.goal.currency === (args.currency || 'FCFA') }; },
  },
  getGroupCampaignReport: {
    requiredModule: 'whatsapp',
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

// Cycle de vie client, guidage et groupes de Service métier (module dédié).
Object.assign(TOOLS, require('./toolsLifecycle').TOOLS);
// Pilotage du répondeur : politique, « pourquoi ? », contexte d'une discussion (module dédié).
Object.assign(TOOLS, require('./toolsConversation').TOOLS);
// Services métiers : modifier, pause/réactivation, suppression + restauration (faire ET défaire), toutes vérifiées.
Object.assign(TOOLS, require('./toolsServices').TOOLS);

module.exports = { TOOLS, queueHandlers, launchDraft };
