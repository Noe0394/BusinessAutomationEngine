// File de tâches DURABLE (persistée par tenant) : priorité, planification (runAt), verrou à bail,
// retries bornés avec backoff, reprise après crash (recover). Aucune dépendance à l'interface ni à l'IA.
const storageAdapter = require('./storageAdapter');

const NAMESPACE = 'task_queue';
const LEASE_MS = 5 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const KEEP_FINISHED_MS = 7 * 24 * 3600 * 1000;
const MAX_TASKS = 1000;

// États d'une tâche longue : QUEUED, RUNNING (= PROCESSING en interne), WAITING_EXTERNAL (attend une réponse/validation externe), VERIFYING,
// COMPLETED, FAILED, CANCELLED, PAUSED. Aucune tâche ne disparaît : les états terminaux sont conservés 7 jours.
const STATE = { QUEUED: 'QUEUED', PROCESSING: 'PROCESSING', COMPLETED: 'COMPLETED', FAILED: 'FAILED', CANCELLED: 'CANCELLED', PAUSED: 'PAUSED', WAITING_EXTERNAL: 'WAITING_EXTERNAL', VERIFYING: 'VERIFYING' };
const normalizeState = (s) => (s === 'PROCESSING' ? 'RUNNING' : s); // vocabulaire public des rapports
const PUBLIC_STATES = ['QUEUED', 'RUNNING', 'WAITING_EXTERNAL', 'VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED'];

