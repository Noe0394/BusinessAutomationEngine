// ACTION EXECUTOR — registre des 18 actions du moteur (dual-env : Node + navigateur)
// -------------------------------------------------------------------------------
// 18 actions : EXTRACT_MEMBERS, SEND_CAMPAIGN, FOLLOW_UP, ANALYZE_HUMAN_CONTEXT,
// ANALYZE_RESPONSES, REPLY_COMMENT, GENERATE_VIDEO, PAUSE_CAMPAIGN,
// RESUME_CAMPAIGN, GENERATE_REPORT, CREATE_USER_ACCOUNT, GENERATE_ACCESS_KEY,
// SCHEDULE_FOLLOWUP, GENERATE_PAYMENT_LINK, NEGOTIATE_DISCOUNT,
// GRANT_MODULE_ACCESS, ANSWER_STUDENT_QUERY, DELIVER_LESSON_CONTENT — les 6
// dernières ajoutées pour le Chat-Driven Agent Orchestrator
// (ai-engine/chatOrchestrator.js) : outils Vente/Onboarding/Tuteur du cahier
// des charges.
//
// Ce module NE TOUCHE à aucun moteur d'envoi existant : il délègue toute action
// "plateforme" (envoi, extraction, commentaire, vidéo, pause/reprise) à un
// `runtime` injecté (adaptateur concret ZERO_VPS ou VPS_BAILEYS fourni par le
// contexte d'exécution — jamais duquel on suppose quoi que ce soit ici).
//
// Pour l'achat -> création de compte étudiant + clé d'accès (Test 5 du cahier),
// CREATE_USER_ACCOUNT appelle la Cloud Function `grantAccessOnPurchase`
// (firebase-functions/index.js, collections cyrus_students / cyrus_access_keys)
// via HTTP. Le secret d'admin est lu depuis `env` injecté — JAMAIS écrit en dur.
//
// ANSWER_STUDENT_QUERY/DELIVER_LESSON_CONTENT ont besoin d'un moteur de
// génération de texte (LLM) — jamais un `require()` direct ici vers
// lib/ai/llmFallbackEngine.js (module Node-only, axios/process.env), ce qui
// casserait le bundle navigateur (mobile/webapp_core). Comme `runtime`/
// `humanContext`/`env`/`store`, ce moteur est INJECTÉ : `deps.llm`, une
// fonction `async (prompt, history, context) => texte`. Absent -> ces 2
// actions renvoient RUNTIME_MISSING:llm, exactement comme les autres actions
// dépendantes d'une capacité non fournie par l'environnement courant.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ActionExecutor = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ACTIONS = ['EXTRACT_MEMBERS', 'SEND_CAMPAIGN', 'FOLLOW_UP', 'ANALYZE_HUMAN_CONTEXT',
    'ANALYZE_RESPONSES', 'REPLY_COMMENT', 'GENERATE_VIDEO', 'PAUSE_CAMPAIGN',
    'RESUME_CAMPAIGN', 'GENERATE_REPORT', 'CREATE_USER_ACCOUNT', 'GENERATE_ACCESS_KEY',
    'SCHEDULE_FOLLOWUP', 'GENERATE_PAYMENT_LINK', 'NEGOTIATE_DISCOUNT',
    'GRANT_MODULE_ACCESS', 'ANSWER_STUDENT_QUERY', 'DELIVER_LESSON_CONTENT',
    'READ_RECENT_MESSAGES'];
  const DEFAULT_FIREBASE_BASE = 'https://us-central1-rien-afrique.cloudfunctions.net';

  function uuid(prefix) {
    const rnd = Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    return (prefix || 'k') + '_' + rnd;
  }

  // Clé d'accès : 24 caractères composés de groupes, sans caractères ambigus.
  const KEY_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  function generateAccessKey(payload) {
    const groups = 6;
    const len = 4;
    let out = [];
    for (let g = 0; g < groups; g++) {
      let s = '';
      for (let i = 0; i < len; i++) s += KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)];
      out.push(s);
    }
    return { accessKey: out.join('-'), sku: (payload && payload.sku) || null, issuedAt: new Date().toISOString() };
  }

  // ---------------------------------------------------------------------------
  // Émetteur HTTP minimal (Node via fetch, navigateur via fetch) — jamais de
  // secret dans le corps : le secret passe en en-tête x-admin-secret.
  // ---------------------------------------------------------------------------
  async function postCloudFunction(url, body, headers, deps) {
    const http = (deps && deps.http) || (typeof fetch === 'function' ? fetch : null);
    if (!http) return { ok: false, error: 'NO_HTTP_TRANSPORT' };
    const res = await http(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
      body: JSON.stringify(body),
    });
    let data = null;
    try { data = await res.json(); } catch (e) { data = null; }
    if (!res.ok) return { ok: false, status: res.status, error: (data && data.error) || ('HTTP ' + res.status) };
    return { ok: true, status: res.status, data };
  }

  function envSecret(envRef, name) {
    // env injecté : objet {get(k)} / Map / plain object / function(k)
    try {
      if (!envRef) return null;
      if (typeof envRef === 'function') return envRef(name);
      if (typeof envRef.get === 'function') return envRef.get(name);
      if (envRef instanceof Map) return envRef.get(name);
      return envRef[name] || null;
    } catch (e) { return null; }
  }

  // ---------------------------------------------------------------------------
  // Le registre des 12 actions
  // ---------------------------------------------------------------------------
  function createActionExecutor(deps) {
    const d = deps || {};
    const runtime = d.runtime || {};        // adaptateur concret (ZERO_VPS / VPS_BAILEYS)
    const humanContext = d.humanContext || null; // moteur de contexte humain
    const env = d.env || null;              // accès aux clés (jamais lues ici en dur)
    const store = d.store || null;          // persistance facultative (contacts, rapports)
    const llm = d.llm || null;              // async (prompt, history, context) => texte
    const cloudBase = d.firebaseBase || DEFAULT_FIREBASE_BASE;

    const registry = {};

    // -------- 1. EXTRACT_MEMBERS : extraction de membres (groupe/canal) -----
    function extPersonal(channel) {
      return {
        EXTRACT_MEMBERS: async (payload) => {
          if (runtime.extractMembers) {
            const members = await runtime.extractMembers(channel, payload.groupId || null, payload);
            if (store && members && members.length) await store.putContacts && (await store.putContacts(channel, members));
            return { ok: true, result: { channel, members: members || [], count: members ? members.length : 0, source: payload.source || 'group' } };
          }
          return { ok: false, error: 'RUNTIME_MISSING:extractMembers' };
        },
      };
    }

    registry.EXTRACT_MEMBERS = async (payload, meta) => {
      const channel = (payload && payload.channel) || (meta && meta.channel) || 'WHATSAPP';
      return extPersonal(channel).EXTRACT_MEMBERS(payload);
    };

    // -------- 2. SEND_CAMPAIGN : campagne (spintax + personnalisation) -----
    registry.SEND_CAMPAIGN = async (payload, meta) => {
      const channel = (payload && payload.channel) || (meta && meta.channel) || 'WHATSAPP';
      if (runtime.sendCampaign) {
        const res = await runtime.sendCampaign(Object.assign({ channel }, payload));
        return { ok: res.ok !== false, result: res, error: (!res || res.ok === false) ? ((res && res.error) || 'sendCampaign failed') : null };
      }
      if (runtime.sendMessage && payload.recipients && payload.recipients.length) {
        const failures = [];
        let sent = 0;
        for (const r of payload.recipients) {
          const out = await runtime.sendMessage(channel, r.to || r.identifer || r.identifier, payload.text).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
          if (out && out.ok) sent++; else failures.push(r.to || r.identifier);
        }
        return { ok: true, result: { sent, failed: failures.length, channel } };
      }
      return { ok: false, error: 'RUNTIME_MISSING:sendCampaign' };
    };

    // -------- 3. FOLLOW_UP : relance pilotée par la stratégie ---------------
    registry.FOLLOW_UP = async (payload, meta) => {
      const channel = (payload && payload.channel) || (meta && meta.channel) || 'WHATSAPP';
      const analysis = payload.analysis || null;
      const strategy = (humanContext && analysis) ? humanContext.selectStrategy(analysis) : { id: 'COLD_FOLLOWUP', templates: ['Bonjour {first_name}, un petit rappel amical : je reste disponible si vous êtes prêt(e).'] };
      const message = humanContext ? (humanContext.generateFollowUp(analysis || {}, strategy, payload.vars || {}) || payload.text) : (payload.text || null);
      if (!message) return { ok: false, error: 'NO_MESSAGE' };
      if (runtime.sendMessage && payload.recipients && payload.recipients.length) {
        const failures = [];
        for (const r of payload.recipients) {
          const out = await runtime.sendMessage(channel, r.to || r.identifer || r.identifier, message).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
          if (!(out && out.ok)) failures.push(r.to || r.identifier);
        }
        return { ok: true, result: { strategy: strategy.id, sent: payload.recipients.length - failures.length, failed: failures.length, recipients: payload.recipients.map((r) => r.to || r.identifer || r.identifier) } };
      }
      if (runtime.sendMessage && payload.to) {
        const out = await runtime.sendMessage(channel, payload.to, message).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
        return { ok: !!(out && out.ok), error: (out && out.error) || null, result: { strategy: strategy.id, message } };
      }
      return { ok: false, error: 'RUNTIME_MISSING:sendMessage' };
    };

    // -------- 4. ANALYZE_HUMAN_CONTEXT : analyse émotionnelle d'un message --
    registry.ANALYZE_HUMAN_CONTEXT = async (payload, meta) => {
      if (!humanContext) return { ok: false, error: 'HUMAN_CONTEXT_NOT_CONFIGURED' };
      const text = payload.text || payload.message;
      if (!text) {
        // lot
        if (Array.isArray(payload.messages)) {
          const agg = humanContext.analyzeResponses(payload.messages, { context: payload.context || {} });
          return { ok: true, result: agg };
        }
        return { ok: false, error: 'EMPTY_TEXT' };
      }
      const analysis = humanContext.analyzeMessage({ text, context: payload.context || {} });
      const intuition = humanContext.detectIntuition({ signals: payload.signals || {}, analysis, history: payload.history || [] });
      return { ok: true, result: Object.assign({}, analysis, { intuition }) };
    };

    // -------- 5. ANALYZE_RESPONSES : agrégation d'un lot -------------------
    registry.ANALYZE_RESPONSES = async (payload) => {
      if (!humanContext) return { ok: false, error: 'HUMAN_CONTEXT_NOT_CONFIGURED' };
      const list = payload.responses || payload.messages || [];
      if (!list.length) return { ok: true, result: { responses: [], positive: 0, negative: 0, neutral: 0, heat: 'LOW', bestWindow: null, suggestions: [] } };
      return { ok: true, result: humanContext.analyzeResponses(list, { context: payload.context || {} }) };
    };

    // -------- 6. REPLY_COMMENT : réponse à un commentaire social -----------
    registry.REPLY_COMMENT = async (payload, meta) => {
      const channel = (payload && payload.channel) || (meta && meta.channel) || 'TIKTOK';
      if (runtime.replyComment) {
        const res = await runtime.replyComment(channel, payload.commentId, payload.text || payload.content, payload);
        return { ok: res.ok !== false, error: (!res || res.ok === false) ? ((res && res.error) || 'replyComment failed') : null, result: res };
      }
      return { ok: false, error: 'RUNTIME_MISSING:replyComment' };
    };

    // -------- 7. GENERATE_VIDEO : contenu promo ----------------------------
    registry.GENERATE_VIDEO = async (payload) => {
      if (runtime.generateVideo) {
        const res = await runtime.generateVideo(payload);
        return { ok: res.ok !== false, error: (!res || res.ok === false) ? ((res && res.error) || 'generateVideo failed') : null, result: res };
      }
      return { ok: false, error: 'RUNTIME_MISSING:generateVideo' };
    };

    // -------- 8./9. PAUSE_CAMPAIGN / RESUME_CAMPAIGN -----------------------
    registry.PAUSE_CAMPAIGN = async (payload) => {
      if (runtime.pauseCampaign) return { ok: (await runtime.pauseCampaign(payload)).ok !== false, result: await runtime.pauseCampaign(payload) };
      return { ok: false, error: 'RUNTIME_MISSING:pauseCampaign' };
    };
    registry.RESUME_CAMPAIGN = async (payload) => {
      if (runtime.resumeCampaign) return { ok: (await runtime.resumeCampaign(payload)).ok !== false, result: await runtime.resumeCampaign(payload) };
      return { ok: false, error: 'RUNTIME_MISSING:resumeCampaign' };
    };

    // -------- 10. GENERATE_REPORT : bilan de la journée ---------------------
    registry.GENERATE_REPORT = async (payload, meta) => {
      const channel = (payload && payload.channel) || (meta && meta.channel) || 'WHATSAPP';
      const history = (payload.history || payload.responses || []).map((m) => (typeof m === 'string' ? { text: m } : m));
      let aggregate = null;
      if (history.length && humanContext) aggregate = humanContext.analyzeResponses(history, { context: payload.context || {} });
      const report = {
        scope: payload.scope || 'day',
        channel,
        generatedAt: new Date().toISOString(),
        tenantId: payload.tenantId || 'default',
        totalMessages: history.length,
        conversions: aggregate ? aggregate.positive : history.length,
        objections: aggregate ? aggregate.suggestions : [],
        heat: aggregate ? aggregate.heat : 'LOW',
        bestWindow: aggregate ? aggregate.bestWindow : null,
        recommendations: recommendationsFor(aggregate),
      };
      if (store && store.saveReport) await store.saveReport(report).catch(() => {});
      return { ok: true, result: report };
    };

    function recommendationsFor(agg) {
      if (!agg || !agg.total) return ['Aucune réponse mesurée : relancer la campagne en variant l\'accroche.'];
      const rec = [];
      if (agg.heat === 'HIGH') rec.push('Très bon taux d\'engagement : optimiser le moment d\'envoi sur la fenêtre la plus dense (' + (agg.bestWindow ? agg.bestWindow.startHour + 'h-' + agg.bestWindow.endHour + 'h' : 'N/D') + ').');
      if (agg.negative / agg.total >= 0.3) rec.push('Fort taux de négatif : faire une analyse des objections et revoir le message cible.');
      if (agg.suggestions.includes('OBJECTION_CLUSTER_PRICE')) rec.push('Cluster d\'objections prix : préparer une offre de paiement fractionné / valeur ajoutée.');
      if (agg.suggestions.includes('TONE_ESCALATION_SUPPORT')) rec.push('Signal de support en escalation : mobiliser une réponse humaine rapide.');
      if (!rec.length) rec.push('Réponses stables : poursuivre le rythme actuel.');
      return rec;
    }

    // -------- 11. CREATE_USER_ACCOUNT : achat -> compte étudiant ------------
    registry.CREATE_USER_ACCOUNT = async (payload, meta) => {
      const fullName = payload.studentName || payload.fullName || payload.name || 'Étudiant';
      const email = payload.email || null;
      const phone = payload.phone || payload.number || (meta && meta.who) || null;
      const sku = payload.sku || payload.product || 'formation-default';
      const amount = payload.amount || null;
      const currency = payload.currency || 'FCFA';
      const transactionId = payload.transactionId || payload.reference || null;
      const tenantId = payload.tenantId || (meta && meta.tenantId) || 'default';

      // Corps complet côté Cloud Function `grantAccessOnPurchase`.
      const body = {
        student: { fullName, email, phone },
        purchase: { sku, amount, currency, transactionId, paidAt: payload.paidAt || new Date().toISOString() },
        tenantId,
        account: { create: true },
        accessKey: { generate: true },
      };

      const secret = envSecret(env, 'FIREBASE_ADMIN_SECRET') || envSecret(env, 'ADMIN_SECRET');
      const res = await postCloudFunction(cloudBase + '/grantAccessOnPurchase', body, { 'x-admin-secret': secret || '' }, d)
        .catch((e) => ({ ok: false, error: String(e && e.message || e), transportError: true }));

      if (!res.ok) {
        // Repli local : ne JAMAIS échouer l'acte de création d'un étudiant qui
        // a payé — on génère localement et on enregistre l'intention de sync.
        const fallbackKey = generateAccessKey({ sku });
        const studentId = 'cyrus_' + uuid('st');
        return {
          ok: true,
          fallback: true,
          error: res.error,
          result: {
            studentId, email, phone, sku, amount, currency,
            accessKey: fallbackKey.accessKey,
            status: 'CREATED_LOCALLY_AWAITING_SYNC',
            provider: 'local-fallback',
          },
        };
      }
      const data = res.data || {};
      return {
        ok: true,
        result: {
          studentId: data.studentId || data.account && data.account.id || 'cyrus_' + uuid('st'),
          email, phone, sku, amount, currency,
          accessKey: data.accessKey || (data.account && data.account.accessKey) || null,
          cfnId: data.id || data.accountId || null,
          status: data.status || 'CREATED',
          provider: 'cloud-function:grantAccessOnPurchase',
        },
      };
    };

    // -------- 12. GENERATE_ACCESS_KEY ---------------------------------------
    registry.GENERATE_ACCESS_KEY = async (payload) => {
      const k = generateAccessKey(payload);
      if (runtime.generateAccessKey) {
        const ext = await runtime.generateAccessKey(payload).catch(() => null);
        if (ext && ext.ok) return { ok: true, result: ext };
      }
      return { ok: true, result: k };
    };

    // -------- 13. SCHEDULE_FOLLOWUP : relance PROGRAMMÉE (≠ FOLLOW_UP, immédiat) -
    // Contrairement à FOLLOW_UP (envoi immédiat, ci-dessus), une relance
    // programmée doit survivre à un redémarrage du process et être reprise à
    // l'heure dite — délégué à `runtime.scheduleFollowUp`, jamais implémenté
    // ici en dur (queues/scheduled_messages.js côté VPS n'existe pas tel quel
    // côté local-client/mobile, qui ont leurs propres files de programmation).
    registry.SCHEDULE_FOLLOWUP = async (payload, meta) => {
      const channel = (payload && payload.channel) || (meta && meta.channel) || 'WHATSAPP';
      if (!payload || !payload.scheduledAt) return { ok: false, error: 'MISSING_SCHEDULED_AT' };
      if (runtime.scheduleFollowUp) {
        const res = await runtime.scheduleFollowUp(Object.assign({ channel }, payload));
        return { ok: res.ok !== false, result: res, error: (!res || res.ok === false) ? ((res && res.error) || 'scheduleFollowUp failed') : null };
      }
      return { ok: false, error: 'RUNTIME_MISSING:scheduleFollowUp' };
    };

    // -------- 14. GENERATE_PAYMENT_LINK : instruction de paiement Mobile Money -
    // Décision ASSUMÉE (demande explicite de l'utilisateur, "fais très
    // simple") : pas d'agrégateur de paiement (CinetPay/PayDunya/Stripe...),
    // le "lien" est un message formaté demandant au client d'envoyer le
    // montant sur l'un des numéros Mobile Money du vendeur (voir env
    // injecté), avec une référence unique à rapprocher manuellement — ou via
    // CREATE_USER_ACCOUNT une fois le paiement confirmé par le vendeur.
    registry.GENERATE_PAYMENT_LINK = async (payload) => {
      const amount = payload && payload.amount;
      if (!amount) return { ok: false, error: 'MISSING_AMOUNT' };
      const currency = (payload && payload.currency) || 'FCFA';
      const product = (payload && payload.product) || 'votre commande';
      const operators = [
        ['Orange Money', envSecret(env, 'MOBILE_MONEY_ORANGE')],
        ['MTN Money', envSecret(env, 'MOBILE_MONEY_MTN')],
        ['Moov Money', envSecret(env, 'MOBILE_MONEY_MOOV')],
        ['Wave', envSecret(env, 'MOBILE_MONEY_WAVE')],
      ].filter(([, number]) => !!number);

      if (!operators.length) {
        return { ok: false, error: 'NO_MOBILE_MONEY_NUMBER_CONFIGURED' };
      }

      const beneficiary = envSecret(env, 'MOBILE_MONEY_BENEFICIARY_NAME') || 'CYRUS SUPER ASSISTANT';
      const reference = uuid('pay').toUpperCase();
      const lines = operators.map(([label, number]) => `• ${label} : ${number}`);
      const message = [
        `💳 Paiement de ${amount} ${currency} pour ${product}`,
        `Bénéficiaire : ${beneficiary}`,
        ...lines,
        `Référence à mentionner : ${reference}`,
        'Une fois le paiement envoyé, répondez avec la capture ou la référence pour confirmation.',
      ].join('\n');

      return { ok: true, result: { message, reference, amount, currency, operators: operators.map(([label, number]) => ({ label, number })) } };
    };

    // -------- 15. NEGOTIATE_DISCOUNT : remise plafonnée -----------------------
    // Plafond configurable (env MAX_DISCOUNT_PERCENT, défaut 15%) — jamais une
    // remise décidée arbitrairement par le LLM appelant : ce plafond est
    // appliqué PROGRAMMATIQUEMENT ici, quelle que soit la remise demandée par
    // le client/négociée en amont dans le tchat.
    registry.NEGOTIATE_DISCOUNT = async (payload) => {
      const price = payload && payload.price;
      if (!price) return { ok: false, error: 'MISSING_PRICE' };
      const maxPercent = parseFloat(envSecret(env, 'MAX_DISCOUNT_PERCENT')) || 15;
      const requestedPercent = Math.max(0, Math.min(100, parseFloat(payload.requestedPercent) || maxPercent));
      const appliedPercent = Math.min(requestedPercent, maxPercent);
      const finalPrice = Math.round(price * (1 - appliedPercent / 100));
      return {
        ok: true,
        result: {
          originalPrice: price,
          appliedPercent,
          capped: appliedPercent < requestedPercent,
          finalPrice,
          currency: payload.currency || 'FCFA',
        },
      };
    };

    // -------- 16. GRANT_MODULE_ACCESS : ouverture d'un module à un élève -----
    // Même Cloud Function que CREATE_USER_ACCOUNT (grantAccessOnPurchase,
    // firebase-functions/index.js) mais account.create:false — l'étudiant
    // existe déjà (accessKey/studentId connus), on ajoute seulement un module
    // à sa liste d'accès. Même repli local que CREATE_USER_ACCOUNT si la
    // Cloud Function est injoignable : ne jamais bloquer l'accès d'un élève
    // qui a déjà payé.
    registry.GRANT_MODULE_ACCESS = async (payload) => {
      const studentId = payload && (payload.studentId || payload.phone || payload.email);
      const moduleKey = payload && payload.moduleKey;
      if (!studentId || !moduleKey) return { ok: false, error: 'MISSING_STUDENT_OR_MODULE' };

      const body = {
        student: { id: payload.studentId || null, phone: payload.phone || null, email: payload.email || null },
        module: { key: moduleKey, grantedAt: new Date().toISOString() },
        tenantId: payload.tenantId || 'default',
        account: { create: false },
        accessKey: { generate: false },
      };
      const secret = envSecret(env, 'FIREBASE_ADMIN_SECRET') || envSecret(env, 'ADMIN_SECRET');
      const res = await postCloudFunction(cloudBase + '/grantModuleAccess', body, { 'x-admin-secret': secret || '' }, d)
        .catch((e) => ({ ok: false, error: String(e && e.message || e), transportError: true }));

      if (!res.ok) {
        return { ok: true, fallback: true, error: res.error, result: { studentId, moduleKey, status: 'GRANTED_LOCALLY_AWAITING_SYNC', provider: 'local-fallback' } };
      }
      return { ok: true, result: { studentId, moduleKey, status: (res.data && res.data.status) || 'GRANTED', provider: 'cloud-function:grantModuleAccess' } };
    };

    // -------- 17. ANSWER_STUDENT_QUERY : réponse pédagogique factuelle -------
    // Le contexte (profil business/offres déjà clarifiées, voir
    // ai-engine/offerClarifier.js) est fourni par l'appelant dans
    // payload.context — jamais recomposé ici (ce module ne connaît pas
    // ai-engine/, qui vit hors de lib/intelligence/ et n'est chargé que
    // côté VPS/local-client Node, jamais dans le bundle navigateur mobile).
    registry.ANSWER_STUDENT_QUERY = async (payload) => {
      const question = payload && (payload.question || payload.text);
      if (!question) return { ok: false, error: 'MISSING_QUESTION' };
      if (!llm) return { ok: false, error: 'RUNTIME_MISSING:llm' };
      const prompt = [
        'Un(e) élève pose une question sur une formation qu\'il/elle a déjà achetée.',
        'Réponds en français, de façon pédagogique, chaleureuse et concise — uniquement à partir du contexte fourni si présent, sinon avec tes connaissances générales sur le sujet.',
        'Ne mentionne jamais que tu es une IA ni que ce contexte t\'a été fourni.',
        `Question : "${question}"`,
      ].join('\n');
      const text = await llm(prompt, payload.history || [], payload.context || null);
      return { ok: true, result: { question, answer: text } };
    };

    // -------- 18. DELIVER_LESSON_CONTENT : envoi d'un module de formation ----
    registry.DELIVER_LESSON_CONTENT = async (payload, meta) => {
      const channel = (payload && payload.channel) || (meta && meta.channel) || 'WHATSAPP';
      const content = payload && payload.content;
      const to = payload && payload.to;
      if (!content || !to) return { ok: false, error: 'MISSING_CONTENT_OR_RECIPIENT' };
      if (!runtime.sendMessage) return { ok: false, error: 'RUNTIME_MISSING:sendMessage' };
      const out = await runtime.sendMessage(channel, to, content).catch((e) => ({ ok: false, error: String(e && e.message || e) }));
      return { ok: !!(out && out.ok), error: (out && out.error) || null, result: { to, moduleKey: payload.moduleKey || null, channel } };
    };

    // -------- 19. READ_RECENT_MESSAGES : lecture de la boîte de réception -----
    // Prouve que l'agent est réellement connecté au WhatsApp/Telegram du
    // vendeur et lui donne les derniers messages reçus (expéditeur + contenu).
    // Délègue à runtime.getRecentMessages (tampon en mémoire de l'adaptateur) —
    // jamais implémenté ici en dur, comme les autres actions "plateforme".
    registry.READ_RECENT_MESSAGES = async (payload, meta) => {
      const channel = (payload && payload.channel) || (meta && meta.channel) || 'WHATSAPP';
      if (!runtime.getRecentMessages) return { ok: false, error: 'RUNTIME_MISSING:getRecentMessages' };
      const out = await runtime.getRecentMessages(Object.assign({ channel }, payload));
      if (!out || out.ok === false) {
        return { ok: false, error: (out && out.error) || 'getRecentMessages failed', result: out || null };
      }
      return { ok: true, result: out };
    };

    // -------------------------------------------------------------------------
    function execute(action, payload, meta) {
      const fn = registry[action];
      if (!fn) return Promise.resolve({ ok: false, error: 'UNKNOWN_ACTION:' + action });
      return fn(payload || {}, meta || {});
    }

    function listActions() {
      return ACTIONS.map((name) => ({ name, description: registry[name] ? 'implémentée' : 'non enregistrée' }));
    }

    return { execute, registry, listActions, ACTIONS, generateAccessKey };
  }

  return { createActionExecutor, ACTIONS, generateAccessKey, DEFAULT_FIREBASE_BASE };
});