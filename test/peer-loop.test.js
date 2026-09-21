// TEST — anti-boucle entre comptes Cyrus (signature invisible + numéro d'un autre compte) et « réponds… » qui ne détourne plus une instruction de configuration.
//   node --test test/peer-loop.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-peer-'));
process.env.GITHUB_TOKEN = ''; process.env.AUTO_REPLY_DEBOUNCE_MS = '0'; process.env.GEMINI_API_KEY = 'test-key';
require('./helpers/auth').actAsAdmin();
const sig = require('../ai-engine/botSignature');
const autoResponder = require('../ai-engine/autoResponder');
const waManager = require('../adapters/whatsappManager');
const orchestrator = require('../ai-engine/chatOrchestrator');
const businessServices = require('../ai-engine/businessServices');

test('signature : ajoutée une seule fois, invisible, détectée, retirable', () => {
  const s = sig.sign('Bonjour !'); assert.equal(sig.sign(s), s); assert.ok(sig.isSigned(s)); assert.equal(sig.strip(s), 'Bonjour !');
  assert.equal(sig.isSigned('Bonjour !'), false); assert.equal(s.replace(/[⁢⁣]/g, ''), 'Bonjour !');
});

test('un message SIGNÉ par un assistant ne déclenche jamais de réponse automatique (aucune boucle possible)', async () => {
  const T = 'peerA'; await businessServices.create(T, { name: 'Formation', products: [{ name: 'Cours', price: 5000 }] });
  const sent = []; const runtime = { sendMessageVerified: async (m) => { sent.push(m); return { status: 'SUCCESS', confirmationId: 'c' + sent.length }; } };
  const r = await autoResponder.handleIncoming({ tenantId: T, channel: 'WHATSAPP', from: '22670000001@s.whatsapp.net', name: 'Autre', text: 'Bonjour, comment puis-je vous aider ?' + sig.SIG, messageId: 'p1' }, { runtime, settings: { whatsapp: true } });
  assert.equal(r.skipped, 'PEER_BOT'); assert.equal(sent.length, 0);
});

test('les réponses automatiques de Cyrus portent la signature (le pair les reconnaîtra)', async () => {
  const T = 'peerB'; await businessServices.create(T, { name: 'Formation', products: [{ name: 'Cours', price: 5000 }] });
  const sent = []; const runtime = { sendMessageVerified: async (m) => { sent.push(m); return { status: 'SUCCESS', confirmationId: 'c' }; } };
  const llm = async () => 'Bonjour ! Le cours coûte 5000 FCFA.';
  await autoResponder.handleIncoming({ tenantId: T, channel: 'WHATSAPP', from: '22670000002@s.whatsapp.net', name: 'Client', text: 'Bonjour, quel est le prix ?', messageId: 'p2' }, { runtime, settings: { whatsapp: true }, llm });
  assert.ok(sent.length >= 1 && sent.every((m) => sig.isSigned(m.text)), 'toute réponse automatique est signée');
});

test('boucle entre deux comptes Cyrus du même serveur : une réponse autorisée (test humain), la suivante coupée', async () => {
  const T = 'peerC'; sig._reset();
  const orig = waManager.isNumberOfOtherTenant; waManager.isNumberOfOtherTenant = (d) => d === '22670000003';
  try {
    const from = '22670000003@s.whatsapp.net';
    assert.equal(sig.detectPeer({ tenantId: T, channel: 'WHATSAPP', from, text: 'salut' }), null, 'première réponse autorisée');
    const second = sig.detectPeer({ tenantId: T, channel: 'WHATSAPP', from, text: 'salut encore' });
    assert.equal(second.reason, 'PEER_CYRUS_ACCOUNT_LOOP_GUARD');
    assert.equal(sig.detectPeer({ tenantId: T, channel: 'WHATSAPP', from: '22670000009@s.whatsapp.net', text: 'salut' }), null, 'un client ordinaire n\'est pas concerné');
    assert.equal(sig.detectPeer({ tenantId: T, channel: 'TELEGRAM', from: '123', text: 'salut' }), null);
  } finally { waManager.isNumberOfOtherTenant = orig; }
});

test('« réponds aux prospects » dans une instruction de configuration n\'est PAS un ordre d\'envoi au dernier contact', () => {
  const long = 'Crée un service métier nommé RIEA Afrique, type formation. Il doit répondre aux prospects avec un ton chaleureux, prix 5000 FCFA, et répondre à toutes les questions sur la plateforme.';
  assert.equal(orchestrator.detectIntent(long), 'configsvc');
  assert.equal(orchestrator.detectIntent('configure mon service métier RIEA et réponds aux clients à ma place'), 'configsvc');
  assert.equal(orchestrator.detectIntent('réponds-lui que je le rappelle'), 'reply');
  assert.notEqual(orchestrator.detectIntent('Réponds à Jean : ' + 'bla '.repeat(150)), 'reply', 'un long texte n\'est pas une réponse à envoyer');
});
