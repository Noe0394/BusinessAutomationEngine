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

  const stateFile = deps.stateFile || (process.env.INTELLIGENCE_STATE_FILE
    ? path.resolve(process.env.INTELLIGENCE_STATE_FILE)
    : path.join(__dirname, '..', '..', '.intelligence-state.json'));

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
    const tenant = tenantId || 'default';
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

  router.get('/api/intelligence/actions', (req, res) => {
    const executor = actionExecutorMod.createActionExecutor({
      runtime: deps.runtime || null,
      humanContext,
      env: deps.env || process.env,
    });
    res.json({ ok: true, actions: executor.listActions() });
  });

  return router;
}

module.exports = { createVpsBridge };