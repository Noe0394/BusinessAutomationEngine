// TEST — Auto-responder (autonomie conversationnelle) : idempotence, opt-in,
// compose ancré sur le contexte métier, envoi vérifié, statut honnête.
//   node --test test/auto-responder.test.js
// Runtime + LLM injectés (doubles de test) ; l'envoi réel vérifié est prouvé
// séparément sur le VPS (compte connecté).

'use strict';

require('./helpers/auth').actAsAdmin(); // identité authentifiée de test (deny-by-default : voir ai-engine/authz.js)
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-auto-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.SECRET_VAULT_KEY = 'test-vault-key-auto';

const businessServices = require('../ai-engine/businessServices');
const autoResponder = require('../ai-engine/autoResponder');

const T = 'tAuto';

function fakeLlm() { return async () => 'Bonjour ! La Formation Épicerie et Bouillon est à 8000 FCFA. Je vous explique ?'; }
function fakeRuntime(record) {
  return { sendMessageVerified: async (p) => { record.push(p); return { status: 'SUCCESS', confirmationId: 'WAMID-AUTO-' + record.length }; } };
}

test('setup service + activation', async () => {
  await businessServices.create(T, { name: 'Cuisine', type: 'formation', products: [{ name: 'Formation Épicerie et Bouillon', price: 8000 }], commercial: { currency: 'FCFA' } });
  const s = await autoResponder.setSettings(T, { whatsapp: true });
  assert.equal(s.whatsapp, true);
});

test('désactivé -> skip DISABLED (aucun envoi)', async () => {
  const rec = [];
  const out = await autoResponder.handleIncoming(
    { tenantId: 'tOff', channel: 'WHATSAPP', from: '22600000001', text: 'salut', messageId: 'a1' },
    { runtime: fakeRuntime(rec), llm: fakeLlm() },
  );
  assert.equal(out.skipped, 'DISABLED');
  assert.equal(rec.length, 0);
});

test('activé -> compose (ancré prix réel) + envoi vérifié', async () => {
  const rec = [];
  const out = await autoResponder.handleIncoming(
    { tenantId: T, channel: 'WHATSAPP', from: '22600000001', name: 'Awa', text: 'ça coûte combien ?', messageId: 'b1' },
    { runtime: fakeRuntime(rec), llm: fakeLlm() },
  );
  assert.equal(out.sent, true, JSON.stringify(out));
  assert.equal(out.status, 'SUCCESS');
  assert.match(out.confirmationId, /WAMID-AUTO-/);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].to, '22600000001');
  assert.match(rec[0].text, /8\s?000/);
});

test('question commerciale explicite : le registre naturel ne bloque pas la réponse du Service métier', async () => {
  const tenant = 'tAutoNaturalPrice'; const sent = [];
  await businessServices.create(tenant, {
    name: 'Cuisine', products: [{ name: 'Formation Cuisine et Pâtisserie', price: 12500 }],
    commercial: { currency: 'FCFA' },
  });
  await autoResponder.setSettings(tenant, { whatsapp: true });
  const out = await autoResponder.handleIncoming({
    tenantId: tenant, channel: 'WHATSAPP', from: '22600000991', name: 'Test',
    text: 'Quel est le prix de la Formation Cuisine et Pâtisserie ?', messageId: 'natural-price-1',
  }, {
    runtime: fakeRuntime(sent),
    llm: async () => 'La Formation Cuisine et Pâtisserie coûte 12 500 FCFA.',
    engagementFn: async () => ({ respond: true, code: 'TEST_NATURAL', why: 'test', register: 'NATURAL', directives: [] }),
  });
  assert.equal(out.sent, true, JSON.stringify(out));
  assert.match(sent[0].text, /12\s?500\s?FCFA/i);
  assert.doesNotMatch(sent[0].text, /reviens vers vous très vite avec une réponse précise/i);
});

test('prix retrouvé par alias : réponse réelle sans appel IA', async () => {
  const tenant = 'tAutoAliasPrice'; const sent = [];
  await businessServices.create(tenant, {
    name: 'Formation Cuisine et Pâtisserie',
    aliases: ['ma formation cuisine'],
    products: [{ name: 'Formation Cuisine et Pâtisserie', aliases: ['formation pâtisserie', 'cours de cuisine'], price: 12500 }],
    commercial: { currency: 'FCFA' },
  });
  await autoResponder.setSettings(tenant, { whatsapp: true });
  let aiCalls = 0;
  const out = await autoResponder.handleIncoming({
    tenantId: tenant, channel: 'WHATSAPP', from: '22600000992', name: 'Test',
    text: 'Quel est le prix de ma formation pâtisserie ?', messageId: 'alias-price-1',
  }, {
    runtime: fakeRuntime(sent),
    llm: async () => { aiCalls += 1; return 'réponse IA non utilisée'; },
    engagementFn: async () => ({ respond: true, code: 'TEST_BUSINESS', why: 'question sur l’offre', register: 'BUSINESS_ANSWER', directives: [] }),
  });
  assert.equal(out.sent, true, JSON.stringify(out));
  assert.equal(aiCalls, 0, 'un prix configuré est servi sans génération IA');
  assert.match(sent[0].text, /12\s?500\s?FCFA/i);
});

