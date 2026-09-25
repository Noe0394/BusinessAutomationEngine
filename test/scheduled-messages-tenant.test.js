'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-scheduled-tenant-'));
process.env.SCHEDULED_MESSAGES_PATH = path.join(dir, 'scheduled.json');
const store = require('../queues/scheduled_messages');
const { TOOLS } = require('../ai-engine/tool-modules/render-platforms');

test('les programmations sont isolées par tenant et les anciennes entrées restent admin-only', async () => {
  const at = new Date(Date.now() + 60_000).toISOString();
  const a = store.create({ tenantId: 'tenant-a', channel: 'whatsapp', recipients: ['a'], message: 'A', scheduledAt: at });
  const b = store.create({ tenantId: 'tenant-b', channel: 'telegram', recipients: ['b'], message: 'B', scheduledAt: at });
  const legacy = store.create({ channel: 'facebook_page', recipients: [], message: 'legacy', scheduledAt: at });

  assert.deepEqual(store.list({ tenantId: 'tenant-a' }).map((x) => x.id), [a.id]);
  assert.equal(store.get(b.id, { tenantId: 'tenant-a' }), null);
  assert.equal(store.cancel(b.id, { tenantId: 'tenant-a' }), null);
  assert.deepEqual(store.list({ tenantId: 'tenant-a', includeLegacy: true }).map((x) => x.id).sort(), [a.id, legacy.id].sort());
  assert.equal(store.get(legacy.id, { tenantId: 'tenant-a' }), null);
  assert.equal(store.get(legacy.id, { tenantId: 'admin', includeLegacy: true }).id, legacy.id);

  let created;
  const toolResult = await TOOLS.scheduleMessage.execute({
    channel: 'whatsapp', scheduledAt: at, message: 'Rappel', recipientsJson: '["22670000000"]', recipientType: 'contacts',
  }, {
    tenant: 'tenant-a', allowedModules: ['whatsapp'],
    scheduledMessages: { create(input) { created = store.create(input); return created; }, get: store.get },
  });
  assert.equal(toolResult.result.id, created.id);
  assert.equal(created.tenantId, 'tenant-a');
  assert.equal((await TOOLS.scheduleMessage.verify(toolResult.result, {}, { tenant: 'tenant-a', scheduledMessages: store })).verified, true);
  const visibleToA = await TOOLS.listScheduledMessages.execute({}, { tenant: 'tenant-a', allowedModules: ['whatsapp'], scheduledMessages: store });
  assert.ok(visibleToA.result.messages.every((item) => item.channel === 'whatsapp'));
  assert.ok(!visibleToA.result.messages.some((item) => item.message === 'B' || item.message === 'legacy'));

  const crossTenant = await TOOLS.cancelScheduledMessage.execute({ id: a.id }, { tenant: 'tenant-b', allowedModules: ['whatsapp'], scheduledMessages: store });
  assert.equal(crossTenant.error.code, 'SCHEDULE_NOT_FOUND');
  assert.equal(store.get(a.id, { tenantId: 'tenant-a' }).status, 'pending');

  fs.rmSync(dir, { recursive: true, force: true });
});
