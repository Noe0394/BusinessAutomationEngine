'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-campaign-license-'));
process.env.AI_ENGINE_STORAGE_DIR = tmp;
process.env.SECRET_VAULT_KEY = 'test-campaign-license-key';
process.env.DEFAULT_COUNTRY_CODE = '226';

const authz = require('../ai-engine/authz');
const campaigns = require('../ai-engine/campaignService');
const runtime = { getCampaignStatus: async () => ({ ok: true, result: { campaigns: [] } }) };

async function asTenant(tenant, modules, callback) {
  const principal = authz.issuePrincipal({ tenant, role: 'OWNER', allowedModules: modules });
  return authz.runAs(principal, callback);
}

test('ACCOUNT_A / B / C campaigns remain tenant isolated and obey channel entitlements', async () => {
  const a = await asTenant('ACCOUNT_A', ['whatsapp'], async () => {
    const recipients = await campaigns.prepareRecipients('ACCOUNT_A', { text: 'Awa +22670000001' }, { allowedModules: ['whatsapp'] });
    return campaigns.createCampaign('ACCOUNT_A', { recipientsId: recipients.recipientsId, name: 'A only', text: 'A', channel: 'WHATSAPP' }, ['whatsapp']);
  });

  const b = await asTenant('ACCOUNT_B', ['telegram'], async () => {
    const recipients = await campaigns.prepareRecipients('ACCOUNT_B', { text: 'Binta +22670000002' }, { allowedModules: ['telegram'] });
    return campaigns.createCampaign('ACCOUNT_B', { recipientsId: recipients.recipientsId, name: 'B only', text: 'B', channel: 'TELEGRAM' }, ['telegram']);
  });

  const c = await asTenant('ACCOUNT_C', ['whatsapp', 'telegram'], async () => {
    const recipients = await campaigns.prepareRecipients('ACCOUNT_C', { text: 'Cissé +22670000003' }, { allowedModules: ['whatsapp', 'telegram'] });
    return campaigns.createCampaign('ACCOUNT_C', { recipientsId: recipients.recipientsId, name: 'C only', text: 'C', channel: 'WHATSAPP' }, ['whatsapp', 'telegram']);
  });

  for (const [tenant, id, modules] of [
    ['ACCOUNT_A', a.id, ['whatsapp']],
    ['ACCOUNT_B', b.id, ['telegram']],
    ['ACCOUNT_C', c.id, ['whatsapp', 'telegram']],
  ]) {
    const owned = await campaigns.get(tenant, id, runtime, {}, modules);
    assert.equal(owned.id, id);
  }

  await assert.rejects(() => campaigns.get('ACCOUNT_A', b.id, runtime, {}, ['whatsapp']), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(() => campaigns.get('ACCOUNT_B', a.id, runtime, {}, ['telegram']), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(() => campaigns.get('ACCOUNT_C', a.id, runtime, {}, ['whatsapp', 'telegram']), (e) => e.code === 'NOT_FOUND');

  assert.deepEqual((await campaigns.list('ACCOUNT_A', runtime, ['whatsapp'])).map((x) => x.id), [a.id]);
  assert.deepEqual((await campaigns.list('ACCOUNT_B', runtime, ['telegram'])).map((x) => x.id), [b.id]);
  assert.deepEqual((await campaigns.list('ACCOUNT_C', runtime, ['whatsapp', 'telegram'])).map((x) => x.id), [c.id]);

  await assert.rejects(() => campaigns.launch('ACCOUNT_A', a.id, runtime, ['telegram']), (e) => e.code === 'MODULE_NOT_ALLOWED' && e.http === 403);
  await assert.rejects(() => campaigns.schedule('ACCOUNT_B', b.id, new Date(Date.now() + 60000).toISOString(), ['whatsapp']), (e) => e.code === 'MODULE_NOT_ALLOWED' && e.http === 403);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
