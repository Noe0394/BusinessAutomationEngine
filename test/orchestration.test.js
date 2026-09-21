// TEST RUNNER — orchestration : tâches récurrentes (queues/recurringTasks.js),
// routage d'intentions (grouppost/recurring) et envoi ciblé aux groupes
// (vps-runtime.sendToGroups). Isolé : stockage temporaire, session WhatsApp
// simulée, aucun réseau réel.
//   node --test test/orchestration.test.js

'use strict';

require('./helpers/auth').actAsAdmin(); // identité authentifiée de test (deny-by-default : voir ai-engine/authz.js)
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-orch-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.RECURRING_TZ_OFFSET_HOURS = '0';

const platformOrchestrator = require('../ai-engine/platformOrchestrator');
platformOrchestrator.notifyTenantChat = async () => {};

const recurringTasks = require('../queues/recurringTasks');
const chatOrchestrator = require('../ai-engine/chatOrchestrator');
const { createVpsRuntime } = require('../lib/intelligence/runtimes/vps-runtime.js');

test('recurringTasks : create / list / isDue / markRun / stopAll', async () => {
  const t = 'tenantR';
  const task = await recurringTasks.create(t, { channel: 'WHATSAPP', target: { kind: 'named', value: 'Prière' }, message: 'Bonjour 🙏', hour: 8, minute: 0 });
  assert.ok(task.id);
  const list1 = await recurringTasks.list(t);
  assert.equal(list1.length, 1);

  const at9 = new Date(Date.UTC(2026, 0, 1, 9, 0));
  const at7 = new Date(Date.UTC(2026, 0, 1, 7, 0));
  assert.equal(recurringTasks.isDue(task, at9), true, 'due à 9h (>= 8h, jamais tourné)');
  assert.equal(recurringTasks.isDue(task, at7), false, 'pas due à 7h (< 8h)');

  await recurringTasks.markRun(t, task.id, at9);
  const list2 = await recurringTasks.list(t);
  assert.equal(recurringTasks.isDue(list2[0], at9), false, 'plus due le même jour après markRun');
  const next = new Date(Date.UTC(2026, 0, 2, 9, 0));
  assert.equal(recurringTasks.isDue(list2[0], next), true, 're-due le lendemain');

  const n = await recurringTasks.stopAll(t);
  assert.equal(n, 1);
  const list3 = await recurringTasks.list(t);
  assert.equal(list3[0].active, false);
  assert.equal(recurringTasks.isDue(list3[0], next), false, 'inactive -> jamais due');
});

test('detectIntent : grouppost / recurring / distinction membres', () => {
  assert.equal(chatOrchestrator.detectIntent('poste cette affiche dans le groupe Clients VIP', null), 'grouppost');
  assert.equal(chatOrchestrator.detectIntent('partage ce message à tous mes groupes admin', null), 'grouppost');
  assert.equal(chatOrchestrator.detectIntent('chaque matin à 7h envoie un message de motivation au groupe Prière', null), 'recurring');
  assert.equal(chatOrchestrator.detectIntent('mes tâches récurrentes', null), 'recurring');
  // "aux membres" = envoi individuel (goal/campagne), pas une publication.
  assert.equal(chatOrchestrator.detectIntent('envoie un message aux membres du groupe X', null), 'goal');
});

function fakeWhatsappManager(sent) {
  const session = {
    tenantId: '__admin__',
    isConnected: () => true,
    isPaired: () => true,
    getGroupsSummary: async () => ([
      { id: 'g1@g.us', name: 'Clients VIP', size: 100, isAdmin: true },
      { id: 'g2@g.us', name: 'Discussion', size: 30, isAdmin: false },
      { id: 'g3@g.us', name: 'Formation Cuisine', size: 60, isAdmin: true },
    ]),
    sendMessage: async (id, text) => { sent.push({ id, text }); },
    sendMedia: async (id, media) => { sent.push({ id, media: true, caption: media.caption }); },
  };
  return { ADMIN_TENANT_ID: '__admin__', getOrCreate: () => ({ session, campaignEngine: {} }) };
}

test('runtime.sendToGroups : cible admin -> seuls les groupes admin', async () => {
  const sent = [];
  const runtime = createVpsRuntime({ whatsappManager: fakeWhatsappManager(sent) });
  const out = await runtime.sendToGroups({ channel: 'WHATSAPP', target: { kind: 'admin' }, text: 'Promo du jour' });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(out.sent, 2, 'g1 + g3 (admin), pas g2');
  const ids = sent.map((s) => s.id).sort();
  assert.deepEqual(ids, ['g1@g.us', 'g3@g.us']);
  assert.ok(sent.every((s) => s.text === 'Promo du jour'));
});

test('runtime.sendToGroups : cible par nom', async () => {
  const sent = [];
  const runtime = createVpsRuntime({ whatsappManager: fakeWhatsappManager(sent) });
  const out = await runtime.sendToGroups({ channel: 'WHATSAPP', target: { kind: 'named', value: 'Clients VIP' }, text: 'Coucou' });
  assert.equal(out.sent, 1);
  assert.equal(sent[0].id, 'g1@g.us');
});

test('runtime.sendToGroups : cible sans correspondance -> erreur claire', async () => {
  const sent = [];
  const runtime = createVpsRuntime({ whatsappManager: fakeWhatsappManager(sent) });
  const out = await runtime.sendToGroups({ channel: 'WHATSAPP', target: { kind: 'named', value: 'Inexistant' }, text: 'x' });
  assert.equal(out.ok, false);
  assert.equal(out.error, 'NO_MATCHING_GROUP');
  assert.equal(sent.length, 0);
});

test('runtime.sendToGroups : média joint -> sendMedia utilisé', async () => {
  const sent = [];
  const runtime = createVpsRuntime({ whatsappManager: fakeWhatsappManager(sent) });
  const out = await runtime.sendToGroups({
    channel: 'WHATSAPP', target: { kind: 'named', value: 'Formation Cuisine' },
    text: 'Voici l\'affiche', media: { buffer: Buffer.from('x'), mimetype: 'image/jpeg' },
  });
  assert.equal(out.sent, 1);
  assert.equal(sent[0].media, true);
  assert.equal(sent[0].caption, 'Voici l\'affiche');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
