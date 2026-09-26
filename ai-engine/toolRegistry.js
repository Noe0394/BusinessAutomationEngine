// TOOL REGISTRY — ai-engine/toolRegistry.js
// ---------------------------------------------------------------------------
// Pont technique central entre l'intelligence et TOUTES les fonctionnalités
// (Services Métiers, contacts/CRM, historique de messages, envoi WhatsApp/
// Telegram vérifié). Chaque outil a un CONTRAT explicite :
//   name, description, permission, inputSchema, resultSchema, errorSchema,
//   execute(args, ctx), verify?(result, args, ctx)
// et chaque appel passe par une machine à états réelle :
//   PENDING → RUNNING → SUCCESS | FAILED | BLOCKED | UNCONFIRMED
// Aucun `success` fictif : un outil d'ACTION externe (envoi de message) n'est
// SUCCESS que si sa vérification confirme (identifiant réel du message) ; sinon
// UNCONFIRMED. Les outils enveloppent les VRAIES implémentations déjà en place
// (businessServices, contactCrm, messageHistory, runtime.sendMessageVerified) —
// jamais de simulation. Injecté avec `ctx` = { tenant, runtime, permissions }.

const businessServices = require('./businessServices');
const contactCrm = require('./contactCrm');
const messageHistory = require('./messageHistory');
const knowledgeBase = require('./knowledgeBase');
const chatUploads = require('./chatUploads');
const authz = require('./authz');
const fs = require('fs');
const path = require('path');

// Niveaux de risque : l'utilisateur donne l'ordre, Cyrus l'exécute. Une confirmation n'est demandée QUE si elle est
// explicitement configurée (ctx.confirmFrom ou JARVIS_CONFIRM_FROM = premier niveau exigeant une confirmation).
const RISK = { READ: 0, LOW_WRITE: 1, WRITE: 2, SENSITIVE: 3, CRITICAL: 4 };
function needsConfirmation(risk, ctx) {
  const cfg = ctx && ctx.confirmFrom != null ? ctx.confirmFrom : process.env.JARVIS_CONFIRM_FROM;
  if (cfg == null || RISK[cfg] == null) return false;
  const r = RISK[risk] == null ? RISK.WRITE : RISK[risk];
  return r >= RISK[cfg];
}

const STATE = {
  NEEDS_CONFIRMATION: 'NEEDS_CONFIRMATION',
  PENDING: 'PENDING', RUNNING: 'RUNNING', SUCCESS: 'SUCCESS',
  PARTIAL_SUCCESS: 'PARTIAL_SUCCESS', FAILED: 'FAILED', BLOCKED: 'BLOCKED', UNCONFIRMED: 'UNCONFIRMED',
};

function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

// PREPARE d'un envoi : aucune émission, seulement un aperçu vérifiable.
async function prepareSend(channel, args, ctx) {
  const to = String((args && args.to) || '').trim();
  const text = String((args && args.text) || '').trim();
  const warnings = [];
  if (!to) warnings.push('DESTINATAIRE_MANQUANT');
  if (!text) warnings.push('TEXTE_VIDE');
  if (text.length > 4000) warnings.push('TEXTE_TROP_LONG');
  if (to && await contactCrm.isOptedOut(ctx.tenant, channel, to)) warnings.push('CONTACT_OPT_OUT');
  return { ok: !warnings.length, preview: { channel, to, text: text.slice(0, 500) }, warnings };
}

