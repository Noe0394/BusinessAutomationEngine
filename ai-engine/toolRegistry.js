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

const STATE = {
  PENDING: 'PENDING', RUNNING: 'RUNNING', SUCCESS: 'SUCCESS',
  FAILED: 'FAILED', BLOCKED: 'BLOCKED', UNCONFIRMED: 'UNCONFIRMED',
};

function norm(s) { return String(s == null ? '' : s).trim().toLowerCase(); }

// --------------------------------------------------------------------------
// Définition des outils réels
// --------------------------------------------------------------------------
const TOOLS = {
  // ---- Services Métiers (données réelles configurées par le vendeur) -------
  getBusinessServices: {
    description: 'Liste les Services Métiers configurés (nom, activité, prix, statut de connexion) — sans aucun secret.',
    permission: null,
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
    inputSchema: {},
    resultSchema: { text: 'string' },
    errorSchema: { code: 'string' },
    async execute(args, ctx) {
      const text = await businessServices.getEngineContextText(ctx.tenant);
      return { ok: true, result: { text, hasData: !!text } };
    },
  },

  // ---- Contacts / CRM (données réelles) -----------------------------------
  countContacts: {
    description: 'Compte les contacts connus, avec répartition par étiquette (prospect/client/…).',
    permission: null,
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
        direction: m.direction, name: m.name || null, party: m.party, text: m.text || null, ts: m.ts || null,
      })) } };
    },
  },

  searchMessages: {
    description: 'Recherche un mot/expression dans l\'historique persistant des messages d\'un canal.',
    permission: null,
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
      return { ok: true, result: { channel, count: matches.length, matches: matches.slice(-50).map((m) => ({ direction: m.direction, name: m.name || null, party: m.party, text: m.text || null, ts: m.ts || null })) } };
    },
  },

  getMessagesByDate: {
    description: 'Renvoie les messages d\'un canal reçus/envoyés sur les N derniers jours (ex. avant-hier = 2).',
    permission: null,
    inputSchema: {
      sinceDays: { type: 'number', required: true, description: 'Nombre de jours en arrière (1 = aujourd\'hui, 2 = hier inclus…).' },
      channel: { type: 'string', required: false, description: 'WHATSAPP (défaut) ou TELEGRAM.' },
    },
    resultSchema: { count: 'number', messages: 'array' },
    errorSchema: { code: 'string' },
    async execute(args, ctx) {
      const channel = /telegram/i.test(args.channel || '') ? 'TELEGRAM' : 'WHATSAPP';
      const msgs = await messageHistory.getSince(ctx.tenant, channel, args.sinceDays || 2);
      return { ok: true, result: { channel, sinceDays: args.sinceDays, count: (msgs || []).length, messages: (msgs || []).slice(-100).map((m) => ({ direction: m.direction, name: m.name || null, party: m.party, text: m.text || null, ts: m.ts || null })) } };
    },
  },

  // ---- Actions sortantes VÉRIFIÉES ----------------------------------------
  sendWhatsAppMessage: {
    description: 'Envoie un message WhatsApp et VÉRIFIE l\'envoi (identifiant réel). SUCCESS seulement si confirmé.',
    permission: 'messages:send',
    inputSchema: {
      to: { type: 'string', required: true, description: 'Destinataire (numéro ou JID).' },
      text: { type: 'string', required: true, description: 'Texte à envoyer.' },
    },
    resultSchema: { status: 'string', confirmationId: 'string' },
    errorSchema: { code: 'string', message: 'string' },
    async execute(args, ctx) {
      if (!ctx.runtime || typeof ctx.runtime.sendMessageVerified !== 'function') return { ok: false, error: { code: 'RUNTIME_MISSING' } };
      const out = await ctx.runtime.sendMessageVerified({ channel: 'WHATSAPP', to: args.to, text: args.text, tenantId: ctx.tenant });
      if (out.status === 'FAILED') return { ok: false, error: { code: 'SEND_FAILED', message: out.error || 'non confirmé' } };
      return { ok: true, result: { status: out.status, confirmationId: out.confirmationId || null } };
    },
    async verify(result) { return { verified: result && result.status === 'SUCCESS' && !!result.confirmationId, confirmationId: result && result.confirmationId }; },
  },

  sendTelegramMessage: {
    description: 'Envoie un message Telegram et VÉRIFIE l\'envoi (identifiant réel). SUCCESS seulement si confirmé.',
    permission: 'messages:send',
    inputSchema: {
      to: { type: 'string', required: true, description: 'Destinataire (@username, numéro, ou id).' },
      text: { type: 'string', required: true, description: 'Texte à envoyer.' },
    },
    resultSchema: { status: 'string', confirmationId: 'string' },
    errorSchema: { code: 'string', message: 'string' },
    async execute(args, ctx) {
      if (!ctx.runtime || typeof ctx.runtime.sendMessageVerified !== 'function') return { ok: false, error: { code: 'RUNTIME_MISSING' } };
      const out = await ctx.runtime.sendMessageVerified({ channel: 'TELEGRAM', to: args.to, text: args.text, tenantId: ctx.tenant });
      if (out.status === 'FAILED') return { ok: false, error: { code: 'SEND_FAILED', message: out.error || 'non confirmé' } };
      return { ok: true, result: { status: out.status, confirmationId: out.confirmationId || null } };
    },
    async verify(result) { return { verified: result && result.status === 'SUCCESS' && !!result.confirmationId, confirmationId: result && result.confirmationId }; },
  },
};

// --------------------------------------------------------------------------
// API publique
// --------------------------------------------------------------------------
function describe() {
  return Object.entries(TOOLS).map(([name, t]) => ({
    name, description: t.description, permission: t.permission || null,
    inputSchema: t.inputSchema || {}, resultSchema: t.resultSchema || {}, errorSchema: t.errorSchema || {},
  }));
}

// Liste des outils réellement UTILISABLES pour ce contexte (permissions).
function list(ctx) {
  const perms = (ctx && Array.isArray(ctx.permissions)) ? ctx.permissions : null;
  return describe().filter((t) => !t.permission || !perms || perms.includes(t.permission));
}

async function execute(tenant, name, args, ctx) {
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

module.exports = { STATE, TOOLS, describe, list, execute, runChain };
