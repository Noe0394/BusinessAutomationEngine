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

// Niveaux de risque : la confirmation est configurable (ctx.confirmFrom = premier
// niveau exigeant une confirmation). SENSITIVE et CRITICAL l'exigent toujours.
const RISK = { READ: 0, LOW_WRITE: 1, WRITE: 2, SENSITIVE: 3, CRITICAL: 4 };
function needsConfirmation(risk, ctx) {
  const r = RISK[risk] == null ? RISK.WRITE : RISK[risk];
  const from = ctx && ctx.confirmFrom != null && RISK[ctx.confirmFrom] != null ? RISK[ctx.confirmFrom] : RISK.SENSITIVE;
  return r >= Math.min(from, RISK.SENSITIVE);
}

const STATE = {
  NEEDS_CONFIRMATION: 'NEEDS_CONFIRMATION',
  PENDING: 'PENDING', RUNNING: 'RUNNING', SUCCESS: 'SUCCESS',
  FAILED: 'FAILED', BLOCKED: 'BLOCKED', UNCONFIRMED: 'UNCONFIRMED',
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
    resultSchema: { services: 'array<{id,name,type,price,connected}>' },
    errorSchema: { code: 'string' },
    async execute(args, ctx) {
      const services = await businessServices.list(ctx.tenant);
      return { ok: true, result: { count: services.length, services: services.map((s) => ({
        id: s.id, name: s.name, type: s.type,
        price: s.commercial && s.commercial.price != null ? s.commercial.price : null,
        currency: (s.commercial && s.commercial.currency) || null,
        connected: s.status === 'CONNECTED',
      })) } };
    },
  },

  getProductPrice: {
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
    description: 'Crée (et éventuellement connecte l\'API + teste) un Service Métier à partir d\'instructions en langage naturel : nom, type d\'activité, prix, produits, règles, objectifs, et connexion API (URL + clé + permissions). Retourne le service créé et, si une API est fournie, le résultat RÉEL du test de connexion.',
    permission: null,
    risk: 'LOW_WRITE',
    inputSchema: {
      name: { type: 'string', required: true, description: 'Nom du service/projet.' },
      type: { type: 'string', required: false, description: 'Type d\'activité (formation, ecommerce, service…).' },
      price: { type: 'number', required: false, description: 'Prix principal.' },
      currency: { type: 'string', required: false, description: 'Devise (défaut FCFA).' },
      description: { type: 'string', required: false, description: 'Description de l\'offre.' },
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
      const svc = await businessServices.create(ctx.tenant, {
        name: args.name, type: args.type || 'autre', connection, scopes,
        commercial: { price: args.price != null ? Number(args.price) : null, currency: args.currency || 'FCFA', description: args.description || '' },
        products, rules: splitList(args.rules), objectives: splitList(args.objectives),
      });
      let test = null; let connected = false;
      if (args.apiKey && args.baseUrl) {
        await businessServices.connectApi(ctx.tenant, svc.id, { apiKey: args.apiKey, baseUrl: args.baseUrl, authHeader: connection.authHeader, connectorType: connection.connectorType, endpoints: connection.endpoints });
        const t = await businessServices.testConnection(ctx.tenant, svc.id);
        test = t.result; connected = t.status === 'CONNECTED';
      }
      return { ok: true, result: { serviceId: svc.id, name: svc.name, connected, test } };
    },
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
      let rows = [];
      try {
        const XLSX = require('xlsx');
        let wb;
        if (meta.hasText && meta.text) wb = XLSX.read(meta.text, { type: 'string' });
        else {
          const fs = require('fs'); const path = require('path');
          const root = process.env.AI_ENGINE_STORAGE_DIR || path.join(__dirname, '..', 'ai_engine_data');
          const buf = fs.readFileSync(path.join(root, 'chat_uploads', String(ctx.tenant).replace(/[^A-Za-z0-9_-]/g, '_') || 'unknown', args.fileId));
          wb = XLSX.read(buf, { type: 'buffer' });
        }
        rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]]);
      } catch (e) { return { ok: false, error: { code: 'PARSE_ERROR', message: e.message } }; }
      const contacts = rows.map((r) => {
        const name = String(r.nom || r.Nom || r.prenom || r.Prenom || r.name || r.Name || '').trim();
        const phone = String(r.telephone || r.Telephone || r.phone || r.Phone || r.numero || r.Numero || r.tel || r.Tel || '').trim();
        return { name, phone };
      });
      const report = await contactCrm.importContacts(ctx.tenant, contacts, { source: 'chat_import' });
      return { ok: true, result: report };
    },
  },

  generateImage: {
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
    inputSchema: {},
    resultSchema: { total: 'number', byTag: 'object' },
    errorSchema: { code: 'string' },
    async execute(args, ctx) {
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
      if (ctx.autonomous && await contactCrm.isOptedOut(ctx.tenant, 'WHATSAPP', args.to)) return { ok: false, error: { code: 'RECIPIENT_OPTED_OUT', message: 'Ce contact a refusé toute sollicitation.' } };
      const out = await ctx.runtime.sendMessageVerified({ channel: 'WHATSAPP', to: args.to, text: args.text, tenantId: ctx.tenant });
      if (out.status === 'FAILED') return { ok: false, error: { code: 'SEND_FAILED', message: out.error || 'non confirmé' } };
      return { ok: true, result: { status: out.status, confirmationId: out.confirmationId || null } };
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
      if (ctx.autonomous && await contactCrm.isOptedOut(ctx.tenant, 'TELEGRAM', args.to)) return { ok: false, error: { code: 'RECIPIENT_OPTED_OUT', message: 'Ce contact a refusé toute sollicitation.' } };
      const out = await ctx.runtime.sendMessageVerified({ channel: 'TELEGRAM', to: args.to, text: args.text, tenantId: ctx.tenant });
      if (out.status === 'FAILED') return { ok: false, error: { code: 'SEND_FAILED', message: out.error || 'non confirmé' } };
      return { ok: true, result: { status: out.status, confirmationId: out.confirmationId || null } };
    },
    async verify(result) { return { verified: result && result.status === 'SUCCESS' && !!result.confirmationId, confirmationId: result && result.confirmationId }; },
  },
};