const sanitize = (id) => String(id || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';
const uid = () => 'tsk_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Sérialise les écritures d'un même tenant (get -> modifier -> set) dans ce processus.
const chains = new Map();
function withTenant(tenant, fn) {
  const key = sanitize(tenant);
  const prev = chains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  chains.set(key, next.catch(() => {}));
  return next;
}

async function load(tenant) { return storageAdapter.get(NAMESPACE, sanitize(tenant), { tenant: sanitize(tenant), tasks: [] }); }
function save(tenant, doc) {
  const cut = Date.now() - KEEP_FINISHED_MS;
  doc.tasks = doc.tasks.filter((t) => ![STATE.COMPLETED, STATE.FAILED, STATE.CANCELLED].includes(t.state) || (t.finishedAt || 0) >= cut).slice(-MAX_TASKS);
  return storageAdapter.set(NAMESPACE, sanitize(tenant), doc);
}

// create_queue est implicite (une file par tenant). Idempotence : `dedupeKey` identique et tâche non terminée => même tâche.
function enqueue(tenant, { type, payload, runAt, priority, ref, dedupeKey, maxAttempts }) {
  return withTenant(tenant, async () => {
    const doc = await load(tenant);
    if (dedupeKey) {
      const existing = doc.tasks.find((t) => t.dedupeKey === dedupeKey && [STATE.QUEUED, STATE.PROCESSING].includes(t.state));
      if (existing) return { task: existing, deduplicated: true };
    }
    const task = {
      id: uid(), type, payload: payload || {}, ref: ref || null, dedupeKey: dedupeKey || null,
      state: STATE.QUEUED, priority: Number(priority) || 0, runAt: runAt ? new Date(runAt).getTime() : Date.now(),
      attempts: 0, maxAttempts: maxAttempts || MAX_ATTEMPTS, lockedUntil: 0, result: null, error: null,
      createdAt: Date.now(), finishedAt: null,
    };
    doc.tasks.push(task);
    await save(tenant, doc);
    return { task, deduplicated: false };
  });
}

// get_next_task + lock_task + mark_task_processing : atomique. Renvoie la tâche due de plus haute priorité.
function claimNext(tenant, now) {
  const t0 = now == null ? Date.now() : now;
  return withTenant(tenant, async () => {
    const doc = await load(tenant);
    const due = doc.tasks
      .filter((t) => t.state === STATE.QUEUED && t.runAt <= t0)
      .sort((a, b) => (b.priority - a.priority) || (a.runAt - b.runAt));
    const task = due[0];
    if (!task) return null;
    task.state = STATE.PROCESSING; task.lockedUntil = t0 + LEASE_MS; task.attempts += 1; task.startedAt = t0;
    await save(tenant, doc);
    return task;
  });
}

function finish(tenant, id, patch) {
  return withTenant(tenant, async () => {
    const doc = await load(tenant);
    const task = doc.tasks.find((t) => t.id === id);
    if (!task) return null;
    Object.assign(task, patch, { lockedUntil: 0 });
    await save(tenant, doc);
    return task;
  });
}

const complete = (tenant, id, result) => finish(tenant, id, { state: STATE.COMPLETED, result: result || null, finishedAt: Date.now(), error: null });

// mark_task_failed + retry_task : réessaie (backoff exponentiel) tant que `retryable` et sous la limite.
async function fail(tenant, id, error, retryable) {
  const doc = await load(tenant);
  const task = doc.tasks.find((t) => t.id === id);
  if (!task) return null;
  const again = retryable !== false && task.attempts < task.maxAttempts;
  return finish(tenant, id, again
    ? { state: STATE.QUEUED, error: String(error), runAt: Date.now() + 30000 * (2 ** (task.attempts - 1)) }
    : { state: STATE.FAILED, error: String(error), finishedAt: Date.now() });
}

async function cancel(tenant, id) {
  const doc = await load(tenant);
  const task = doc.tasks.find((t) => t.id === id);
  if (!task || [STATE.COMPLETED, STATE.FAILED, STATE.CANCELLED].includes(task.state)) return null;
  return finish(tenant, id, { state: STATE.CANCELLED, finishedAt: Date.now() });
}

// Pause / reprise / états intermédiaires (attente externe, vérification) : la tâche reste visible et reprend là où elle en était.
async function setState(tenant, id, state, extra) {
  if (![STATE.PAUSED, STATE.WAITING_EXTERNAL, STATE.VERIFYING, STATE.QUEUED].includes(state)) return null;
  const doc = await load(tenant);
  const task = doc.tasks.find((t) => t.id === id);
  if (!task || [STATE.COMPLETED, STATE.FAILED, STATE.CANCELLED].includes(task.state)) return null;
  return finish(tenant, id, Object.assign({ state }, extra || {}));
}
const pause = (tenant, id) => setState(tenant, id, STATE.PAUSED);
const resume = (tenant, id) => setState(tenant, id, STATE.QUEUED, { runAt: Date.now() });

// recover_queue : une tâche PROCESSING dont le bail a expiré (crash/redémarrage) est remise en file.
function recover(tenant, now) {
  const t0 = now == null ? Date.now() : now;
  return withTenant(tenant, async () => {
    const doc = await load(tenant);
    let n = 0;
    for (const t of doc.tasks) {
      if (t.state === STATE.PROCESSING && t.lockedUntil <= t0) {
        if (t.attempts >= t.maxAttempts) { t.state = STATE.FAILED; t.error = 'LEASE_EXPIRED_MAX_ATTEMPTS'; t.finishedAt = t0; }
        else { t.state = STATE.QUEUED; t.runAt = t0; }
        t.lockedUntil = 0; n += 1;
      }
    }
    if (n) await save(tenant, doc);
    return n;
  });
}

async function list(tenant, filter) {
  const doc = await load(tenant);
  const f = filter || {};
  return doc.tasks.filter((t) => (!f.state || t.state === f.state) && (!f.type || t.type === f.type) && (!f.ref || t.ref === f.ref));
}

async function status(tenant) {
  const doc = await load(tenant);
  const counts = {};
  for (const t of doc.tasks) counts[t.state] = (counts[t.state] || 0) + 1;
  const now = Date.now();
  const stuck = doc.tasks.filter((t) => t.state === STATE.PROCESSING && t.lockedUntil <= now).length;
  const overdue = doc.tasks.filter((t) => t.state === STATE.QUEUED && t.runAt < now - 10 * 60 * 1000).length;
  return { counts, stuck, overdue, total: doc.tasks.length };
}

// Worker : indépendant de l'interface. `handlers[type](task) -> { ok, result?, error?, retryable? }`.
async function processTenant(tenant, handlers, opts) {
  const o = opts || {};
  await recover(tenant);
  const done = [];
  for (let i = 0; i < (o.maxPerTick || 10); i += 1) {
    const task = await claimNext(tenant);
    if (!task) break;
    const handler = handlers[task.type];
    if (!handler) { await fail(tenant, task.id, `NO_HANDLER:${task.type}`, false); done.push({ id: task.id, ok: false }); continue; }
    try {
      const out = await handler(task);
      if (out && out.ok) { await complete(tenant, task.id, out.result); done.push({ id: task.id, ok: true }); }
      else { await fail(tenant, task.id, (out && out.error) || 'FAILED', out && out.retryable); done.push({ id: task.id, ok: false }); }
    } catch (e) { await fail(tenant, task.id, e.message, true); done.push({ id: task.id, ok: false }); }
  }
  return done;
}

function listTenants() { return storageAdapter.listIds(NAMESPACE); }

let timer = null;
function startWorker(handlersFor, intervalMs) {
  if (timer) return timer;
  const run = async () => {
    for (const tenant of listTenants()) {
      try { await processTenant(tenant, handlersFor(tenant)); } catch (e) { console.error(`taskQueue worker (${tenant}) :`, e.message); }
    }
  };
  timer = setInterval(run, intervalMs || 30000);
  if (timer.unref) timer.unref();
  return timer;
}
function stopWorker() { if (timer) { clearInterval(timer); timer = null; } }

module.exports = { NAMESPACE, STATE, PUBLIC_STATES, normalizeState, setState, pause, resume, enqueue, claimNext, complete, fail, cancel, recover, list, status, processTenant, startWorker, stopWorker, listTenants };
