// TEST — Tool Registry : exécution réelle, états explicites, vérification,
// enchaînement. Les outils de LECTURE tapent le vrai stockage (temp dir) ; les
// outils d'ACTION reçoivent un runtime injecté (double de test) pour prouver la
// logique d'états SUCCESS/UNCONFIRMED — l'envoi WhatsApp/Telegram RÉEL dépend
// d'un compte connecté et est vérifié séparément sur le VPS.
//   node --test test/tool-registry.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-tools-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.SECRET_VAULT_KEY = 'test-vault-key-tools';

const businessServices = require('../ai-engine/businessServices');
const contactCrm = require('../ai-engine/contactCrm');
const registry = require('../ai-engine/toolRegistry');

const T = 'tTools';

test('setup : un service avec produit + un contact', async () => {
  await businessServices.create(T, {
    name: 'Formations Cuisine', type: 'formation',
    commercial: { price: 8000, currency: 'FCFA' },
    products: [{ name: 'Formation Épicerie et Bouillon', price: 8000 }],
  });
  await contactCrm.recordSeen(T, { channel: 'WHATSAPP', from: '22600000001', name: 'Awa' });
});

test('getProductPrice : renvoie le VRAI prix (8000), pas d\'invention', async () => {
  const r = await registry.execute(T, 'getProductPrice', { query: 'Épicerie et Bouillon' });
  assert.equal(r.state, 'SUCCESS', JSON.stringify(r));
  assert.equal(r.result.found, true);
  assert.equal(r.result.price, 8000);
});

test('getProductPrice : produit inconnu -> found:false (jamais un prix inventé)', async () => {
  const r = await registry.execute(T, 'getProductPrice', { query: 'Mécanique automobile' });
  assert.equal(r.state, 'SUCCESS');
  assert.equal(r.result.found, false);
});

test('input requis manquant -> FAILED (MISSING_INPUT)', async () => {
  const r = await registry.execute(T, 'getProductPrice', {});
  assert.equal(r.state, 'FAILED');
  assert.equal(r.error.code, 'MISSING_INPUT');
  assert.deepEqual(r.error.fields, ['query']);
});

test('outil inconnu -> FAILED (UNKNOWN_TOOL)', async () => {
  const r = await registry.execute(T, 'toolQuiNexistePas', {});
  assert.equal(r.state, 'FAILED');
  assert.equal(r.error.code, 'UNKNOWN_TOOL');
});

test('permission manquante -> BLOCKED (jamais exécuté)', async () => {
  const r = await registry.execute(T, 'sendWhatsAppMessage', { to: '22600000001', text: 'salut' }, { permissions: [] });
  assert.equal(r.state, 'BLOCKED');
  assert.equal(r.error.permission, 'messages:send');
});

test('searchContacts : lit le vrai CRM', async () => {
  const r = await registry.execute(T, 'searchContacts', { query: 'Awa' });
  assert.equal(r.state, 'SUCCESS');
  assert.equal(r.result.count, 1);
  assert.equal(r.result.contacts[0].name, 'Awa');
});

test('sendWhatsAppMessage : envoi CONFIRMÉ -> SUCCESS avec réf', async () => {
  const runtime = { sendMessageVerified: async () => ({ status: 'SUCCESS', confirmationId: 'WAMID-REAL-123' }) };
  const r = await registry.execute(T, 'sendWhatsAppMessage', { to: '22600000001', text: 'ok' }, { runtime, permissions: ['messages:send'] });
  assert.equal(r.state, 'SUCCESS', JSON.stringify(r));
  assert.equal(r.verification.verified, true);
  assert.equal(r.result.confirmationId, 'WAMID-REAL-123');
});

test('sendWhatsAppMessage : envoi NON confirmé -> UNCONFIRMED (jamais faux SUCCESS)', async () => {
  const runtime = { sendMessageVerified: async () => ({ status: 'PENDING', confirmationId: null }) };
  const r = await registry.execute(T, 'sendWhatsAppMessage', { to: '22600000001', text: 'ok' }, { runtime, permissions: ['messages:send'] });
  assert.equal(r.state, 'UNCONFIRMED', JSON.stringify(r));
  assert.equal(r.verification.verified, false);
});

test('runChain : getLastMessage -> sendWhatsAppMessage (chaînage réel)', async () => {
  // seed d'un message entrant réel dans l'historique persistant
  await require('../ai-engine/messageHistory').record(T, { channel: 'WHATSAPP', direction: 'in', party: '22600000001', name: 'Awa', text: 'Bonjour', ts: Math.floor(Date.now() / 1000), chatId: '22600000001@c.us' });
  const runtime = { sendMessageVerified: async (p) => ({ status: 'SUCCESS', confirmationId: 'WAMID-CHAIN-' + p.to }) };
  const chain = await registry.runChain(T, [
    { name: 'getLastMessage', args: { channel: 'WHATSAPP' } },
    { name: 'sendWhatsAppMessage', argsFrom: (prev) => ({ to: prev[0].chatId, text: 'Merci ' + (prev[0].name || '') }) },
  ], { runtime, permissions: ['messages:send'] });
  assert.equal(chain.ok, true, JSON.stringify(chain));
  assert.equal(chain.steps.length, 2);
  assert.equal(chain.steps[0].state, 'SUCCESS');
  assert.equal(chain.steps[1].state, 'SUCCESS');
  assert.match(chain.steps[1].result.confirmationId, /WAMID-CHAIN-22600000001@c\.us/);
});

test('list : filtre par permissions (outils d\'action masqués sans droit)', () => {
  const withoutSend = registry.list({ permissions: [] }).map((t) => t.name);
  assert.ok(!withoutSend.includes('sendWhatsAppMessage'), 'send masqué sans permission');
  assert.ok(withoutSend.includes('getProductPrice'), 'lecture toujours visible');
  const withSend = registry.list({ permissions: ['messages:send'] }).map((t) => t.name);
  assert.ok(withSend.includes('sendWhatsAppMessage'));
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