// --------------------------------------------------------------------------
// Définition des outils réels
// --------------------------------------------------------------------------
const TOOLS = {
  // ---- Services Métiers (données réelles configurées par le vendeur) -------
  getBusinessServices: {
    description: 'Liste les Services Métiers configurés (nom, activité, prix, statut de connexion) — sans aucun secret.',
    permission: null,
    risk: 'READ',
    inputSchema: {},
    resultSchema: { services: 'array<{id,name,type,price,hasConfiguredPrice,products:[{name,price}],connected}>' },
    errorSchema: { code: 'string' },
    async execute(args, ctx) {
      const services = await businessServices.list(ctx.tenant);
      return { ok: true, result: { count: services.length, services: services.map((s) => {
        const products = (Array.isArray(s.products) ? s.products : []).map((p) => ({
          name: p && typeof p === 'object' ? (p.name || null) : String(p || ''),
          price: p && typeof p === 'object' && p.price != null ? p.price : null,
        }));
        const servicePrice = s.commercial && s.commercial.price != null ? s.commercial.price : null;
        return {
          id: s.id, name: s.name, type: s.type,
          price: servicePrice,
          hasConfiguredPrice: servicePrice != null || products.some((p) => p.price != null),
          products,
          currency: (s.commercial && s.commercial.currency) || null,
          connected: s.status === 'CONNECTED',
        };
      }) } };
    },
  },

  getProductPrice: {
    roles: ['OWNER', 'ADMIN', 'CUSTOMER'], // un prix est une information publique du vendeur
    description: 'Donne le prix RÉEL d\'un produit/formation/service configuré, recherché par nom. Ne renvoie jamais un prix inventé.',
    permission: null,
    risk: 'READ',
    inputSchema: { query: { type: 'string', required: true, description: 'Nom (ou partie du nom) du produit/service recherché.' } },
    resultSchema: { found: 'boolean', name: 'string', price: 'number', currency: 'string' },
    errorSchema: { code: 'string' },
    async execute(args, ctx) {
      const q = norm(args.query);
      const ctxData = await businessServices.getEngineContext(ctx.tenant);
      const candidates = [];
      for (const s of ctxData) {
        const cur = (s.commercial && s.commercial.currency) || 'FCFA';
        if (s.commercial && s.commercial.price != null) candidates.push({ name: s.name, price: s.commercial.price, currency: cur });
        for (const p of (s.products || [])) {
          if (p && p.price != null) candidates.push({ name: p.name || String(p), price: p.price, currency: cur });
        }
      }
      const exact = candidates.find((c) => norm(c.name) === q);
      const partial = exact || candidates.find((c) => norm(c.name).includes(q) || q.includes(norm(c.name)));
      if (!partial) return { ok: true, result: { found: false, query: args.query, available: candidates.map((c) => c.name) } };
      return { ok: true, result: { found: true, name: partial.name, price: partial.price, currency: partial.currency } };
    },
  },

  getBusinessContext: {
    description: 'Renvoie le contexte métier complet (produits, prix, règles, objectifs, capacités) prêt pour le raisonnement de l\'IA.',
    permission: null,
    risk: 'READ',
    inputSchema: {},
    resultSchema: { text: 'string' },
    errorSchema: { code: 'string' },
    async execute(args, ctx) {
      const text = await businessServices.getEngineContextText(ctx.tenant);
      return { ok: true, result: { text, hasData: !!text } };
    },
  },

  // ---- Documentation / centre d'aide (source de vérité produit) -----------
  getDocumentation: {
    description: 'Cherche dans la documentation officielle de CYRUS comment faire quelque chose (configurer un Service Métier, importer des contacts, connecter WhatsApp, etc.). À utiliser pour toute question « comment… ? » sur le fonctionnement du produit.',
    permission: null,
    risk: 'READ',
    inputSchema: { query: { type: 'string', required: true, description: 'La question ou le sujet (ex. « configurer un service métier », « importer contacts »).' } },
    resultSchema: { found: 'boolean', articles: 'array<{title,summary,steps,body}>' },
    errorSchema: { code: 'string' },
    async execute(args) {
      const hits = knowledgeBase.search(args.query, 2);
      if (!hits.length) return { ok: true, result: { found: false, query: args.query } };
      return { ok: true, result: { found: true, articles: hits.map((a) => ({ id: a.id, title: a.title, summary: a.summary, steps: a.steps || null, body: a.body })) } };
    },
  },

  // ---- Configuration métier PAR LE CHAT (écriture) ------------------------
  configureBusinessService: {
    // Brancher une URL/clé fournie par un contenu externe ferait partir des données vers un tiers : confirmation exigée.
    confirmWhenTainted: (a) => !!(a && (a.baseUrl || a.apiKey)),
    description: 'Crée (et éventuellement connecte l\'API + teste) un Service Métier à partir d\'instructions en langage naturel : nom, et de préférence "memo" (TOUT ce que l\'utilisateur dit de son activité en texte libre — produits, prix, promos, horaires, dates, règles, paiement... Cyrus en extrait automatiquement ce qu\'il peut). Les champs structurés (price, description...) restent utilisables en complément/correction, mais ne sont PLUS nécessaires : ne les redemande jamais un par un si l\'utilisateur a déjà tout donné en texte libre, transmets ce texte tel quel dans "memo". Retourne le service créé et, si une API est fournie, le résultat RÉEL du test de connexion.',
    permission: null,
    risk: 'LOW_WRITE',
    inputSchema: {
      name: { type: 'string', required: false, description: 'Nom facultatif; Cyrus le déduit de la mémoire si besoin.' },
      memo: { type: 'string', required: false, description: 'Mémoire libre de l\'activité : TOUT ce que l\'utilisateur a dit (produits, prix, promos, dates, règles, paiement, FAQ...), transmis tel quel — Cyrus en extrait automatiquement les champs structurés. Toujours préférable à remplir les champs un par un.' },
      type: { type: 'string', required: false, description: 'Type d\'activité (formation, ecommerce, service…).' },
      price: { type: 'number', required: false, description: 'Prix principal (facultatif si déjà dans "memo").' },
      currency: { type: 'string', required: false, description: 'Devise (défaut FCFA).' },
      description: { type: 'string', required: false, description: 'Description de l\'offre (facultatif si déjà dans "memo").' },
      products: { type: 'string', required: false, description: 'Produits, format « Nom|Prix » séparés par des points-virgules ou des retours ligne.' },
      rules: { type: 'string', required: false, description: 'Règles commerciales, une par ligne ou séparées par « ; ».' },
      objectives: { type: 'string', required: false, description: 'Objectifs, séparés par « ; ».' },
      baseUrl: { type: 'string', required: false, description: 'URL de base de l\'API à connecter (si plateforme avec API).' },
      apiKey: { type: 'string', required: false, description: 'Clé API (stockée chiffrée dans le coffre, jamais réaffichée).' },
      authHeader: { type: 'string', required: false, description: 'En-tête d\'authentification (défaut X-API-Key).' },
      connectorType: { type: 'string', required: false, description: 'Type de connecteur : platform_gateway | systemio | generic.' },
      scopes: { type: 'string', required: false, description: 'Permissions autorisées, séparées par des virgules (ex. students:create,students:suspend).' },
    },
    resultSchema: { serviceId: 'string', connected: 'boolean', test: 'object' },
    errorSchema: { code: 'string' },
    async execute(args, ctx) {
      const splitList = (s) => String(s || '').split(/[\n;]+/).map((x) => x.trim()).filter(Boolean);
      const products = splitList(args.products).map((line) => { const [n, p] = line.split('|').map((x) => x.trim()); return { name: n || line, price: p ? Number(p) : null }; });
      const scopes = String(args.scopes || '').split(/[,\s]+/).map((x) => x.trim()).filter(Boolean);
      const connection = args.baseUrl ? { kind: 'api', connectorType: args.connectorType || (/agent-gateway|riea/i.test(args.baseUrl) ? 'platform_gateway' : 'generic'), baseUrl: args.baseUrl, authHeader: args.authHeader || 'X-API-Key' } : { kind: 'none' };
      if (connection.connectorType === 'platform_gateway') connection.endpoints = { enroll: '/api/v1/agent-gateway/enroll-student', suspend: '/api/v1/agent-gateway/suspend-student' };
      const existing = args.name
        ? (await businessServices.list(ctx.tenant)).find((s) => String(s.name).trim().toLowerCase() === String(args.name).trim().toLowerCase())
        : null;
      const payload = {
        name: args.name || undefined,
        type: args.type || (existing && existing.type) || undefined,
        connection: args.baseUrl ? connection : (existing ? existing.connection : { kind: 'none' }),
        scopes: scopes.length ? scopes : (existing ? existing.scopes : scopes),
        commercial: Object.assign({}, args.memo != null ? { memo: String(args.memo).slice(0, 8000) } : {},
          args.price != null ? { price: Number(args.price) } : {},
          args.currency ? { currency: args.currency } : {},
          args.description ? { description: args.description } : {}),
      };
      if (products.length) payload.products = products;
      if (args.rules) payload.rules = splitList(args.rules);
      if (args.objectives) payload.objectives = splitList(args.objectives);
      const svc = existing ? await businessServices.update(ctx.tenant, existing.id, payload) : await businessServices.create(ctx.tenant, payload);
      let test = null; let connected = false;
      if (args.apiKey && args.baseUrl) {
        await businessServices.connectApi(ctx.tenant, svc.id, { apiKey: args.apiKey, baseUrl: args.baseUrl, authHeader: connection.authHeader, connectorType: connection.connectorType, endpoints: connection.endpoints });
        const t = await businessServices.testConnection(ctx.tenant, svc.id);
        test = t.result; connected = t.status === 'CONNECTED';
      }
      return { ok: true, result: { serviceId: svc.id, name: svc.name, connected, test, updated: !!existing } };
    },
    async verify(res, a, ctx) { return { verified: (await businessServices.list(ctx.tenant)).some((s) => s.id === res.serviceId && s.name === res.name) }; },
  },

  importContactsFromFile: {
    description: 'Importe en masse les contacts d\'un fichier déjà joint à la discussion (CSV ou Excel), dans le CRM. À utiliser quand l\'utilisateur joint un fichier de contacts et demande de l\'importer. Retourne un rapport réel (importés / doublons / rejetés).',
    permission: null,
    risk: 'LOW_WRITE',
    inputSchema: { fileId: { type: 'string', required: true, description: 'Identifiant du fichier joint (fourni dans le contexte des pièces jointes, ex. f_xxx).' } },
    resultSchema: { imported: 'number', duplicates: 'number', invalid: 'number' },
    errorSchema: { code: 'string' },
    async execute(args, ctx) {
      const meta = await chatUploads.get(ctx.tenant, args.fileId);
      if (!meta) return { ok: false, error: { code: 'FILE_NOT_FOUND' } };
      // Extracteur UNIQUE de contacts (toutes les feuilles, en-têtes détectés, CSV/TSV/VCF/JSON) : même logique que le Web.
      let contacts = [];
      try {
        const f = await chatUploads.readFile(ctx.tenant, args.fileId);
        if (!f) return { ok: false, error: { code: 'FILE_NOT_FOUND' } };
        const entries = require('./contactExtractor').extractFromFile({ buffer: f.buffer, name: f.meta.name, type: f.meta.type }).entries;
        contacts = entries.filter((e) => e.phone).map((e) => ({ name: e.name || '', phone: e.phone }));
      } catch (e) { return { ok: false, error: { code: 'PARSE_ERROR', message: e.message } }; }
      const report = await contactCrm.importContacts(ctx.tenant, contacts, { source: 'chat_import' });
      return { ok: true, result: report };
    },
  },

  generateImage: {
    requiredModule: 'studio_video',
    description: 'Génère une image / affiche à partir d\'une description, et la renvoie TÉLÉCHARGEABLE dans la discussion. À utiliser quand l\'utilisateur demande de générer/créer une image, une affiche ou un visuel.',
    permission: null,
    risk: 'LOW_WRITE',
    inputSchema: { prompt: { type: 'string', required: true, description: 'Description du visuel à générer.' } },
    resultSchema: { fileId: 'string', name: 'string', type: 'string', media: 'boolean' },
    errorSchema: { code: 'string' },
    async execute(args, ctx) {
      if (typeof ctx.generateImage !== 'function') return { ok: false, error: { code: 'IMAGE_ENGINE_UNAVAILABLE' } };
      const img = await ctx.generateImage(args.prompt);
      if (!img || !img.buffer) return { ok: false, error: { code: 'GENERATION_FAILED' } };
      const ref = await chatUploads.save(ctx.tenant, { originalname: 'affiche-cyrus.jpg', mimetype: img.mimetype || 'image/jpeg', buffer: img.buffer });
      return { ok: true, result: { fileId: ref.id, name: ref.name, type: ref.type, media: true, download: true } };
    },
  },

  // ---- Contacts / CRM (données réelles) -----------------------------------
  countContacts: {
    description: 'Compte les contacts connus, avec répartition par étiquette (prospect/client/…).',
    permission: null,
    risk: 'READ',
    inputSchema: { channel: { type: 'string', required: false, description: 'Filtrer sur WHATSAPP ou TELEGRAM.' } },
    resultSchema: { total: 'number', byTag: 'object' },
    errorSchema: { code: 'string' },
    async execute(args, ctx) {
      const allowed = ctx.allowedModules === null ? null : (Array.isArray(ctx.allowedModules) ? ctx.allowedModules : []);
      const selectedChannel = args.channel ? String(args.channel).toUpperCase() : null;
      const channels = selectedChannel ? [selectedChannel] : (allowed ? ['WHATSAPP', 'TELEGRAM'].filter((ch) => allowed.includes(ch.toLowerCase())) : null);
      if (channels && channels.length === 1) {
        const c = await contactCrm.counts(ctx.tenant, { channel: channels[0] });
        return { ok: true, result: { total: c.total || 0, byTag: c.byTag || {} } };
      }
      if (channels && channels.length === 0) return { ok: true, result: { total: 0, byTag: {} } };
      const c = await contactCrm.counts(ctx.tenant);
      return { ok: true, result: { total: c.total || 0, byTag: c.byTag || {} } };
    },
  },

  searchContacts: {
    description: 'Recherche des contacts par nom/numéro, filtrable par étiquette et canal.',
    permission: null,
    risk: 'READ',
    inputSchema: {
      query: { type: 'string', required: false, description: 'Texte à chercher dans le nom ou le numéro.' },
      tag: { type: 'string', required: false, description: 'Filtre par étiquette (ex. prospect, client).' },
      channel: { type: 'string', required: false, description: 'WHATSAPP ou TELEGRAM.' },
    },
    resultSchema: { count: 'number', contacts: 'array' },
    errorSchema: { code: 'string' },
    async execute(args, ctx) {
      let items = await contactCrm.list(ctx.tenant, { tag: args.tag || null, channel: args.channel || null });
      if (args.query) {
        const q = norm(args.query);
        items = items.filter((x) => norm(x.name).includes(q) || norm(x.from).includes(q));
      }
      return { ok: true, result: { count: items.length, contacts: items.slice(0, 50).map((x) => ({
        name: x.name || null, id: x.from, channel: x.channel || null, tags: x.tags || [], purchases: (x.purchases || []).length,
      })) } };
    },
  },

  // ---- Historique de messages (réel, persistant) --------------------------
  getLastMessage: {
    description: 'Renvoie le dernier message REÇU sur un canal (expéditeur réel + contenu).',
    permission: null,
    risk: 'READ',
    inputSchema: { channel: { type: 'string', required: false, description: 'WHATSAPP (défaut) ou TELEGRAM.' } },
    resultSchema: { found: 'boolean', name: 'string', number: 'string', text: 'string', ts: 'number' },
    errorSchema: { code: 'string' },
    async execute(args, ctx) {
      const channel = /telegram/i.test(args.channel || '') ? 'TELEGRAM' : 'WHATSAPP';
      const last = await messageHistory.getLastIncoming(ctx.tenant, channel);
      if (!last) return { ok: true, result: { found: false, channel } };
      return { ok: true, result: { found: true, channel, name: last.name || null, number: last.number || last.party, text: last.text || null, ts: last.ts || null, chatId: last.chatId || last.party } };
    },
  },

  getConversationHistory: {
    description: 'Renvoie l\'historique récent d\'un canal (ou d\'un contact précis), sur N jours quand disponible.',
    permission: null,
    risk: 'READ',
    inputSchema: {
      channel: { type: 'string', required: false, description: 'WHATSAPP (défaut) ou TELEGRAM.' },
      party: { type: 'string', required: false, description: 'Identifiant du contact (numéro/JID) pour cibler une conversation.' },
      sinceDays: { type: 'number', required: false, description: 'Fenêtre en jours (ex. 7).' },
      limit: { type: 'number', required: false, description: 'Nombre max de messages.' },
    },
    resultSchema: { count: 'number', messages: 'array' },
    errorSchema: { code: 'string' },
    async execute(args, ctx) {
      const channel = /telegram/i.test(args.channel || '') ? 'TELEGRAM' : 'WHATSAPP';
      let msgs;
      if (args.party) msgs = await messageHistory.getConversation(ctx.tenant, channel, args.party, args.limit || 50);
      else if (args.sinceDays) msgs = await messageHistory.getSince(ctx.tenant, channel, args.sinceDays);
      else msgs = await messageHistory.getRecent(ctx.tenant, channel, args.limit || 50);
      msgs = msgs || [];
      return { ok: true, result: { channel, count: msgs.length, messages: msgs.slice(-100).map((m) => ({
        direction: m.direction, name: m.name || null, number: m.number || null, party: m.party, text: m.text || null, ts: m.ts || null,
      })) } };
    },
  },

  searchMessages: {
    description: 'Recherche un mot/expression dans l\'historique persistant des messages d\'un canal.',
    permission: null,
    risk: 'READ',
    inputSchema: {
      query: { type: 'string', required: true, description: 'Mot ou expression à chercher.' },
      channel: { type: 'string', required: false, description: 'WHATSAPP (défaut) ou TELEGRAM.' },
      sinceDays: { type: 'number', required: false, description: 'Fenêtre en jours (défaut 30).' },
    },
    resultSchema: { count: 'number', matches: 'array' },
    errorSchema: { code: 'string' },
    async execute(args, ctx) {
      const channel = /telegram/i.test(args.channel || '') ? 'TELEGRAM' : 'WHATSAPP';
      const q = norm(args.query);
      const all = await messageHistory.getSince(ctx.tenant, channel, args.sinceDays || 30);
      const matches = (all || []).filter((m) => norm(m.text).includes(q));
      return { ok: true, result: { channel, count: matches.length, matches: matches.slice(-50).map((m) => ({ direction: m.direction, name: m.name || null, number: m.number || null, party: m.party, text: m.text || null, ts: m.ts || null })) } };
    },
  },

  getMessagesByDate: {
    description: 'Renvoie les messages d\'un canal reçus/envoyés sur les N derniers jours (ex. avant-hier = 2).',
    permission: null,
    risk: 'READ',
    inputSchema: {
      sinceDays: { type: 'number', required: true, description: 'Nombre de jours en arrière (1 = aujourd\'hui, 2 = hier inclus…).' },
      channel: { type: 'string', required: false, description: 'WHATSAPP (défaut) ou TELEGRAM.' },
    },
    resultSchema: { count: 'number', messages: 'array' },
    errorSchema: { code: 'string' },
    async execute(args, ctx) {
      const channel = /telegram/i.test(args.channel || '') ? 'TELEGRAM' : 'WHATSAPP';
      const msgs = await messageHistory.getSince(ctx.tenant, channel, args.sinceDays || 2);
      return { ok: true, result: { channel, sinceDays: args.sinceDays, count: (msgs || []).length, messages: (msgs || []).slice(-100).map((m) => ({ direction: m.direction, name: m.name || null, number: m.number || null, party: m.party, text: m.text || null, ts: m.ts || null })) } };
    },
  },

  // ---- Recherche conversationnelle (7 jours, index) -----------------------
  searchConversations: {
    description: 'Liste les conversations récentes (7 jours) — par nom, numéro ou nom de groupe. Source rapide (index, pas les messages bruts).',
    permission: null,
    risk: 'READ',
    inputSchema: {
      query: { type: 'string', required: false, description: 'Nom/numéro/nom de groupe à chercher.' },
      channel: { type: 'string', required: false, description: 'WHATSAPP ou TELEGRAM (tous si absent).' },
      type: { type: 'string', required: false, description: 'INDIVIDUAL ou GROUP.' },
      limit: { type: 'number', required: false, description: 'Nombre max de résultats (défaut 50).' },
    },
    resultSchema: { count: 'number', conversations: 'array' },
    errorSchema: { code: 'string' },
    async execute(args, ctx) {
      const rows = await messageHistory.findConversations(ctx.tenant, {
        query: args.query || null, channel: args.channel || null, type: args.type || null,
      });
      return { ok: true, result: { count: rows.length, conversations: rows.slice(0, args.limit || 50) } };
    },
  },

  getGroupConversation: {
    description: 'Renvoie les messages récents d\'un groupe (par groupId), avec l\'expéditeur de chacun.',
    permission: null,
    risk: 'READ',
    inputSchema: {
      groupId: { type: 'string', required: true, description: 'Identifiant du groupe (JID WhatsApp ou ID Telegram).' },
      channel: { type: 'string', required: false, description: 'WHATSAPP (défaut) ou TELEGRAM.' },
      limit: { type: 'number', required: false, description: 'Nombre max de messages (défaut 50).' },
    },
    resultSchema: { count: 'number', messages: 'array' },
    errorSchema: { code: 'string' },
    async execute(args, ctx) {
      const channel = /telegram/i.test(args.channel || '') ? 'TELEGRAM' : 'WHATSAPP';
      const msgs = await messageHistory.getGroupMessages(ctx.tenant, channel, args.groupId, args.limit || 50);
      return { ok: true, result: { channel, groupId: args.groupId, count: (msgs || []).length, messages: (msgs || []).map((m) => ({
        direction: m.direction, senderName: m.senderName || m.name || null, senderPhone: m.senderPhone || null,
        text: m.text || null, ts: m.ts || null, messageId: m.messageId || null,
      })) } };
    },
  },

  // ---- Actions sortantes VÉRIFIÉES ----------------------------------------
  sendWhatsAppMessage: {
    description: 'Envoie un message WhatsApp et VÉRIFIE l\'envoi (identifiant réel). SUCCESS seulement si confirmé.',
    permission: 'messages:send',
    risk: 'WRITE',
    inputSchema: {
      to: { type: 'string', required: true, description: 'Destinataire (numéro ou JID).' },
      text: { type: 'string', required: true, description: 'Texte à envoyer.' },
    },
    resultSchema: { status: 'string', confirmationId: 'string' },
    errorSchema: { code: 'string', message: 'string' },
    async prepare(args, ctx) {
      return prepareSend('WHATSAPP', args, ctx);
    },
    async execute(args, ctx) {
      if (!ctx.runtime || typeof ctx.runtime.sendMessageVerified !== 'function') return { ok: false, error: { code: 'RUNTIME_MISSING' } };
      if (ctx.autonomous === true && await contactCrm.isOptedOut(ctx.tenant, 'WHATSAPP', args.to)) return { ok: false, error: { code: 'RECIPIENT_OPTED_OUT', message: 'Ce contact a refusé toute sollicitation.' } };
      const out = await ctx.runtime.sendMessageVerified({ channel: 'WHATSAPP', to: args.to, text: args.text, tenantId: ctx.tenant });
      if (out.status === 'FAILED') return { ok: false, error: { code: 'SEND_FAILED', message: out.error || 'non confirmé' } };
      const optedOut = await contactCrm.isOptedOut(ctx.tenant, 'WHATSAPP', args.to).catch(() => false);
      return { ok: true, result: Object.assign({ status: out.status, confirmationId: out.confirmationId || null }, optedOut ? { note: 'Envoyé sur votre ordre : ce contact avait demandé à ne plus être sollicité.' } : {}) };
    },
    async verify(result) { return { verified: result && result.status === 'SUCCESS' && !!result.confirmationId, confirmationId: result && result.confirmationId }; },
  },

  sendTelegramMessage: {
    description: 'Envoie un message Telegram et VÉRIFIE l\'envoi (identifiant réel). SUCCESS seulement si confirmé.',
    permission: 'messages:send',
    risk: 'WRITE',
    inputSchema: {
      to: { type: 'string', required: true, description: 'Destinataire (@username, numéro, ou id).' },
      text: { type: 'string', required: true, description: 'Texte à envoyer.' },
    },
    resultSchema: { status: 'string', confirmationId: 'string' },
    errorSchema: { code: 'string', message: 'string' },
    async prepare(args, ctx) {
      return prepareSend('TELEGRAM', args, ctx);
    },
    async execute(args, ctx) {
      if (!ctx.runtime || typeof ctx.runtime.sendMessageVerified !== 'function') return { ok: false, error: { code: 'RUNTIME_MISSING' } };
      if (ctx.autonomous === true && await contactCrm.isOptedOut(ctx.tenant, 'TELEGRAM', args.to)) return { ok: false, error: { code: 'RECIPIENT_OPTED_OUT', message: 'Ce contact a refusé toute sollicitation.' } };
      const out = await ctx.runtime.sendMessageVerified({ channel: 'TELEGRAM', to: args.to, text: args.text, tenantId: ctx.tenant });
      if (out.status === 'FAILED') return { ok: false, error: { code: 'SEND_FAILED', message: out.error || 'non confirmé' } };
      const optedOut = await contactCrm.isOptedOut(ctx.tenant, 'TELEGRAM', args.to).catch(() => false);
      return { ok: true, result: Object.assign({ status: out.status, confirmationId: out.confirmationId || null }, optedOut ? { note: 'Envoyé sur votre ordre : ce contact avait demandé à ne plus être sollicité.' } : {}) };
    },
    async verify(result) { return { verified: result && result.status === 'SUCCESS' && !!result.confirmationId, confirmationId: result && result.confirmationId }; },
  },

  sendWhatsAppMessageBatch: {
    requiredModule: 'whatsapp', permission: 'messages:send', risk: 'WRITE',
    description: 'Envoie le même texte exact à une liste WhatsApp de contacts. Accepte la liste de membres retournée par l’extraction de groupe ou une liste CRM. Déduplique les identifiants, respecte les refus enregistrés et rapporte chaque résultat confirmé, échoué ou incertain. Pour les gros envois, préfère le moteur de campagne durable.',
    inputSchema: {
      recipients: { type: 'array', required: true, maxItems: 1000, description: 'Numéros ou objets de contacts réels provenant d’une lecture/extraction précédente.' },
      text: { type: 'string', required: true, maxLength: 4000, description: 'Texte exact à envoyer, sans reformulation.' },
    },
    resultSchema: { total: 'number', verified: 'number', failed: 'number', unconfirmed: 'number', results: 'array' },
    async execute(args, ctx) { return executeBatchSend('WHATSAPP', args, ctx); },
    async verify(result) {
      return { verified: !!result && result.total > 0 && result.verified === result.total,
        source: 'per_recipient_message_acknowledgements', confirmationIds: result && result.confirmationIds || [] };
    },
  },

  sendTelegramMessageBatch: {
    requiredModule: 'telegram', permission: 'messages:send', risk: 'WRITE',
    description: 'Envoie le même texte exact à une liste Telegram de contacts. Accepte une liste de membres extraite ou une liste CRM. Déduplique les identifiants, respecte les refus enregistrés et rapporte chaque résultat confirmé, échoué ou incertain. Pour les gros envois, préfère le moteur de campagne durable.',
    inputSchema: {
      recipients: { type: 'array', required: true, maxItems: 1000, description: 'Identifiants @username ou objets de contacts réels provenant d’une lecture/extraction précédente.' },
      text: { type: 'string', required: true, maxLength: 4000, description: 'Texte exact à envoyer, sans reformulation.' },
    },
    resultSchema: { total: 'number', verified: 'number', failed: 'number', unconfirmed: 'number', results: 'array' },
    async execute(args, ctx) { return executeBatchSend('TELEGRAM', args, ctx); },
    async verify(result) {
      return { verified: !!result && result.total > 0 && result.verified === result.total,
        source: 'per_recipient_message_acknowledgements', confirmationIds: result && result.confirmationIds || [] };
    },
  },
};

