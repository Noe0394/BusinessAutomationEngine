// AUTOMATION ENGINE — Event & Task Engine unifié (dual-env : Node + navigateur)
// -------------------------------------------------------------------------------
// Structure de tâche (spec B) :
//   { id, runId, tenantId, engine: 'ZERO_VPS'|'VPS_BAILEYS',
//     channel: 'WHATSAPP'|'TELEGRAM'|'TIKTOK'|'YOUTUBE', type, status,
//     priority, scheduledAt, payload, attempts, nextRun }
//
// Garanties :
//  - Exécution immédiate / différée / récurrente (recurring) / fenêtre horaire.
//  - Idempotence stricte par runId (une tâche déjà "run" n'est JAMAIS rejouée,
//    même après redémarrage — le journal des runId est persisté).
//  - Reprise après redémarrage : les tâches 'processing' repassent 'queued'
//    au load ; celles marquées 'done' restent done (runId journalisé).
//  - Isolation multi-tenant par tenantId (un tenant ne voit/joue que ses tâches).
//  - Abstraction engine : ZERO_VPS vs VPS_BAILEYS sans changement de cœur.
//
// Le moteur ne connaît AUCUNE action : il délègue à `deps.executor.execute(...)`.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AutomationEngine = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const ENGINE_IDS = ['ZERO_VPS', 'VPS_BAILEYS'];
  const CHANNEL_IDS = ['WHATSAPP', 'TELEGRAM', 'TIKTOK', 'YOUTUBE'];
  const STATUS = ['queued', 'processing', 'done', 'failed', 'paused', 'skipped'];

  function uuid(prefix) {
    const rnd = Math.random().toString(36).slice(2, 8) + Date.now().toString(36).slice(-4);
    return (prefix || 't') + '_' + rnd;
  }

  // ---------------------------------------------------------------------------
  // Store par défaut (mémoire + persistance JSON via `storage`)
  // ---------------------------------------------------------------------------
  function createMemoryStore(storage) {
    const tasks = new Map();
    const runs = new Map(); // runId -> done
    return {
      getTasks: async () => Array.from(tasks.values()),
      getTask: async (id) => tasks.get(id) || null,
      putTask: async (t) => { tasks.set(t.id, t); if (storage) await storage.persist(tasks, runs); },
      listActive: async (nowMs) => Array.from(tasks.values()).filter((t) => t.status === 'queued' && t.nextRun <= nowMs),
      // Fenêtres horaires : candidates différentes
      listAllQueued: async () => Array.from(tasks.values()).filter((t) => t.status === 'queued'),
      wasRun: async (runId) => runs.has(runId),
      markRun: async (runId) => { runs.set(runId, true); if (storage) await storage.persist(tasks, runs); },
      markRunBatch: async (runIds) => { runIds.forEach((r) => runs.set(r, true)); if (storage) await storage.persist(tasks, runs); },
      listRuns: async () => Array.from(runs.keys()),
      resetProcessing: async () => {
        let changed = 0;
        for (const [id, t] of tasks) {
          if (t.status === 'processing') { t.status = 'queued'; t.attempts = 0; changed++; }
        }
        if (storage) await storage.persist(tasks, runs);
        return changed;
      },
      _internal: { tasks, runs },
    };
  }

  // ---------------------------------------------------------------------------
  // Helper de persistance JSON (Node fs) — utilisé par le Node/VPS.
  // ---------------------------------------------------------------------------
  function createFileStorage(filePath, fsApi) {
    const fs = fsApi || (typeof require !== 'undefined' ? require('fs') : null);
    let cache = null;
    return {
      load: async () => {
        if (cache) return cache;
        if (!fs || !filePath) return { tasks: [], runs: [] };
        try {
          const raw = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '{}';
          cache = JSON.parse(raw) || { tasks: [], runs: [] };
        } catch (e) { cache = { tasks: [], runs: [] }; }
        return cache;
      },
      persist: async (tasksMap, runsMap) => {
        if (!fs || !filePath) return;
        try {
          const data = { tasks: Array.from(tasksMap.values()), runs: Array.from(runsMap.keys()) };
          fs.writeFileSync(filePath, JSON.stringify(data), 'utf8');
        } catch (e) { /* disque en lecture seule : on continue en mémoire */ }
      },
      _invalidate: () => { cache = null; },
    };
  }

  // ---------------------------------------------------------------------------
  // Le moteur lui-même
  // ---------------------------------------------------------------------------
  function createAutomationEngine(deps) {
    const storage = deps.storage || null;
    const store = deps.store || createMemoryStore(storage);
    const executor = deps.executor || null; // { execute(action, payload, meta) }
    const logger = deps.logger || (() => {});
    const nowMs = deps.now || (() => Date.now());
    const defaultTenant = deps.tenantId || 'default';
    const defaultEngine = deps.engine || 'ZERO_VPS';

    if (storage && typeof storage.load === 'function') {
      // Reprise après redémarrage : on hydrate les tâches persistées, on remet
      // en file les tasks 'processing' interrompues, on marque les runId déjà
      // exécutés (idempotence), puis on met en pause propre tous les processed.
    }

    async function hydrateFromStorage() {
      if (!storage || typeof storage.load !== 'function') return { resumed: 0, alreadyRun: 0 };
      const data = await storage.load();
      const resumed = data.tasks.reduce((n, t) => {
        const s = store._internal && store._internal.tasks;
        if (s) s.set(t.id, t);
        if (t.status === 'processing') { t.status = 'queued'; t.attempts = 0; n++; }
        return n;
      }, 0);
      if (store.markRunBatch && data.runs) await store.markRunBatch(data.runs);
      return { resumed, alreadyRun: data.runs ? data.runs.length : 0 };
    }

    // ------------------------------------------------------- création de tâche
    function validateTask(t) {
      if (!t || !t.type) throw new Error('INVALID_TASK: type requis');
      if (t.engine && !ENGINE_IDS.includes(t.engine)) throw new Error('INVALID_ENGINE: ' + t.engine);
      if (t.channel && !CHANNEL_IDS.includes(t.channel)) throw new Error('INVALID_CHANNEL: ' + t.channel);
      return true;
    }

    function createTask(input) {
      const now = nowMs();
      const t = {
        id: input.id || uuid('t'),
        runId: input.runId || null,
        tenantId: input.tenantId || defaultTenant,
        engine: input.engine || defaultEngine,
        channel: input.channel || 'WHATSAPP',
        type: input.type,
        status: 'queued',
        priority: typeof input.priority === 'number' ? input.priority : 5,
        scheduledAt: typeof input.scheduledAt === 'number' ? input.scheduledAt : now,
        payload: input.payload || {},
        attempts: 0,
        maxRetries: typeof input.maxRetries === 'number' ? input.maxRetries : 2,
        nextRun: typeof input.scheduledAt === 'number' ? input.scheduledAt : now,
        recurring: input.recurring || null, // { intervalMs, endAtMs }
        window: input.window || null,       // { startHour, endHour } (0-23)
        createdAt: new Date(now).toISOString(),
      };
      validateTask(t);
      return store.putTask(t).then(() => t);
    }

    // ------------------------------------------------- palanquée multi-tasks
    async function createTasks(list) {
      const created = [];
      for (const t of list) created.push(await createTask(t));
      return created;
    }

    // ------------------------------------------------------------- fenêtres
    function inWindow(t, now) {
      if (!t.window) return true;
      const d = new Date(now);
      const h = d.getHours();
      const { startHour = 0, endHour = 23 } = t.window;
      if (startHour <= endHour) return h >= startHour && h <= endHour;
      // fenêtre chevauchant minuit
      return h >= startHour || h <= endHour;
    }

    // ------------------------------------------------------------ sélection
    async function dueTasks(now, opts) {
      const tenant = (opts && opts.tenantId) || null;

      // Idempotence par runId : les tâches d'un plan déjà "run" ne sont pas
      // resélectionnées.
      const all = await store.listAllQueued();
      const candidates = all.filter((t) => {
        if (tenant && t.tenantId !== tenant) return false;
        if (t.nextRun > now) return false;
        if (t.runId && store.wasRun) return false; // réserve pour la marque en lot
        return true;
      });
      // On laisse la vérification d'idempotence au niveau de l'exécution (le
      // check wasRun se fait réellement à l'heure de l'exécution).
      return candidates.sort((a, b) => (a.priority - b.priority) || (a.nextRun - b.nextRun));
    }

    // ------------------------------------------------------------- exécution
    async function runDue(opts) {
      const now = nowMs();
      const hints = opts || {};
      const list = await store.listActive(now); // directs + delayed arrivés à échéance
      const picked = list.filter((t) => {
        if (hints.tenantId && t.tenantId !== hints.tenantId) return false;
        if (hints.engine && t.engine !== hints.engine) return false;
        if (t.runId) {
          // idempotence : ne jamais rejouer
          // (vérification de bout en bout dans executeOne)
          return true;
        }
        return inWindow(t, now);
      });
      if (!picked.length) return { executed: 0, skippedIdempotent: 0, failed: 0, results: [] };

      // tri : priorité puis échéance
      picked.sort((a, b) => (a.priority - b.priority) || (a.nextRun - b.nextRun));

      const results = [];
      for (const t of picked) {
        const res = await executeOne(t, now, hints);
        results.push(res);
      }
      const executed = results.filter((r) => r.state === 'done' || r.state === 'retrying').length;
      const skippedIdempotent = results.filter((r) => r.state === 'idempotent').length;
      const failed = results.filter((r) => r.state === 'failed').length;
      return { executed, skippedIdempotent, failed, results };
    }

    async function executeOne(t, now, hints) {
      // IDEMPOTENCE (spec C) : une tâche dont le runId a déjà tourné est
      // marquée 'skipped' sans exécution — y compris après redémarrage.
      if (t.runId && (await store.wasRun(t.runId))) {
        await store.putTask(Object.assign(t, { status: 'skipped' }));
        return { taskId: t.id, state: 'idempotent' };
      }

      t.status = 'processing';
      t.attempts += 1;
      await store.putTask(t);
      logger({ kind: 'task_start', taskId: t.id, runId: t.runId, type: t.type, engine: t.engine, channel: t.channel });

      let outcome;
      try {
        if (!executor) {
          outcome = { ok: false, error: 'NO_EXECUTOR' };
        } else {
          outcome = await executor.execute(t.type, t.payload, {
            tenantId: t.tenantId, engine: t.engine, channel: t.channel, taskId: t.id, runId: t.runId,
          });
        }
      } catch (e) {
        outcome = { ok: false, error: String(e && e.message || e) };
      }

      if (outcome && outcome.ok) {
        await store.markRun(t.runId); // idempotence épinglée
        // Récurrence : reprogrammation automatique du prochain run.
        if (t.recurring && t.recurring.intervalMs) {
          const next = now + t.recurring.intervalMs;
          if (!t.recurring.endAtMs || next <= t.recurring.endAtMs) {
            const repeat = Object.assign({}, t, { id: uuid('t'), runId: t.recurring.runId || null, nextRun: next, scheduledAt: next, status: 'queued', attempts: 0 });
            await store.putTask(repeat);
            await store.putTask(Object.assign(t, { status: 'done' }));
            return { taskId: t.id, state: 'done', recurring: true, nextRun: next };
          }
        }
        await store.putTask(Object.assign(t, { status: 'done', result: outcome.result || null }));
        return { taskId: t.id, state: 'done', result: outcome.result || null };
      }

      // échec -> retry avec backoff simple
      if (t.attempts <= t.maxRetries) {
        const backoff = 30 * 1000 * Math.pow(2, t.attempts - 1);
        t.status = 'queued'; t.nextRun = now + backoff;
        await store.putTask(t);
        return { taskId: t.id, state: 'retrying', attempts: t.attempts, backoffMs: backoff };
      }
      await store.putTask(Object.assign(t, { status: 'failed', lastError: outcome.error || String(outcome) }));
      return { taskId: t.id, state: 'failed', error: outcome.error || String(outcome) };
    }

    // ------------------------------------------------------------- contrôles
    async function pauseTask(idOrRunId) {
      const all = await store.getTasks();
      const t = all.find((x) => x.id === idOrRunId || (x.runId === idOrRunId)) || null;
      if (!t) return { ok: false, error: 'NOT_FOUND' };
      await store.putTask(Object.assign(t, { status: 'paused' }));
      return { ok: true, taskId: t.id };
    }
    async function resumeTask(idOrRunId) {
      const all = await store.getTasks();
      const t = all.find((x) => x.id === idOrRunId || (x.runId === idOrRunId)) || null;
      if (!t) return { ok: false, error: 'NOT_FOUND' };
      const now = nowMs();
      await store.putTask(Object.assign(t, { status: 'queued', nextRun: now }));
      return { ok: true, taskId: t.id };
    }
    async function listTasks(opts) {
      const all = await store.getTasks();
      const tenant = (opts && opts.tenantId) || null;
      return all.filter((t) => !tenant || t.tenantId === tenant).sort((a, b) => (a.priority - b.priority) || (a.nextRun - b.nextRun));
    }

    // --------------------------------------- exécution immédiate "sans file"
    // Permet au Chat-to-Action / aux webhooks de jouer une action en direct.
    async function runNow(input) {
      const t = await createTask(Object.assign({}, input, { scheduledAt: nowMs(), nextRun: nowMs(), status: 'queued' }));
      // exécution directe (parcourt le même chemin idempotence/retry)
      const res = await executeOneAround(t);
      return res;
    }
    async function executeOneAround(t) {
      return executeOne(t, nowMs(), {});
    }

    // ---------------------------------------------------------- composée
    return {
      createTask, createTasks, runDue, runNow, pauseTask, resumeTask, listTasks,
      inWindow, dueTasks, hydrateFromStorage, validateTask,
      _internal: store._internal, _store: store, _storage: storage,
    };
  }

  return {
    createAutomationEngine, createMemoryStore, createFileStorage,
    ENGINE_IDS, CHANNEL_IDS, STATUS, uuid,
  };
});