// Outils étendus (contacts, campagnes, file, CRM, diagnostic, notifications) — voir toolsExtra.js
for (const [name, tool] of Object.entries(require('./toolsExtra').TOOLS)) TOOLS[name] = Object.assign({ resultSchema: {}, errorSchema: { code: 'string' } }, tool);

// --------------------------------------------------------------------------
// API publique
// --------------------------------------------------------------------------
function describe() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name, description: t.description, permission: t.permission || null, risk: t.risk || 'READ',
    inputSchema: t.inputSchema || {}, resultSchema: t.resultSchema || {}, errorSchema: t.errorSchema || {},
  }));
}

// Liste des outils réellement UTILISABLES pour ce contexte (permissions).
function list(ctx) {
  const perms = (ctx && Array.isArray(ctx.permissions)) ? ctx.permissions : null;
  return describe().filter((t) => !t.permission || !perms || perms.includes(t.permission));
}

async function _execute(tenant, name, args, ctx) {
  const call = { name, args: args || {}, state: STATE.PENDING, startedAt: new Date().toISOString() };
  const tool = TOOLS[name];
  if (!tool) return Object.assign(call, { state: STATE.FAILED, error: { code: 'UNKNOWN_TOOL', message: `Outil « ${name} » inconnu.` }, finishedAt: new Date().toISOString() });

  const fullCtx = Object.assign({ tenant }, ctx || {});
  // Permission
  if (tool.permission && Array.isArray(fullCtx.permissions) && !fullCtx.permissions.includes(tool.permission)) {
    return Object.assign(call, { state: STATE.BLOCKED, error: { code: 'PERMISSION_DENIED', permission: tool.permission }, finishedAt: new Date().toISOString() });
  }
  // Validation des entrées requises
  const missing = Object.entries(tool.inputSchema || {})
    .filter(([k, s]) => s.required && (args == null || args[k] == null || args[k] === ''))
    .map(([k]) => k);
  if (missing.length) return Object.assign(call, { state: STATE.FAILED, error: { code: 'MISSING_INPUT', fields: missing }, finishedAt: new Date().toISOString() });

  if (needsConfirmation(tool.risk, fullCtx) && !fullCtx.confirmed) {
    const prepared = typeof tool.prepare === 'function' ? await tool.prepare(args || {}, fullCtx).catch(() => null) : null;
    return Object.assign(call, { state: STATE.NEEDS_CONFIRMATION, risk: tool.risk, result: prepared, finishedAt: new Date().toISOString() });
  }

  call.state = STATE.RUNNING;
  let out;
  try { out = await tool.execute(args || {}, fullCtx); }
  catch (err) { return Object.assign(call, { state: STATE.FAILED, error: { code: 'EXECUTION_ERROR', message: String((err && err.message) || err) }, finishedAt: new Date().toISOString() }); }

  if (!out || out.ok === false) {
    return Object.assign(call, { state: STATE.FAILED, error: (out && out.error) || { code: 'FAILED' }, result: (out && out.result) || null, finishedAt: new Date().toISOString() });
  }
  // Vérification réelle (outils d'action) — sinon SUCCESS direct (lectures).
  if (typeof tool.verify === 'function') {
    let v;
    try { v = await tool.verify(out.result, args || {}, fullCtx); } catch (e) { v = { verified: false }; }
    return Object.assign(call, { state: v && v.verified ? STATE.SUCCESS : STATE.UNCONFIRMED, result: out.result, verification: v, finishedAt: new Date().toISOString() });
  }
  return Object.assign(call, { state: STATE.SUCCESS, result: out.result, finishedAt: new Date().toISOString() });
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

module.exports = { STATE, RISK, TOOLS, describe, list, execute, prepare, runChain, needsConfirmation };