function batchRecipientId(value, channel) {
  const raw = typeof value === 'string' ? value : value && (value.phone || value.number || value.telephone || value.id || value.username || value.userId);
  if (raw == null) return '';
  let id = String(raw).trim();
  if (channel === 'WHATSAPP') {
    if (/@g\.us$/i.test(id) || /@broadcast$/i.test(id) || /@lid$/i.test(id)) return '';
    if (/^\d{6,15}(?::\d+)?@s\.whatsapp\.net$/i.test(id)) return id;
    const digits = id.replace(/\D/g, '');
    return /^\d{6,15}$/.test(digits) ? `${digits}@s.whatsapp.net` : '';
  }
  return /^@[A-Za-z0-9_]{4,32}$/.test(id) || /^-?\d{4,20}$/.test(id) ? id : '';
}

async function executeBatchSend(channel, args, ctx) {
  if (!ctx.runtime || typeof ctx.runtime.sendMessageVerified !== 'function') return { ok: false, error: { code: 'RUNTIME_MISSING' } };
  const source = Array.isArray(args.recipients) ? args.recipients : [];
  const seen = new Set(); const recipients = [];
  for (const row of source) {
    const to = batchRecipientId(row, channel);
    if (to && !seen.has(to)) { seen.add(to); recipients.push(to); }
  }
  if (!recipients.length) return { ok: false, error: { code: 'NO_VALID_RECIPIENTS', message: 'Aucun identifiant de destinataire exploitable.' } };
  const outcomes = [];
  for (const to of recipients) {
    if (ctx.autonomous === true && await contactCrm.isOptedOut(ctx.tenant, channel, to).catch(() => false)) {
      outcomes.push({ to, status: 'SKIPPED', reason: 'RECIPIENT_OPTED_OUT' });
      continue;
    }
    try {
      const out = await ctx.runtime.sendMessageVerified({ channel, to, text: args.text, tenantId: ctx.tenant });
      const verified = !!out && out.status === 'SUCCESS' && !!out.confirmationId;
      outcomes.push({ to, status: verified ? 'SUCCESS' : (out && out.status || 'UNCONFIRMED'), confirmationId: out && out.confirmationId || null, error: out && out.error || null });
    } catch (err) {
      outcomes.push({ to, status: 'FAILED', error: String(err.message || err).slice(0, 240) });
    }
  }
  const verified = outcomes.filter((x) => x.status === 'SUCCESS').length;
  const failed = outcomes.filter((x) => x.status === 'FAILED' || x.status === 'SKIPPED').length;
  const unconfirmed = outcomes.filter((x) => !['SUCCESS', 'FAILED', 'SKIPPED'].includes(x.status)).length;
  const result = { total: recipients.length, verified, failed, unconfirmed,
    confirmationIds: outcomes.filter((x) => x.confirmationId).map((x) => x.confirmationId), results: outcomes };
  if (verified === recipients.length) return { ok: true, result };
  if (verified > 0) return { ok: true, state: STATE.PARTIAL_SUCCESS, result };
  if (unconfirmed > 0) return { ok: true, result };
  return { ok: false, error: { code: 'BATCH_SEND_FAILED' }, result };
}

