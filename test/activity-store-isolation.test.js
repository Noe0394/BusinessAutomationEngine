'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const previousDir = process.env.AI_ENGINE_STORAGE_DIR;
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-activity-isolation-'));
process.env.AI_ENGINE_STORAGE_DIR = tempDir;
const activityStore = require('../ai-engine/activityStore');

test('activity summaries filter events and counts by tenant', async () => {
  const date = new Date().toISOString().slice(0, 10);
  await activityStore.record({ tenant: 'ACCOUNT_A', type: 'message_in', status: 'ok', channel: 'WHATSAPP', target: 'private-a' });
  await activityStore.record({ tenant: 'ACCOUNT_B', type: 'error', status: 'error', channel: 'TELEGRAM', target: 'private-b' });

  const a = await activityStore.summary(date, 300, 'ACCOUNT_A');
  const b = await activityStore.summary(date, 300, 'ACCOUNT_B');
  const global = await activityStore.summary(date, 300);
  assert.equal(a.events.length, 1);
  assert.equal(a.events[0].target, 'private-a');
  assert.deepEqual(a.counts.byStatus, { ok: 1 });
  assert.equal(b.events.length, 1);
  assert.equal(b.events[0].target, 'private-b');
  assert.deepEqual(b.counts.byStatus, { error: 1 });
  assert.equal(global.events.length, 2);
});

test.after(() => {
  if (previousDir === undefined) delete process.env.AI_ENGINE_STORAGE_DIR; else process.env.AI_ENGINE_STORAGE_DIR = previousDir;
  fs.rmSync(tempDir, { recursive: true, force: true });
});
