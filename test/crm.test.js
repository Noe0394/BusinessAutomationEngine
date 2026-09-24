// TEST RUNNER — CRM de contacts (ai-engine/contactCrm.js) + intention 'crm'.
//   node --test test/crm.test.js
// Isolé : stockage redirigé vers un dossier temporaire, notification moquée.

'use strict';

require('./helpers/auth').actAsAdmin(); // identité authentifiée de test (deny-by-default : voir ai-engine/authz.js)
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-crm-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;

const platformOrchestrator = require('../ai-engine/platformOrchestrator');
platformOrchestrator.notifyTenantChat = async () => {};

const contactCrm = require('../ai-engine/contactCrm');
const chatOrchestrator = require('../ai-engine/chatOrchestrator');

test('recordSeen : nouveau contact étiqueté nouveau_contact + prospect', async () => {
  const t = 'tenantA';
  const r1 = await contactCrm.recordSeen(t, { channel: 'WHATSAPP', from: '22600000001@s.whatsapp.net', name: 'Awa' });
  assert.equal(r1.isNew, true);
  assert.ok(r1.contact.tags.includes('nouveau_contact'));
  assert.ok(r1.contact.tags.includes('prospect'));
  const r2 = await contactCrm.recordSeen(t, { channel: 'WHATSAPP', from: '22600000001@s.whatsapp.net' });
  assert.equal(r2.isNew, false, 'même contact -> pas nouveau');
  assert.equal(r2.contact.messageCount, 2);
});

test('recordIncoming : enregistre chaque conversation privée et ignore les groupes', async () => {
  const t = 'tenantInbound';
  const first = await contactCrm.recordIncoming(t, {
    channel: 'WHATSAPP', from: '22600000009@s.whatsapp.net', name: 'Nafi', isGroup: false,
  });
  assert.equal(first.isNew, true);
  assert.ok(first.contact.tags.includes('nouveau_contact'));
  assert.ok(first.contact.tags.includes('prospect'));

  const group = await contactCrm.recordIncoming(t, {
    channel: 'WHATSAPP', from: '120363000000000000@g.us', name: 'Groupe', isGroup: true,
  });
  assert.equal(group.contact, null);
  assert.equal((await contactCrm.counts(t)).total, 1, 'un groupe ne doit pas apparaître comme client');

  const repeated = await contactCrm.recordIncoming(t, {
    channel: 'WHATSAPP', from: '22600000009@s.whatsapp.net', isGroup: false,
  });
  assert.equal(repeated.isNew, false);
  assert.equal(repeated.contact.messageCount, 2);
});

test('pipeline entrant : l’enregistrement CRM précède les routeurs qui peuvent retourner tôt', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const handler = source.indexOf('async function handleIncomingCustomerMessage');
  const record = source.indexOf('contactCrm.recordIncoming(', handler);
  const privateRoute = source.indexOf('assistant.route({', handler);
  const autoReply = source.indexOf('autoResponder.handleIncoming(', privateRoute);
  assert.ok(handler >= 0 && record > handler, 'le handler doit enregistrer le contact');
  assert.ok(privateRoute > record && autoReply > privateRoute, 'le CRM doit précéder les sorties des routeurs');
});

test('markPurchase : le contact devient client (retire nouveau_contact)', async () => {
  const t = 'tenantB';
  await contactCrm.recordSeen(t, { channel: 'WHATSAPP', from: '22600000002@s.whatsapp.net', name: 'Koffi' });
  const c = await contactCrm.markPurchase(t, 'WHATSAPP', '22600000002@s.whatsapp.net', { sku: 'cuisine_patisserie' });
  assert.ok(c.tags.includes('client'));
  assert.ok(!c.tags.includes('nouveau_contact'), 'nouveau_contact retiré');
  assert.equal(c.purchases.length, 1);
  const clients = await contactCrm.list(t, { tag: 'client' });
  assert.equal(clients.length, 1);
});

test('list + counts filtrent par étiquette', async () => {
  const t = 'tenantC';
  await contactCrm.recordSeen(t, { channel: 'WHATSAPP', from: 'a@s.whatsapp.net', name: 'A' });
  await contactCrm.recordSeen(t, { channel: 'TELEGRAM', from: '111', name: 'B' });
  await contactCrm.markPurchase(t, 'WHATSAPP', 'a@s.whatsapp.net', { sku: 'x' });
  const clients = await contactCrm.list(t, { tag: 'client' });
  assert.equal(clients.length, 1);
  const prospects = await contactCrm.list(t, { tag: 'prospect' });
  assert.equal(prospects.length, 1, 'seul B reste prospect (A est passé client)');
  const cnt = await contactCrm.counts(t);
  assert.equal(cnt.total, 2);
  assert.equal(cnt.byTag.client, 1);
});

test('detectIntent reconnaît une demande CRM', () => {
  assert.equal(chatOrchestrator.detectIntent('montre mes prospects', null), 'crm');
  assert.equal(chatOrchestrator.detectIntent('combien de clients ai-je ?', null), 'crm');
  assert.equal(chatOrchestrator.detectIntent('liste mes contacts étiquetés vip', null), 'crm');
  // Ne casse pas un vrai objectif de prospection.
  assert.equal(chatOrchestrator.detectIntent('prospecter 100 contacts sur whatsapp', null), 'goal');
});

test('handle(crm) liste les contacts par étiquette', async () => {
  const t = 'tenantD';
  await contactCrm.recordSeen(t, { channel: 'WHATSAPP', from: 'p1@s.whatsapp.net', name: 'Prospect1' });
  await contactCrm.recordSeen(t, { channel: 'WHATSAPP', from: 'p2@s.whatsapp.net', name: 'Prospect2' });
  const res = await chatOrchestrator.handle(
    { text: 'montre mes prospects', history: [], tenantId: t, sessionId: 'x' },
    {},
  );
  assert.ok(/Prospect1/.test(res.text) && /Prospect2/.test(res.text), res.text);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