// Outils étendus (contacts, campagnes, file, CRM, diagnostic, notifications) — voir toolsExtra.js
for (const [name, tool] of Object.entries(require('./toolsExtra').TOOLS)) TOOLS[name] = Object.assign({ resultSchema: {}, errorSchema: { code: 'string' } }, tool);

// Outils de fonctionnalités extensibles : un module placé dans tool-modules/ et
// exportant { TOOLS } est découvert au démarrage, sans modification du routeur
// Chat/WhatsApp/Telegram. Chaque entrée garde le même contrat et les mêmes
// contrôles d'identité, de permissions, d'exécution et de vérification.
const registeredSources = new Map();
function registerTool(name, tool, opts) {
  const key = String(name || '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{1,79}$/.test(key) || !tool || typeof tool !== 'object'
      || typeof tool.description !== 'string' || typeof tool.execute !== 'function'
      || typeof tool.feature !== 'string' || !tool.feature.trim()
      || !Array.isArray(tool.capabilities) || !tool.capabilities.length || tool.capabilities.some((c) => typeof c !== 'string' || !c.trim())) {
    throw new TypeError('Un tool exige un nom, une description, feature, capabilities et execute(args, ctx).');
  }
  // Recharger le catalogue (tests, supervision, hot reload) avec le même module
  // ne doit pas faire échouer le démarrage ni enregistrer deux fois un outil.
  if (TOOLS[key] && registeredSources.get(key) === tool && !(opts && opts.replace === true)) return key;
  if (TOOLS[key] && !(opts && opts.replace === true)) throw new Error(`Tool déjà enregistré : ${key}`);
  TOOLS[key] = Object.assign({ resultSchema: {}, errorSchema: { code: 'string' } }, tool);
  registeredSources.set(key, tool);
  return key;
}
function loadToolModules() {
  const dir = path.join(__dirname, 'tool-modules');
  if (!fs.existsSync(dir)) return;
  for (const file of fs.readdirSync(dir).filter((f) => /^[A-Za-z0-9_-]+\.js$/.test(f)).sort()) {
    const mod = require(path.join(dir, file));
    const entries = mod && mod.TOOLS ? mod.TOOLS : mod;
    if (!entries || typeof entries !== 'object' || Array.isArray(entries)) throw new TypeError(`Module tool invalide : ${file}`);
    for (const [name, tool] of Object.entries(entries)) registerTool(name, tool);
  }
}
loadToolModules();

