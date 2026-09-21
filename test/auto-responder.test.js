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
  assert.match(rec[0].text, /8000/);
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

test('composeReply s\'appuie sur le contexte métier réel', async () => {
  const txt = await autoResponder.composeReply({ tenant: T, channel: 'WHATSAPP', from: '22600000002', name: 'Koffi', text: 'prix ?', llm: async (prompt) => {
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
