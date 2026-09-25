'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-task-queue-'));
process.env.AI_ENGINE_STORAGE_DIR = ROOT;
const taskQueue = require('../ai-engine/taskQueue');

function waitFor(predicate, timeoutMs = 2000) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = async () => {
      if (await predicate()) return resolve();
      if (Date.now() - started >= timeoutMs) return reject(new Error('Timed out waiting for the task worker'));
      setTimeout(poll, 10);
    };
    poll();
  });
}

test('worker wakes on enqueue, observes priority, and resumes an expired lease', async () => {
  const recovered = await taskQueue.enqueue('lease-test', { type: 'PING', payload: { id: 'recovered' } });
  const claimed = await taskQueue.claimNext('lease-test');
  assert.equal(claimed.id, recovered.task.id);
  assert.equal(await taskQueue.recover('lease-test', claimed.lockedUntil + 1), 1);
  assert.equal((await taskQueue.list('lease-test'))[0].state, taskQueue.STATE.QUEUED);

  const order = [];
  const tenant = 'worker-wake';
  await taskQueue.enqueue(tenant, { type: 'PING', payload: { id: 'low' }, priority: -10 });
  await taskQueue.enqueue(tenant, { type: 'PING', payload: { id: 'high' }, priority: 10 });
  taskQueue.startWorker(() => ({ PING: async (task) => { order.push(task.payload.id); return { ok: true }; } }), 60000, { concurrency: 2 });
  await waitFor(async () => (await taskQueue.list(tenant)).every((task) => task.state === taskQueue.STATE.COMPLETED));
  assert.deepEqual(order.slice(-2), ['high', 'low']);
  assert.ok(taskQueue.workerStatus().lastCompletedAt);

  const queuedAt = Date.now();
  const wake = await taskQueue.enqueue(tenant, { type: 'PING', payload: { id: 'woken' } });
  await waitFor(async () => (await taskQueue.list(tenant)).find((task) => task.id === wake.task.id).state === taskQueue.STATE.COMPLETED);
  assert.ok(Date.now() - queuedAt < 1500, 'une tâche due ne doit pas attendre le balayage de garde');
});

test('an expired in-flight message send requires verification instead of an automatic resend', async () => {
  const tenant = 'uncertain-send';
  const { task } = await taskQueue.enqueue(tenant, { type: 'SEND_MESSAGE', payload: { to: 'test-only' } });
  const claimed = await taskQueue.claimNext(tenant);
  assert.equal(claimed.id, task.id);
  assert.equal(await taskQueue.recover(tenant, claimed.lockedUntil + 1), 1);
  const [recovered] = await taskQueue.list(tenant);
  assert.equal(recovered.state, taskQueue.STATE.VERIFYING);
  assert.equal(recovered.error, 'EXECUTION_UNCONFIRMED_AFTER_RESTART');
});

test.after(() => {
  taskQueue.stopWorker();
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* best effort */ }
});