// --------------------------------------------------------------------------
// API publique
// --------------------------------------------------------------------------
function describe() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    id: t.id || name, name, description: t.description,
    category: t.category || t.feature || inferredFeature(name), feature: t.feature || inferredFeature(name),
    keywords: Array.isArray(t.keywords) ? t.keywords : [], aliases: Array.isArray(t.aliases) ? t.aliases : [],
    requiredModule: requiredModuleFor(t, name),
    capabilities: t.capabilities && t.capabilities.length ? t.capabilities : inferredCapabilities(name),
    permission: t.permission || null, permissions: Array.isArray(t.permissions) ? t.permissions : (t.permission ? [t.permission] : []),
    platforms: platformsFor(t, name), risk: t.risk || 'READ', riskLevel: t.risk || 'READ',
    timeout: Number(t.timeout || t.timeoutMs) || 30000,
    retryPolicy: t.retryPolicy || { maxRetries: 0 },
    availability: t.availability || 'registered', dependencies: Array.isArray(t.dependencies) ? t.dependencies : [],
    inputSchema: t.inputSchema || {}, outputSchema: t.outputSchema || t.resultSchema || {},
    resultSchema: t.resultSchema || t.outputSchema || {}, errorSchema: t.errorSchema || {},
  }));
}

function platformsFor(tool, name) {
  if (Array.isArray(tool && tool.platforms)) return tool.platforms;
  const required = requiredModuleFor(tool, name);
  if (required === 'whatsapp') return ['whatsapp', 'self_whatsapp'];
  if (required === 'telegram') return ['telegram', 'self_telegram'];
  if (required === '__messaging__') return ['whatsapp', 'telegram', 'self_whatsapp', 'self_telegram'];
  return ['web', 'chat', 'whatsapp', 'telegram', 'self_whatsapp', 'self_telegram'];
}

// Les outils historiques restent utilisables sans réécriture de leurs moteurs.
// Leur domaine et verbes sont exposés au routeur à partir du nom jusqu'à ce que
// leur auteur ajoute des métadonnées explicites. Les nouveaux modules, eux,
// doivent fournir feature/capabilities dans registerTool().
function inferredFeature(name) {
  const n = String(name || '').toLowerCase();
  if (/community|communit|group/.test(n)) return 'communities';
  if (/campaign|followup|relance/.test(n)) return 'campaigns_followups';
  if (/contact|recipient|phone|customer/.test(n)) return 'contacts_crm';
  if (/conversation|message|reply/.test(n)) return 'conversations_messaging';
  if (/autoreply|auto.?responder|policy|automation|task|queue/.test(n)) return 'automation_operations';
  if (/media|image|video|ebook|course|studio/.test(n)) return 'media_content';
  if (/notification/.test(n)) return 'notifications';
  if (/report|activity|statistics|analyze/.test(n)) return 'reports_analytics';
  if (/facebook|adcampaign/.test(n)) return 'facebook_marketing';
  if (/businessservice|productprice|businesscontext|order|sav|specialist/.test(n)) return 'business_services';
  if (/documentation|capabilities|systemstatus/.test(n)) return 'help_system';
  return 'general_operations';
}

function inferredCapabilities(name) {
  const n = String(name || '').toLowerCase();
  const caps = [];
  const verbs = [
    [/^(list|search|find|query|count|describe|get|why|explain|monitor|analyze|validate|normalize|deduplicate|parse|extract|segment|discover|followupcandidates|planfollowup)/, 'read'],
    [/^(create|configure|set|update|tag|link|attach|record|promote|resolve|open|ingest|restore|mark)/, 'manage'],
    [/^(send|broadcast)/, 'send'],
    [/^(import)/, 'import'], [/^(export)/, 'export'],
    [/^(generate)/, 'generate'], [/^(prepare)/, 'prepare'],
    [/^(pause|resume|cancel|stop|schedule|launch|play)/, 'control'],
    [/^(delete|unlink)/, 'delete'],
  ];
  for (const [re, capability] of verbs) if (re.test(n)) caps.push(capability);
  if (/status|progress|report/.test(n) && !caps.includes('read')) caps.push('read');
  if (/status/.test(n)) caps.push('status');
  if (/report/.test(n)) caps.push('report');
  if (!caps.length) caps.push('execute');
  return [...new Set(caps)];
}

