'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-campaign-idem-'));
process.env.CAMPAIGNS_DIR = path.join(ROOT, 'campaigns');
process.env.AI_ENGINE_STORAGE_DIR = path.join(ROOT, 'storage');
process.env.GITHUB_TOKEN = '';
const { CampaignEngine } = require('../queues/campaignEngine');

test('la même clé de brouillon retourne la campagne déjà créée', async () => {
  const sent = [];
  const session = {
    isConnected: () => true,
    getContactName: () => '',
    onIncomingMessage: () => {},
    onAccountReset: () => {},
    sendMessage: async (to, text) => { sent.push({ to, text }); return { key: { id: 'msg-' + sent.length } }; },
    sendMedia: async () => ({}),
  };
  const tenant = 'idempotent-tenant-' + Date.now();
  const engine = new CampaignEngine(tenant, session, () => {}, () => {});
  const recipients = [{ telephone: '2267' + String(Date.now()).slice(-7), nom: 'Awa' }];
  const options = { idempotencyKey: 'draft_' + tenant, sequence: [{ type: 'text', text: 'Bonjour ' + tenant + ' {nom}' }] };
  const [first, retry] = await Promise.all([engine.start(recipients, options), engine.start(recipients, options)]);
  assert.equal(retry.id, first.id);
  assert.equal(engine.campaigns.size, 1);
  const deadline = Date.now() + 3000;
  while (!sent.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(sent.length, 1);
  assert.equal(engine.getStatus(first.id).id, 'draft_' + tenant);
  try { await engine.stop(first.id); } catch (_) { /* une campagne test à un seul contact peut déjà être terminée */ }
});

test.after(() => {
  try { fs.rmSync(ROOT, { recursive: true, force: true }); } catch (_) { /* nettoyage de test */ }
});