test('même messageId -> DUPLICATE (pas de double réponse)', async () => {
  const rec = [];
  const out = await autoResponder.handleIncoming(
    { tenantId: T, channel: 'WHATSAPP', from: '22600000001', text: 'ça coûte combien ?', messageId: 'b1' },
    { runtime: fakeRuntime(rec), llm: fakeLlm() },
  );
  assert.equal(out.skipped, 'DUPLICATE');
  assert.equal(rec.length, 0);
});

test('sans runtime -> NO_RUNTIME (jamais de faux succès)', async () => {
  const out = await autoResponder.handleIncoming(
    { tenantId: T, channel: 'WHATSAPP', from: '22600000009', text: 'coucou', messageId: 'c1' },
    { llm: fakeLlm() },
  );
  assert.equal(out.skipped, 'NO_RUNTIME');
});

test('NO_RUNTIME ne consomme pas le message : même identifiant retenté dès que la session revient', async () => {
  const tenant = 'tAutoRuntimeRetry'; const record = [];
  await businessServices.create(tenant, { name: 'Cuisine', products: [{ name: 'Formation', price: 8000 }], commercial: { currency: 'FCFA' } });
  await autoResponder.setSettings(tenant, { whatsapp: true });
  const msg = { tenantId: tenant, channel: 'WHATSAPP', from: '22600000111', text: 'combien coûte la Formation ?', messageId: 'runtime-retry-1' };
  assert.equal((await autoResponder.handleIncoming(msg, { llm: fakeLlm() })).skipped, 'NO_RUNTIME');
  const retried = await autoResponder.handleIncoming(msg, { runtime: fakeRuntime(record), llm: fakeLlm() });
  assert.equal(retried.sent, true); assert.equal(record.length, 1);
});

test('PENDING sans accusé de la plateforme ne marque pas la conversation comme répondue', async () => {
  const tenant = 'tAutoPending';
  await businessServices.create(tenant, { name: 'Cuisine', products: [{ name: 'Formation', price: 8000 }], commercial: { currency: 'FCFA' } });
  await autoResponder.setSettings(tenant, { whatsapp: true });
  const out = await autoResponder.handleIncoming(
    { tenantId: tenant, channel: 'WHATSAPP', from: '22600000112', text: 'combien coûte la Formation ?', messageId: 'pending-1' },
    { runtime: { sendMessageVerified: async () => ({ status: 'PENDING' }) }, llm: fakeLlm() },
  );
  assert.equal(out.sent, false); assert.equal(out.status, 'PENDING');
  const state = await require('../ai-engine/jarvis/conversationState').get(tenant, 'WHATSAPP', '22600000112');
  assert.ok(!state.lastReplyTs); assert.equal(state.recentReplies.length, 0);
  assert.ok(state.processedIds.includes('pending-1'), 'un résultat incertain reste dédupliqué pour éviter un double envoi');
});

test('un échec d’envoi certain laisse le même message retraitable', async () => {
  const tenant = 'tAutoSendRetry'; const from = '22600000113'; const msg = { tenantId: tenant, channel: 'WHATSAPP', from, text: 'combien coûte la Formation ?', messageId: 'send-retry-1' };
  await businessServices.create(tenant, { name: 'Cuisine', products: [{ name: 'Formation', price: 8000 }], commercial: { currency: 'FCFA' } });
  await autoResponder.setSettings(tenant, { whatsapp: true });
  const failed = await autoResponder.handleIncoming(msg, { runtime: { sendMessageVerified: async () => ({ status: 'FAILED', error: 'NOT_CONNECTED' }) }, llm: fakeLlm() });
  assert.equal(failed.status, 'FAILED'); assert.equal(failed.sent, false);
  const retried = await autoResponder.handleIncoming(msg, { runtime: fakeRuntime([]), llm: fakeLlm() });
  assert.equal(retried.sent, true, JSON.stringify(retried));
});

test('composeReply s\'appuie sur le contexte métier réel', async () => {
  const txt = await autoResponder.composeReply({ tenant: T, channel: 'WHATSAPP', from: '22600000002', name: 'Koffi', text: 'Parle-moi de cette formation.', llm: async (prompt) => {
    // prouve que le prompt contient bien le contexte métier réel injecté
    assert.match(prompt, /Formation Épicerie et Bouillon/);
    assert.match(prompt, /8000/);
    return 'Réponse test';
  } });
  assert.equal(txt, 'Réponse test');
});

test('sans offre configurée : le prompt INTERDIT d\'inventer un produit/domaine', async () => {
  let captured = '';
  await autoResponder.composeReply({ tenant: 'tenantSansOffre', channel: 'WHATSAPP', from: '22600000003', text: 'vous vendez quoi ?', llm: async (p) => { captured = p; return 'ok'; } });
  assert.match(captured, /AUCUNE offre n'est configurée/i);
  assert.match(captured, /n'invente JAMAIS un produit/i);
  assert.match(captured, /NE CITE AUCUN produit/i);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