function requiredModuleFor(tool, name, args) {
  if (tool && tool.requiredModule && tool.requiredModule !== 'channel') return tool.requiredModule;
  const n = String(name || '').toLowerCase();
  if (/facebook/.test(n)) return null; // Facebook reste hors des modules de licence actuels.
  if (/telegram/.test(n)) return 'telegram';
  if (/whatsapp/.test(n)) return 'whatsapp';
  const channelAware = tool && tool.inputSchema && (tool.inputSchema.channel || tool.inputSchema.platform);
  if ((channelAware || /community|communities|group|campaign|followup|scheduledmessage|contact|recipient|message|conversation/.test(n))
      && !/conversationpolicy|groupcampaignpolicy/.test(n)) {
    const channel = String((args && (args.channel || args.platform)) || '').trim().toUpperCase();
    if (channel === 'TELEGRAM') return 'telegram';
    if (channel === 'WHATSAPP' || !channel) return channel ? 'whatsapp' : '__messaging__';
    return '__invalid_channel__';
  }
  return tool && tool.requiredModule || null;
}

function moduleAllowed(requiredModule, allowedModules) {
  if (!requiredModule || allowedModules === null) return true;
  if (!Array.isArray(allowedModules)) return false;
  return requiredModule === '__messaging__'
    ? allowedModules.includes('whatsapp') || allowedModules.includes('telegram')
    : allowedModules.includes(requiredModule);
}

// Liste des outils réellement UTILISABLES pour ce contexte (permissions).
function list(ctx) {
  const perms = (ctx && Array.isArray(ctx.permissions)) ? ctx.permissions : null;
  // Deny-by-default : sans identité authentifiée, aucun outil n'est proposé ; sinon seuls ceux que le RÔLE peut utiliser.
  const principal = (ctx && ctx.principal) || authz.currentPrincipal();
  if (!authz.isPrincipal(principal)) return [];
  const allowedModules = ctx && Object.prototype.hasOwnProperty.call(ctx, 'allowedModules') ? ctx.allowedModules : principal.allowedModules;
  return describe()
    .filter((t) => !TOOLS[t.name].directOnly)
    .filter((t) => authz.authorizeTool({ tool: TOOLS[t.name], toolName: t.name, tenant: principal.tenant, principal, requiredModule: requiredModuleFor(TOOLS[t.name], t.name) }).allowed)
    // Masquer dès le catalogue les outils dont le module n'est pas attribué;
    // le même contrôle est répété à l'exécution pour bloquer toute tentative
    // d'appel direct par le modèle.
    .filter((t) => moduleAllowed(requiredModuleFor(TOOLS[t.name], t.name), allowedModules))
    .filter((t) => !t.permission || !perms || perms.includes(t.permission));
}

// Tenant-aware union of core tools and externally configured connectors. The
// connector manager remains the authority for enabled state and granted scopes.
async function listForContext(ctx) {
  const principal = (ctx && ctx.principal) || authz.currentPrincipal();
  const base = list(ctx);
  if (!authz.isPrincipal(principal) || !['OWNER', 'ADMIN'].includes(principal.role)) return base;
  const tenant = principal.tenant;
  let connectors = [];
  try { connectors = await require('./connectors/connectorManager').getToolsForTenant(tenant); }
  catch (_) { return base; }
  const known = new Set(base.map((t) => t.name));
  for (const tool of connectors) {
    if (known.has(tool.name)) continue;
    base.push({
      id: tool.name, name: tool.name, description: tool.description,
      category: 'external_connectors', feature: 'external_connectors', requiredModule: null,
      capabilities: inferredCapabilities(tool.name), permission: tool.permission || null,
      permissions: tool.permission ? [tool.permission] : [], platforms: ['web', 'chat', 'whatsapp', 'telegram', 'self_whatsapp', 'self_telegram'],
      risk: 'WRITE', riskLevel: 'WRITE', timeout: 30000, retryPolicy: { maxRetries: 0 },
      availability: 'available', dependencies: [tool.connectorType],
      inputSchema: tool.parameters || {}, outputSchema: {}, resultSchema: {}, errorSchema: { code: 'string' },
      connectorType: tool.connectorType,
    });
  }
  return base;
}

function search(query, ctx, opts) {
  return rankTools(query, list(ctx), opts);
}

async function discover(query, ctx, opts) {
  return rankTools(query, await listForContext(ctx), opts);
}

function rankTools(query, catalog, opts) {
  const clean = (value) => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const stop = new Set(['les','des','une','dans','pour','avec','sur','par','mes','mon','ma','moi','m\u00eame','que','qui','quoi','est','sont','et','ou','the','and','for','with','from','into','your','my','all','this','that','please','could','would','can','want','today','maintenant']);
  const stem = (word) => word.replace(/(?:ments?|ations?|ation|euses?|eurs?|trices?|es|s)$/i, '').replace(/(er|ir|re|ez|ons|ent|ant|ait|aient)$/i, '');
  const expand = {
    group: ['community','groupe'], groupe: ['group','community'], commun: ['community','group'], memb: ['member','participant','contact'],
    cree: ['create','new'], creee: ['create','new'], creer: ['create','new'], creation: ['create','new'],
    prospect: ['lead','contact','client'], contact: ['recipient','member','prospect'],
    extract: ['read','member','contact','parse'], exra: ['extract'], list: ['search','find','get'],
    cherche: ['search','find','lookup','get'], cherch: ['search','find','lookup','get'],
    ecris: ['send','message','write','text'], ecrire: ['send','message','write','text'],
    envoi: ['send','message'], envoy: ['send','message'],
    send: ['message','deliver','broadcast'], messag: ['message','send'],
    campag: ['campaign','schedule','launch'], report: ['activity','statistics','analytics'],
    vendre: ['sale','sales','campaign','prospect'], vente: ['sale','sales','campaign','prospect'],
    service: ['business','product','offer'], produit: ['product','price','offer'],
    pause: ['pause','stop','control'], reprend: ['resume','continue'], relanc: ['followup','campaign','contact'],
    commande: ['order'], client: ['customer','contact'], facture: ['invoice','accounting'],
  };
  const words = (value) => clean(value).split(/[^a-z0-9_]+/).filter((w) => w.length > 2 && !stop.has(w));
  const terms = words(query);
  if (!terms.length) return catalog;
  const expanded = new Set(terms.flatMap((word) => {
    const s = stem(word);
    return [word, s, ...(expand[word] || []), ...(expand[s] || [])].filter(Boolean);
  }));
  const ranked = catalog.map((tool) => {
    const title = clean(tool.name);
    const description = clean(`${tool.description || ''} ${tool.category || ''} ${tool.feature || ''} ${(tool.capabilities || []).join(' ')} ${(tool.keywords || []).join(' ')} ${(tool.aliases || []).join(' ')}`);
    const titleWords = words(title).map(stem);
    const bodyWords = new Set(words(description).flatMap((w) => [w, stem(w)]));
    let score = 0;
    for (const term of expanded) {
      if (title.includes(term) || titleWords.some((w) => w && (w.startsWith(term) || term.startsWith(w)))) score += 5;
      else if (bodyWords.has(term) || [...bodyWords].some((w) => w.length > 3 && (w.startsWith(term) || term.startsWith(w)))) score += 1;
    }
    return { tool, score };
  }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score);
  if (!ranked.length) return catalog;
  const limit = Math.max(1, Number(opts && opts.limit) || 50);
  return ranked.slice(0, limit).map((item) => item.tool);
}

const MAX_STRING = 200000;
function validateArgs(schema, args) {
  const bad = [];
  for (const [k, spec] of Object.entries(schema || {})) {
    const v = args ? args[k] : undefined;
    if (v == null || v === '') continue;
    const t = spec && spec.type;
    if (t === 'string' && (typeof v === 'object' || (typeof v === 'string' && v.length > MAX_STRING))) bad.push(k);
    else if (t === 'number' && !Number.isFinite(Number(v))) bad.push(k);
    else if (t === 'boolean' && typeof v !== 'boolean' && v !== 'true' && v !== 'false') bad.push(k);
    else if (t === 'array' && (!Array.isArray(v) || (Number.isFinite(spec.maxItems) && v.length > spec.maxItems))) bad.push(k);
    else if (t === 'object' && (typeof v !== 'object' || Array.isArray(v))) bad.push(k);
    if (typeof v === 'string' && ((Number.isFinite(spec.maxLength) && v.length > spec.maxLength)
      || (Number.isFinite(spec.minLength) && v.length < spec.minLength))) bad.push(k);
    if (spec.enum && Array.isArray(spec.enum) && !spec.enum.includes(v)) bad.push(k);
  }
  return bad;
}
// Aperçu d'arguments pour une confirmation : jamais de secret (clé, jeton, mot de passe) en clair.
function previewOf(args) {
  const out = {};
  for (const [k, v] of Object.entries(args || {})) {
    if (/key|token|secret|password|pass/i.test(k)) out[k] = '••••';
    else out[k] = typeof v === 'string' ? v.slice(0, 300) : v;
  }
  return out;
}

