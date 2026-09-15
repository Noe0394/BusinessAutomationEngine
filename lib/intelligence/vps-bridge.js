// VPS BRIDGE — couche intelligence branchée sur l'architecture serveur existante
// -------------------------------------------------------------------------------
// Routeur Express (VPS Baileys / Render) exposant la couche Human & Context
// Intelligence. N'ALTÈRE PAS la gestion de sessions/connexion Baileys : il ne
// fait qu'ajouter des endpoints qui consomment lib/intelligence/*.
//
// Idempotence stricte par runId, isolation multi-tenant par tenantId, engine
// paramétrable (ZERO_VPS / VPS_BAILEYS) — parité fonctionnelle exacte entre
// mode Local et mode Cloud.
//
// Runtime d'exécution : injectable. Par défaut, un runtime "transparent" qui
// journalise les actions et ne touche à aucun moteur d'envoi — le branchement
// profond vers campaignEngine/whatsappManager/telegramManager reste à la main
// de l'intégrateur (conserve la garantie zéro-effet-de-bord par défaut).

'use strict';

const path = require('path');
const express = require('express');

function createVpsBridge(opts) {
  const router = express.Router();
  const deps = opts || {};
  const intelligenceDir = path.join(__dirname);
  const humanContext = deps.humanContext || require(path.join(intelligenceDir, 'human-context-engine.js'));
  const taskParser = deps.taskParser || require(path.join(intelligenceDir, 'task-parser.js'));
  const automationEngine = deps.automationEngine || require(path.join(intelligenceDir, 'automation-engine.js'));
  const actionExecutorMod = deps.actionExecutor || require(path.join(intelligenceDir, 'action-executor.js'));
  const goalChat = deps.goalChat || require(path.join(intelligenceDir, 'goal-chat.js'));
  // BUG CORRIGÉ (constaté en test réel par l'utilisateur, 2026-09-14) :
  // l'onglet "💬 Chat Intelligent" du dashboard (CETTE route) est resté sur
  // le moteur goal-chat.js BRUT tout du long de la session qui a construit
  // ai-engine/chatOrchestrator.js + personaManager.js — ces deux modules
  // n'avaient été câblés QUE sur le Copywriter Studio IA
  // (/api/ai-studio/sessions/:id/messages, voir index.js), un tout AUTRE
  // onglet du même dashboard. Un utilisateur testant "Chat Intelligent" (le
  // nom le plus évident pour "le système intelligent") tombait donc sur les
  // réponses robotiques d'origine, jamais reformulées ni capables de
  // reconnaître une simple salutation. Comblé ici : même point d'entrée
  // consulté EN PREMIER que côté Copywriter Studio IA.
  const chatOrchestrator = deps.chatOrchestrator || require(path.join(intelligenceDir, '..', '..', 'ai-engine', 'chatOrchestrator.js'));
  const llmFallbackEngine = deps.llmFallbackEngine || require(path.join(intelligenceDir, '..', 'ai', 'llmFallbackEngine.js'));
  const personaManager = deps.personaManager || require(path.join(intelligenceDir, '..', '..', 'ai-engine', 'personaManager.js'));

  const stateFile = deps.stateFile || (process.env.INTELLIGENCE_STATE_FILE
    ? path.resolve(process.env.INTELLIGENCE_STATE_FILE)
    : path.join(__dirname, '..', '..', '.intelligence-state.json'));

  // Résout le tenant depuis l'identité AUTHENTIFIÉE de la requête (injecté par
  // index.js : resolveTenantId -> __admin__ ou clé de licence). Indispensable
  // pour que le tchat agisse sur LA session WhatsApp/Telegram réellement
  // appairée par l'utilisateur, et non sur un tenant 'default'/admin déduit du
  // corps de requête (bug de "reconnaissance" : l'agent regardait la mauvaise
  // session et se croyait déconnecté). Repli sur le tenantId du corps puis
  // 'default' si aucun résolveur n'est injecté (compat tests/appels internes).
  function tenantForRequest(req, bodyTenantId) {
    if (typeof deps.resolveTenant === 'function') {
      const resolved = deps.resolveTenant(req);
      if (resolved) return resolved;
    }
    return bodyTenantId || 'default';
  }

  // ISOLATION MULTI-TENANT STRICTE : un fichier d'état PAR tenant. Un fichier
  // unique partagé écrasait les tâches d'un tenant à l'autre (markRun persiste
  // les Maps du store courant uniquement, effaçant les autres tenants) —
  // découvert et corrigé via test/vps-bridge.test.js (section "Reprise d'état").
  function storageForTenant(tenantId) {
    const id = tenantId || 'default';
    if (!stateFile) return null; // mémoire pure : aucune persistance
    const base = stateFile.replace(/\.json$/i, '');
    return automationEngine.createFileStorage(base + '.' + id + '.json');
  }

  // Sessions du Goal Chat (fenêtre de dialogue objectif -> plan), en mémoire,
  // par sessionId — même compromis de persistance que `engines` ci-dessous
  // (non survivant à un redémarrage : le dialogue redémarre proprement).
  const goalChatSessions = new Map();
  // Continuation d'intention pour chatOrchestrator (offre/paiement/compte,
  // voir ai-engine/chatOrchestrator.js#detectIntent) — cette route est
  // stateless côté historique de messages (contrairement à aiStudioStore.js
  // pour le Copywriter Studio IA), d'où ce petit Map dédié.
  const lastAssistantBySession = new Map();

  // MÉMOIRE DE CONVERSATION par discussion — PERSISTANTE (survit à un
  // redémarrage) + effaçable à la demande (action 'restart' vide la mémoire de
  // la discussion). L'onglet "Chat Intelligent" ne stockait rien : l'agent
  // repartait de zéro à chaque message. On persiste désormais un historique
  // borné {role,text} par (tenant, sessionId) via storageAdapter (un document
  // par discussion, facile à vider), avec un cache en mémoire pour la vitesse.
  const chatMemoryStore = require(path.join(__dirname, '..', '..', 'ai-engine', 'storageAdapter.js'));
  const CHAT_MEMORY_NAMESPACE = 'chat_intelligent_sessions';
  const sessionHistory = new Map(); // cache: sessionId -> [{role,text}]
  function memSanitize(id) {
    return String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'unknown';
  }
  function memDocId(tenant, sessionId) {
    return `${memSanitize(tenant)}__${memSanitize(sessionId)}`;
  }
  async function getHistory(tenant, sessionId) {
    if (sessionHistory.has(sessionId)) return sessionHistory.get(sessionId);
    const doc = await chatMemoryStore.get(CHAT_MEMORY_NAMESPACE, memDocId(tenant, sessionId), { messages: [] });
    const messages = Array.isArray(doc.messages) ? doc.messages : [];
    sessionHistory.set(sessionId, messages);
    return messages;
  }
  function recordTurn(tenant, sessionId, userText, assistantText) {
    const h = sessionHistory.get(sessionId) || [];
    h.push({ role: 'user', text: String(userText || '') });
    if (assistantText) h.push({ role: 'assistant', text: String(assistantText).slice(0, 2000) });
    while (h.length > 40) h.shift();
    sessionHistory.set(sessionId, h);
    chatMemoryStore.set(CHAT_MEMORY_NAMESPACE, memDocId(tenant, sessionId), { tenant: memSanitize(tenant), sessionId, messages: h, updatedAt: new Date().toISOString() });
  }
  // Efface la mémoire d'une discussion (à la demande de l'utilisateur, via
  // 'restart') : cache + document persistant vidés.
  function clearHistory(tenant, sessionId) {
    sessionHistory.delete(sessionId);
    chatMemoryStore.set(CHAT_MEMORY_NAMESPACE, memDocId(tenant, sessionId), { tenant: memSanitize(tenant), sessionId, messages: [], updatedAt: new Date().toISOString() });
  }

  // Un moteur d'automatisation par tenant (isolation stricte). L'executor est
  // injecté au moteur : le registry d'actions (action-executor) reste
  // accessible séparément via getActionExecutor().
  const engines = new Map();
  function engineFor(tenantId) {
    const id = tenantId || 'default';
    if (!engines.has(id)) {
      engines.set(id, automationEngine.createAutomationEngine({
        tenantId: id,
        executor: runtimeExecutorFor(id),
        storage: deps.storageFor ? deps.storageFor(id) : storageForTenant(id),
      }));
    }
    return engines.get(id);
  }

  // Runtime d'exécution des actions. Par défaut : journalise et renvoie ok,
  // sans jamais lancer d'envoi vers WhatsApp/Telegram (garantie de non-effet).
  // L'intégrateur peut injecter deps.runtime pour brancher campaignEngine etc.
  function runtimeExecutorFor(tenantId) {
    const custom = deps.runtime;
    const fallback = async (type, payload, meta) => {
      return {
        ok: true,
        deferred: true,
        result: { tenantId, type, note: 'action reçue par la couche intelligence (runtime par défaut)' },
      };
    };
    const fn = (type, payload, meta) => {
      const r = custom ? custom.execute(type, payload, meta) : null;
      if (r && typeof r.then === 'function') return r;
      if (r && r.ok !== undefined) return Promise.resolve(r);
      if (r) return Promise.resolve(r).then((x) => x || { ok: true, result: {} });
      return fallback(type, payload, meta);
    };
    return {
      execute: fn,
      // accès direct aux actions du registry (action-executor) via runtime
      actionExecutor: actionExecutorMod.createActionExecutor({
        runtime: custom || null,
        humanContext,
        env: deps.env || process.env,
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // Endpoints
  // ---------------------------------------------------------------------------
  router.get('/api/intelligence/health', (req, res) => {
    res.json({
      ok: true,
      engines: Array.from(engines.keys()),
      modules: { humanContextEngine: true, taskParser: true, automationEngine: true, actionExecutor: true },
      region: process.env.RENDER_REGION || 'local',
    });
  });

  // Machine view : cartes des machines cibles de la couche intelligence
  // (WHATSAPP_LOCAL = le PC utilisateur, via le runtime injecté).
  router.get('/api/intelligence/machines', (req, res) => {
    const reg = (deps.runtime && deps.runtime.machines) || null;
    res.json({ ok: true, machines: reg ? reg.list() : [] });
  });

  // Analyse émotionnelle + stratégie (Test 2)
  router.post('/api/intelligence/analyze', (req, res) => {
    const { message, context } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Le champ "message" (texte) est requis.' });
    }
    const analysis = humanContext.analyzeMessage(message);
    if (analysis.error) return res.status(400).json(analysis);
    const strategy = humanContext.selectStrategy(analysis);
    const response = humanContext.generateFollowUp(analysis, strategy, { name: (context && context.name) || '{first_name}' });
    res.json({
      ok: true,
      analysis,
      strategy: strategy ? { id: strategy.id, angle: strategy.angle, followUpDelayMs: strategy.followUpDelayMs } : null,
      followUp: response,
    });
  });

  // Intuition probabiliste (Test 6)
  router.post('/api/intelligence/intuition', (req, res) => {
    const { signals, analysis, history } = req.body || {};
    const a = analysis || humanContext.analyzeMessage((req.body && req.body.message) || '');
    const intuition = humanContext.detectIntuition({ signals, analysis: a, history });
    res.json({ ok: true, intuition });
  });

  // Objectif langage naturel -> plan de tâches (Test 3)
  router.post('/api/intelligence/objective', (req, res) => {
    const { message, engine, tenantId, runId } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Le champ "message" est requis.' });
    }
    const doc = taskParser.parseObjective({
      text: message,
      engine: engine || 'VPS_BAILEYS',
      tenantId: tenantId || 'default',
    });
    const tasks = taskParser.planToTasks(doc, {
      tenantId: tenantId || 'default',
      engine: engine || 'VPS_BAILEYS',
      runId: runId || null,
    });
    res.json({ ok: true, doc, tasks });
  });

  // Exécution immédiate d'une action unique (Test 5)
  router.post('/api/intelligence/execute', async (req, res) => {
    const { action, payload, engine, tenantId, runId } = req.body || {};
    if (!action) return res.status(400).json({ error: 'action requis.' });
    const tenant = tenantId || 'default';
    const eng = engineFor(tenant);
    await eng.createTask({
      runId: runId || null,
      tenantId: tenant,
      engine: engine || 'VPS_BAILEYS',
      type: action,
      payload: payload || {},
      scheduledAt: Date.now(),
    });
    const out = await eng.runDue({ engine: engine || 'VPS_BAILEYS', tenantId: tenant });
    res.json({ ok: true, out, executorRuntime: !!deps.runtime });
  });

  // Chat-to-Action : objectif en langage naturel -> plan -> exécution complète.
  router.post('/api/intelligence/chat', async (req, res) => {
    const { message, engine, tenantId } = req.body || {};
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Le champ "message" est requis.' });
    }
    const tenant = tenantForRequest(req, tenantId);
    const doc = taskParser.parseObjective({
      text: message,
      engine: engine || 'VPS_BAILEYS',
      tenantId: tenant,
    });
    const runId = 'chat-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
    const tasks = taskParser.planToTasks(doc, { tenantId: tenant, engine: engine || 'VPS_BAILEYS', runId });
    const eng = engineFor(tenant);
    await eng.createTasks(tasks);
    const executed = await eng.runDue({ engine: engine || 'VPS_BAILEYS', tenantId: tenant });
    res.json({
      ok: true,
      tenantId: tenant,
      runId,
      summary: doc.summary,
      plan: doc.plan.map((d) => ({ action: d.action, channel: d.channel, immediate: d.immediate })),
      tasks: tasks.length,
      executed,
    });
  });

  // Fenêtre de dialogue objectif -> plan (Goal Chat) : contrairement à
  // /api/intelligence/chat (one-shot, exécute immédiatement), cette route
  // maintient une session multi-tour — elle pose les questions manquantes
  // (cible, canaux) avant de construire le plan, puis n'exécute QUE sur
  // confirmation explicite (action:'run-plan'). Le plan et l'exécution
  // passent par les VRAIS moteurs (task-parser + automation-engine +
  // action-executor déjà injecté via deps.runtime) — aucune simulation.
  router.post('/api/intelligence/goal-chat', async (req, res) => {
    const { message, sessionId, tenantId, action } = req.body || {};
    const tenant = tenantForRequest(req, tenantId);

    let state = sessionId ? goalChatSessions.get(sessionId) : null;
    if (!state) {
      state = goalChat.createSession({});
      goalChatSessions.set(state.sessionId, state);
    }

    if (action === 'restart') {
      goalChatSessions.delete(state.sessionId);
      clearHistory(tenant, state.sessionId);
      lastAssistantBySession.delete(state.sessionId);
      const fresh = goalChat.createSession({});
      goalChatSessions.set(fresh.sessionId, fresh);
      return res.json({ ok: true, sessionId: fresh.sessionId, phase: 'greet', reply: goalChat.WELCOME });
    }

    if (action === 'run-plan') {
      const eng = engineFor(tenant);
      const result = await goalChat.runPlan(state, {
        execute: async (tasks) => {
          await eng.createTasks(tasks);
          const out = await eng.runDue({ tenantId: tenant });
          return {
            runId: (tasks[0] && tasks[0].runId) || null,
            executed: out.executed,
            results: out.results,
            error: out.failed > 0 ? (out.failed + ' tâche(s) en échec') : null,
          };
        },
      });
      return res.json(Object.assign({ ok: result.ok }, goalChat.serialize(state, { mode: 'run' })));
    }

    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Le champ "message" est requis (ou action:"run-plan"/"restart").' });
    }

    // Chat-Driven Agent Orchestrator — consulté EN PREMIER (offre/rapport/
    // paiement/compte élève/campagne avec confirmation humanisée), avant le
    // pipeline goal-chat brut ci-dessous. Retombe proprement dessus si
    // aucune commande de pilotage n'est détectée (message de conversation
    // normal, salutation, etc. — goal-chat.js gère déjà ce cas par un
    // dialogue d'accroche, voir plus bas).
    const lastAssistantMessage = lastAssistantBySession.get(state.sessionId) || null;
    const orchestrated = await chatOrchestrator.handle(
      { text: message, history: await getHistory(tenant, state.sessionId), tenantId: tenant, sessionId: state.sessionId, lastAssistantMessage },
      { runtime: deps.runtime || null, engineFor, humanContext, generateImage: deps.generateImage || null },
    ).catch((err) => {
      console.warn('Chat-Driven Agent Orchestrator (Chat Intelligent) — échec, repli sur goal-chat brut :', err.message);
      return null;
    });

    if (orchestrated) {
      lastAssistantBySession.set(state.sessionId, {
        isPlanningQuestion: !!orchestrated.isPlanningQuestion,
        intent: orchestrated.intent || null,
      });
      recordTurn(tenant, state.sessionId, message, orchestrated.text);
      return res.json({
        ok: true,
        sessionId: state.sessionId,
        reply: { text: orchestrated.text },
        kind: orchestrated.actionLog ? 'plan' : 'question',
        actionLog: orchestrated.actionLog || null,
      });
    }

    // BUG CORRIGÉ (constaté en test réel par l'utilisateur) : goal-chat.js
    // n'a AUCUNE notion de "conversation générale" — dès qu'un message ne
    // ressemble à aucun objectif business connu (ex: une simple salutation
    // après une session déjà entamée, ou n'importe quelle question hors
    // sujet), task-parser.js lui attribue le type 'DEFAULT' (aucun champ
    // requis) et goal-chat.js produit IMMÉDIATEMENT un plan mécanique
    // "🧠 analyse de la situation / ANALYZE_HUMAN_CONTEXT + GENERATE_REPORT"
    // — robotique et hors sujet, jamais une vraie réponse conversationnelle.
    // Filet AVANT d'entrer dans goal-chat.js : si le message ne ressemble à
    // AUCUN objectif business reconnu (uniquement type DEFAULT détecté),
    // répondre comme un vrai assistant conversationnel (même cascade LLM que
    // le Copywriter Studio IA) plutôt que de laisser goal-chat.js produire
    // ce plan creux — SANS faire avancer l'état de session goal-chat (un
    // vrai objectif tapé juste après continue de fonctionner normalement).
    const detectedGoals = taskParser.detectGoals(message, taskParser.extractAmounts(message));
    const looksLikeRealGoal = detectedGoals.some((g) => g.type !== 'DEFAULT') || state.ctx.goalType;
    if (!looksLikeRealGoal) {
      try {
        // personaSystemPrompt (voir ai-engine/personaManager.js) est
        // OBLIGATOIRE ici, pas facultatif : sans lui, le LLM répond comme un
        // assistant généraliste classique et nie avoir accès à WhatsApp —
        // exactement le bug le plus grave signalé sur ce module.
        // Ancrage DONNÉES → INTELLIGENCE : même sur ce repli conversationnel
        // (aucune intention précise détectée), on injecte les informations
        // RÉELLES des Services Métiers du vendeur (produits, prix, règles,
        // objectifs) pour qu'une question factuelle formulée d'une façon
        // inattendue reste répondue depuis la vraie donnée, jamais inventée.
        // Chargé paresseusement pour ne pas coupler ce module au registre.
        let bizCtx = '';
        try { bizCtx = await require('../../ai-engine/businessServices').getEngineContextText(tenant); } catch (e) { bizCtx = ''; }
        const promptParts = [personaManager.personaSystemPrompt('default')];
        if (bizCtx) {
          promptParts.push("Informations RÉELLES de l'activité du vendeur (Services Métiers qu'il a configurés — source de vérité, n'invente jamais un prix/produit/règle au-delà de ceci) :");
          promptParts.push(bizCtx);
        }
        promptParts.push(`Message du vendeur : "${message}"`);
        const prompt = promptParts.join('\n');
        const { text: raw } = await llmFallbackEngine.generateAIResponse(prompt, await getHistory(tenant, state.sessionId), null);
        recordTurn(tenant, state.sessionId, message, raw);
        return res.json({ ok: true, sessionId: state.sessionId, kind: 'question', reply: { text: raw } });
      } catch (err) {
        console.warn('Chat Intelligent — repli conversationnel LLM indisponible :', err.message);
        // Continue vers goal-chat.js ci-dessous plutôt que de renvoyer une erreur.
      }
    }

    const out = goalChat.step(state, { message, parser: taskParser, humanContext });
    recordTurn(tenant, state.sessionId, message, out && out.reply && out.reply.text);
    res.json(Object.assign({ ok: true, sessionId: state.sessionId }, out));
  });

  router.get('/api/intelligence/actions', (req, res) => {
    const executor = actionExecutorMod.createActionExecutor({
      runtime: deps.runtime || null,
      humanContext,
      env: deps.env || process.env,
    });
    res.json({ ok: true, actions: executor.listActions() });
  });

  // Exposé (en plus du router) pour ai-engine/chatOrchestrator.js : réutilise
  // le MÊME moteur d'automatisation par tenant que /api/intelligence/*
  // (engineFor) plutôt que d'en construire un second, ce qui fragmenterait
  // l'idempotence/l'état par runId entre les deux points d'entrée du tchat
  // (Goal Chat direct vs. Copywriter Studio IA). goalChatSessions est
  // également exposé pour que le Studio IA puisse maintenir sa propre
  // session Goal Chat par discussion (même compromis de persistance déjà
  // documenté ci-dessus : en mémoire, redémarre proprement après un restart).
  // `runtime` = l'objet brut injecté par l'appelant (deps.runtime, ex.
  // createVpsRuntime(...) dans index.js), PAS runtimeExecutorFor(...) — ce
  // dernier reconstruit un actionExecutor local à CE module, sans le `llm`
  // injecté à la construction de deps.runtime (voir
  // lib/intelligence/runtimes/vps-runtime.js#ANSWER_STUDENT_QUERY).
  return { router, engineFor, goalChatSessions, runtime: deps.runtime || null };
}

module.exports = { createVpsBridge };