async function _execute(tenant, name, args, ctx) {
  const call = { name, args: args || {}, state: STATE.PENDING, startedAt: new Date().toISOString() };
  const tool = TOOLS[name];
  if (!tool) {
    const knownConnectorTool = Object.values(require('./connectors/connectorManager').DEFINITIONS)
      .some((definition) => (definition.tools || []).some((item) => item.name === name));
    return knownConnectorTool ? executeConnectorTool(tenant, name, args, ctx, call)
      : Object.assign(call, { state: STATE.FAILED, error: { code: 'UNKNOWN_TOOL', message: `Outil « ${name} » inconnu.` }, finishedAt: new Date().toISOString() });
  }

  call.risk = tool.risk || 'READ'; // nature de l'outil, exposée à ceux qui doivent savoir si une action d'ÉCRITURE a réellement eu lieu
  const fullCtx = Object.assign({ tenant }, ctx || {});
  const done = (extra) => Object.assign(call, extra, { finishedAt: new Date().toISOString() });

  // Secrets d'authentification et codes d'appairage ne peuvent être appelés
  // que par le routeur direct, même si un autre chemin connaît leur nom.
  if (tool.directOnly && fullCtx.direct !== true) return done({ state: STATE.BLOCKED, error: { code: 'DIRECT_ROUTE_REQUIRED', message: 'Cet outil doit être appelé par le routage direct sécurisé.' } });

  // 1) AUTHENTIFIER + 2) AUTORISER (deny-by-default) : le principal vient du contexte serveur (jamais d'un argument, jamais
  //    du LLM) ; le rôle doit figurer dans les rôles de l'outil ; un compte n'opère que sur lui-même.
  const principal = authz.isPrincipal(fullCtx.principal) ? fullCtx.principal : authz.currentPrincipal();
  fullCtx.principal = principal;
  if (!Object.prototype.hasOwnProperty.call(fullCtx, 'allowedModules') && authz.isPrincipal(principal)) fullCtx.allowedModules = principal.allowedModules;
  const effectiveArgs = args && typeof args === 'object' && !Array.isArray(args) ? Object.assign({}, args) : {};
  const channelField = tool.inputSchema && (tool.inputSchema.channel ? 'channel' : (tool.inputSchema.platform ? 'platform' : null));
  if (channelField && !effectiveArgs.channel && !effectiveArgs.platform && Array.isArray(fullCtx.allowedModules)) {
    const channels = ['whatsapp', 'telegram'].filter((module) => fullCtx.allowedModules.includes(module));
    if (channels.length === 1) effectiveArgs[channelField] = channels[0].toUpperCase();
  }
  call.args = effectiveArgs;
  const requiredModule = requiredModuleFor(tool, name, effectiveArgs);
  const verdict = authz.authorizeTool({ tool, toolName: name, tenant, principal, requiredModule });
  if (!verdict.allowed) return done({ state: STATE.BLOCKED, error: { code: verdict.code, message: verdict.message } });

  // Permission
  if (tool.permission && Array.isArray(fullCtx.permissions) && !fullCtx.permissions.includes(tool.permission)) {
    return Object.assign(call, { state: STATE.BLOCKED, error: { code: 'PERMISSION_DENIED', permission: tool.permission }, finishedAt: new Date().toISOString() });
  }
  // Les outils étendus peuvent déclarer le même module que leur route HTTP.
  // La licence est injectée par le serveur dans toolContext; le LLM ne peut
  // ni la fournir ni l'élargir dans ses arguments.
  if (!moduleAllowed(requiredModule, fullCtx.allowedModules)) {
    return Object.assign(call, { state: STATE.BLOCKED, error: { code: 'MODULE_NOT_ALLOWED', module: requiredModule }, finishedAt: new Date().toISOString() });
  }
  // Validation des entrées requises
  const missing = Object.entries(tool.inputSchema || {})
    .filter(([k, s]) => s.required && (effectiveArgs[k] == null || effectiveArgs[k] === ''))
    .map(([k]) => k);
  if (missing.length) return Object.assign(call, { state: STATE.FAILED, error: { code: 'MISSING_INPUT', fields: missing }, finishedAt: new Date().toISOString() });

  // 3) VALIDER les paramètres (types et bornes déclarés par le contrat) — un argument produit par un LLM n'est pas fiable.
  const invalid = validateArgs(tool.inputSchema, effectiveArgs);
  if (invalid.length) return done({ state: STATE.FAILED, error: { code: 'INVALID_INPUT', fields: invalid } });

  // 4) PROPRIÉTÉ de la ressource : tout identifiant de fichier doit être bien formé ET appartenir à ce compte.
  for (const k of ['fileId', 'mediaFileId']) {
    if (effectiveArgs[k] != null && effectiveArgs[k] !== '') {
      if (!authz.isSafeId(String(effectiveArgs[k])) || !(await chatUploads.get(tenant, String(effectiveArgs[k])).catch(() => null))) {
        return done({ state: STATE.BLOCKED, error: { code: 'RESOURCE_NOT_OWNED', message: 'Fichier introuvable pour ce compte.' } });
      }
    }
  }

  // Tour TEINTÉ (fichier, média, transcription, donnée externe dans le message) : une action d'écriture externe ne part jamais
  // sans un « oui » explicite de l'humain, même si un contenu externe « ordonne » de la lancer.
  const taintedGuard = authz.isTainted() && !fullCtx.confirmed
    && ((RISK[tool.risk] != null ? RISK[tool.risk] : RISK.WRITE) >= RISK.WRITE || (typeof tool.confirmWhenTainted === 'function' && tool.confirmWhenTainted(effectiveArgs)));
  if ((needsConfirmation(tool.risk, fullCtx) || taintedGuard) && !fullCtx.confirmed) {
    const prepared = typeof tool.prepare === 'function' ? await tool.prepare(effectiveArgs, fullCtx).catch(() => null) : { ok: true, preview: previewOf(effectiveArgs), warnings: taintedGuard ? ['CONTENU_EXTERNE'] : [] };
    return Object.assign(call, { state: STATE.NEEDS_CONFIRMATION, risk: tool.risk, result: prepared, finishedAt: new Date().toISOString() });
  }

  call.state = STATE.RUNNING;
  let out;
  const timeoutMs = Math.max(1, Number(tool.timeout || tool.timeoutMs) || 30000);
  let timeout;
  try {
    out = await Promise.race([
      Promise.resolve().then(() => tool.execute(effectiveArgs, fullCtx)),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(Object.assign(new Error('TOOL_TIMEOUT'), { code: 'TOOL_TIMEOUT' })), timeoutMs); }),
    ]);
  }
  catch (err) {
    const timedOut = err && err.code === 'TOOL_TIMEOUT';
    return Object.assign(call, {
      state: timedOut ? STATE.UNCONFIRMED : STATE.FAILED,
      verified: false,
      error: { code: timedOut ? 'TOOL_TIMEOUT' : 'EXECUTION_ERROR', message: String((err && err.message) || err) },
      verification: timedOut ? { verified: false, source: 'execution_timeout' } : undefined,
      finishedAt: new Date().toISOString(),
    });
  }
  finally { if (timeout) clearTimeout(timeout); }

  if (!out || out.ok === false) {
    return Object.assign(call, { state: STATE.FAILED, error: (out && out.error) || { code: 'FAILED' }, result: (out && out.result) || null, finishedAt: new Date().toISOString() });
  }
  if (out.state === STATE.PARTIAL_SUCCESS) {
    return Object.assign(call, { state: STATE.PARTIAL_SUCCESS, verified: false, result: out.result || null,
      verification: { verified: false, source: 'partial_backend_result' }, finishedAt: new Date().toISOString() });
  }
  // Vérification réelle (outils d'action) — sinon SUCCESS direct (lectures).
  if (typeof tool.verify === 'function') {
    let v;
    try { v = await tool.verify(out.result, effectiveArgs, fullCtx); } catch (e) { v = { verified: false }; }
    return Object.assign(call, { state: v && v.verified ? STATE.SUCCESS : STATE.UNCONFIRMED, verified: !!(v && v.verified), result: out.result, verification: v, finishedAt: new Date().toISOString() });
  }
  const explicitlyVerified = !!(out.result && (out.result.verified === true || out.result.confirmed === true));
  const readOnly = (tool.risk || 'READ') === 'READ';
  const verified = readOnly || explicitlyVerified;
  return Object.assign(call, {
    state: verified ? STATE.SUCCESS : STATE.UNCONFIRMED,
    verified,
    result: out.result,
    verification: { verified, source: readOnly ? 'read_result' : (explicitlyVerified ? 'tool_result' : 'verifier_missing') },
    finishedAt: new Date().toISOString(),
  });
}

async function executeConnectorTool(tenant, name, args, ctx, call) {
  const fullCtx = Object.assign({ tenant }, ctx || {});
  const principal = authz.isPrincipal(fullCtx.principal) ? fullCtx.principal : authz.currentPrincipal();
  if (!authz.isPrincipal(principal)) return Object.assign(call, { state: STATE.BLOCKED, error: { code: 'NOT_AUTHENTICATED' }, finishedAt: new Date().toISOString() });
  if (String(tenant) !== principal.tenant && principal.role !== 'ADMIN') return Object.assign(call, { state: STATE.BLOCKED, error: { code: 'TENANT_MISMATCH' }, finishedAt: new Date().toISOString() });
  const auth = authz.authorizeTool({ tool: { roles: ['OWNER', 'ADMIN'] }, toolName: name, tenant, principal });
  if (!auth.allowed) return Object.assign(call, { state: STATE.BLOCKED, error: { code: auth.code, message: auth.message }, finishedAt: new Date().toISOString() });

  const manager = require('./connectors/connectorManager');
  let available = [];
  try { available = await manager.getToolsForTenant(tenant); }
  catch (err) { return Object.assign(call, { state: STATE.FAILED, error: { code: 'CONNECTOR_CATALOG_UNAVAILABLE' }, finishedAt: new Date().toISOString() }); }
  const descriptor = available.find((item) => item.name === name);
  if (!descriptor) return Object.assign(call, { state: STATE.BLOCKED, error: { code: 'TOOL_NOT_AVAILABLE_OR_NOT_PERMITTED', message: `L'outil « ${name} » n'est pas activé pour ce compte ou son scope manque.` }, finishedAt: new Date().toISOString() });

  call.risk = 'WRITE';
  const effectiveArgs = args && typeof args === 'object' && !Array.isArray(args) ? Object.assign({}, args) : {};
  call.args = effectiveArgs;
  const missing = Object.entries(descriptor.parameters || {}).filter(([key, spec]) => spec.required && (effectiveArgs[key] == null || effectiveArgs[key] === '')).map(([key]) => key);
  if (missing.length) return Object.assign(call, { state: STATE.FAILED, error: { code: 'MISSING_INPUT', fields: missing }, finishedAt: new Date().toISOString() });
  const invalid = validateArgs(descriptor.parameters || {}, effectiveArgs);
  if (invalid.length) return Object.assign(call, { state: STATE.FAILED, error: { code: 'INVALID_INPUT', fields: invalid }, finishedAt: new Date().toISOString() });
  const tainted = authz.isTainted() && !fullCtx.confirmed;
  if ((needsConfirmation('WRITE', fullCtx) || tainted) && !fullCtx.confirmed) {
    return Object.assign(call, { state: STATE.NEEDS_CONFIRMATION, result: { ok: true, preview: previewOf(effectiveArgs), warnings: tainted ? ['CONTENU_EXTERNE'] : [] }, finishedAt: new Date().toISOString() });
  }

  let out;
  try {
    out = await manager.executeTool(principal.tenant, name, effectiveArgs, {
      env: fullCtx.env, http: fullCtx.http, store: fullCtx.store,
    });
  } catch (err) {
    return Object.assign(call, { state: STATE.FAILED, error: { code: 'CONNECTOR_EXECUTION_ERROR', message: String(err.message || err) }, finishedAt: new Date().toISOString() });
  }
  if (!out || out.ok !== true) {
    return Object.assign(call, { state: STATE.FAILED, error: { code: (out && out.error) || 'CONNECTOR_FAILED', detail: out && out.detail || null }, result: out && out.result || null, finishedAt: new Date().toISOString() });
  }

  const result = out.result || null;
  if (out.state === STATE.PARTIAL_SUCCESS || out.partial === true || (result && result.partial === true)) {
    return Object.assign(call, { state: STATE.PARTIAL_SUCCESS, verified: false, result,
      verification: { verified: false, source: 'partial_connector_result' }, finishedAt: new Date().toISOString() });
  }
  let verified = !!(result && (result.verified === true || result.confirmed === true));
  let verification = { verified, source: verified ? 'connector_result' : 'provider_acknowledgement' };
  // The local ledger can be checked deterministically after its write.
  if (!verified && descriptor.connectorType === 'accounting' && result && result.provider === 'ledger-local') {
    const ledger = await require('./storageAdapter').get('ledger', principal.tenant, { sales: [], invoices: [] }).catch(() => null);
    const saved = result.entry && Array.isArray(ledger && ledger.sales) && ledger.sales.some((entry) => entry.id === result.entry.id);
    const invoiced = result.invoice && Array.isArray(ledger && ledger.invoices) && ledger.invoices.some((entry) => entry.number === result.invoice.number);
    verified = !!(saved || invoiced);
    verification = { verified, source: 'tenant_ledger_readback' };
  }
  return Object.assign(call, { state: verified ? STATE.SUCCESS : STATE.UNCONFIRMED, verified, result, verification, finishedAt: new Date().toISOString() });
}

// Exécution + journalisation d'activité (déterministe, non bloquante) : chaque
// tool call réel devient un évènement dans l'interface de supervision.
async function execute(tenant, name, args, ctx) {
  const call = await _execute(tenant, name, args, ctx);
  try {
    const status = call.state === STATE.SUCCESS ? 'ok'
      : (call.state === STATE.UNCONFIRMED || call.state === STATE.BLOCKED ? 'warning' : 'error');
    require('./activityStore').record({
      type: 'tool_call', action: name, status, tenant,
      detail: call.state + (call.error && call.error.code ? ' — ' + call.error.code : ''),
    });
  } catch (e) { /* non bloquant */ }
  return call;
}

// Enchaînement RÉEL d'outils : chaque étape peut piocher dans les résultats des
// précédentes via une fonction `argsFrom(prevResults)`. S'arrête à la première
// étape non-SUCCESS (et non-UNCONFIRMED si `stopOnUnconfirmed`).
async function runChain(tenant, steps, ctx, opts) {
  const results = [];
  const stopOnUnconfirmed = !(opts && opts.continueOnUnconfirmed);
  for (const step of (steps || [])) {
    const args = typeof step.argsFrom === 'function' ? step.argsFrom(results.map((r) => r.result), results) : (step.args || {});
    const res = await execute(tenant, step.name, args, ctx);
    results.push(res);
    if (res.state === STATE.FAILED || res.state === STATE.BLOCKED) break;
    if (res.state === STATE.UNCONFIRMED && stopOnUnconfirmed) break;
  }
  return { ok: results.every((r) => r.state === STATE.SUCCESS), steps: results };
}

// Étape PREPARE explicite (sans effet de bord) pour un outil sensible.
async function prepare(tenant, name, args, ctx) {
  const tool = TOOLS[name];
  if (!tool) return { state: STATE.FAILED, error: { code: 'UNKNOWN_TOOL' } };
  const fullCtx = Object.assign({ tenant }, ctx || {});
  const prepared = typeof tool.prepare === 'function' ? await tool.prepare(args || {}, fullCtx) : { ok: true, preview: args || {}, warnings: [] };
  return { state: 'PREPARED', risk: tool.risk, needsConfirmation: needsConfirmation(tool.risk, fullCtx), prepared };
}

module.exports = { STATE, RISK, TOOLS, describe, list, listForContext, search, discover, execute, prepare, runChain, needsConfirmation, registerTool, loadToolModules, validateArgs };
