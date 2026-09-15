// TEST RUNNER — exécution RÉELLE vérifiée : registre d'actions, historique
// persistant, envoi vérifié (jamais de faux SUCCESS), intention 'reply'.
//   node --test test/verified-execution.test.js
// Isolé : stockage temporaire, sessions simulées, LLM moqué — zéro réseau.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-verif-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;

const platformOrchestrator = require('../ai-engine/platformOrchestrator');
platformOrchestrator.notifyTenantChat = async () => {};
const llm = require('../lib/ai/llmFallbackEngine');
llm.generateAIResponse = async () => ({ text: 'Je vais bien.' });

const actionLedger = require('../ai-engine/actionLedger');
const messageHistory = require('../ai-engine/messageHistory');
const chatOrchestrator = require('../ai-engine/chatOrchestrator');
const { createVpsRuntime } = require('../lib/intelligence/runtimes/vps-runtime.js');

test('actionLedger : SUCCESS uniquement sur confirmation, FAILED reste FAILED', async () => {
  const t = 'tA';
  const a = await actionLedger.create(t, { type: 'SEND_MESSAGE', channel: 'WHATSAPP', target: 'x' });
  assert.equal(a.status, 'REQUESTED');
  await actionLedger.markInProgress(t, a.id);
  await actionLedger.markSuccess(t, a.id, { confirmationId: 'MSG_1' });
  const got = await actionLedger.get(t, a.id);
  assert.equal(got.status, 'SUCCESS');
  assert.equal(got.confirmation.confirmationId, 'MSG_1');

  const b = await actionLedger.create(t, { type: 'SEND_MESSAGE' });
  await actionLedger.markFailed(t, b.id, 'NOT_CONNECTED');
  assert.equal((await actionLedger.get(t, b.id)).status, 'FAILED');
});

test('messageHistory : record in/out + getLastIncoming + 7 jours', async () => {
  const t = 'tB';
  await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', party: '22660@c.us', name: 'Awa', text: 'Comment tu vas ?', ts: Math.floor(Date.now() / 1000) });
  await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'out', party: '22660@c.us', text: 'Je vais bien.', ts: Math.floor(Date.now() / 1000), confirmationId: 'MSG_2' });
  const last = await messageHistory.getLastIncoming(t, 'WHATSAPP');
  assert.ok(last && last.text === 'Comment tu vas ?', 'dernier message reçu retrouvé');
  const conv = await messageHistory.getConversation(t, 'WHATSAPP', '22660', 10);
  assert.equal(conv.length, 2, 'conversation reconstituée (in + out)');
  const since = await messageHistory.getSince(t, 'WHATSAPP', 7);
  assert.equal(since.length, 2, 'fenêtre 7 jours contient les 2 messages');
});

function fakeManager(sent, { connected = true, returns } = {}) {
  const session = {
    tenantId: '__admin__',
    isConnected: () => connected,
    isPaired: () => true,
    sendMessage: async (to, text) => { sent.push({ to, text }); return returns ? returns(to, text) : { key: { id: 'WAMSG_' + sent.length } }; },
    getRecentMessages: () => [],
  };
  return { ADMIN_TENANT_ID: '__admin__', getOrCreate: () => ({ session, campaignEngine: {} }) };
}

test('sendMessageVerified : envoi confirmé -> SUCCESS + historique out + ledger', async () => {
  const sent = [];
  const runtime = createVpsRuntime({ whatsappManager: fakeManager(sent) });
  const out = await runtime.sendMessageVerified({ channel: 'WHATSAPP', to: '22661@c.us', text: 'Salut', tenantId: 'tC' });
  assert.equal(out.status, 'SUCCESS', JSON.stringify(out));
  assert.ok(out.confirmationId, 'identifiant de confirmation réel');
  assert.equal(sent.length, 1);
  // Ledger + historique reflètent la réalité.
  const conv = await messageHistory.getConversation('tC', 'WHATSAPP', '22661', 5);
  assert.ok(conv.some((m) => m.direction === 'out' && m.text === 'Salut'), 'message sortant enregistré');
});

test('TEST DE VÉRITÉ : envoi hors-ligne -> FAILED, JAMAIS un faux SUCCESS', async () => {
  const sent = [];
  const runtime = createVpsRuntime({ whatsappManager: fakeManager(sent, { connected: false }) });
  const out = await runtime.sendMessageVerified({ channel: 'WHATSAPP', to: '22662@c.us', text: 'test', tenantId: 'tD' });
  assert.equal(out.status, 'FAILED');
  assert.equal(out.error, 'NOT_CONNECTED');
  assert.equal(sent.length, 0, 'aucun envoi réel tenté hors-ligne');
});

test('sendMessageVerified : plateforme ne confirme pas -> PENDING (pas SUCCESS)', async () => {
  const sent = [];
  const runtime = createVpsRuntime({ whatsappManager: fakeManager(sent, { returns: () => ({}) }) }); // pas d'id
  const out = await runtime.sendMessageVerified({ channel: 'WHATSAPP', to: '22663@c.us', text: 'x', tenantId: 'tE' });
  assert.equal(out.status, 'PENDING');
});

test('detectIntent : reply / actionsreport', () => {
  assert.equal(chatOrchestrator.detectIntent('réponds-lui que je vais bien', null), 'reply');
  assert.equal(chatOrchestrator.detectIntent('dis-lui que j\'arrive', null), 'reply');
  assert.equal(chatOrchestrator.detectIntent('qu\'as-tu fait ?', null), 'actionsreport');
  assert.equal(chatOrchestrator.detectIntent('statut de tes actions', null), 'actionsreport');
});

test('handle(reply) : rapport de vérité SUCCESS avec le vrai destinataire', async () => {
  const t = 'tF';
  await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', party: '22664@c.us', name: 'Koffi', text: 'Comment tu vas ?', ts: Math.floor(Date.now() / 1000) });
  const res = await chatOrchestrator.handle(
    { text: 'réponds-lui que je vais bien', history: [], tenantId: t, sessionId: 's' },
    { runtime: { sendMessageVerified: async (p) => { assert.equal(p.to, '22664@c.us'); return { ok: true, status: 'SUCCESS', confirmationId: 'CONF1' }; } } },
  );
  assert.ok(/CONFIRMÉE/.test(res.text), res.text);
  assert.ok(/Koffi/.test(res.text));
  assert.ok(/Je vais bien/.test(res.text));
});

test('handle(reply) : échec réel -> ACTION ÉCHOUÉE (jamais "c\'est fait")', async () => {
  const t = 'tG';
  await messageHistory.record(t, { channel: 'WHATSAPP', direction: 'in', party: '22665@c.us', name: 'Ama', text: 'salut', ts: Math.floor(Date.now() / 1000) });
  const res = await chatOrchestrator.handle(
    { text: 'réponds-lui que je vais bien', history: [], tenantId: t, sessionId: 's2' },
    { runtime: { sendMessageVerified: async () => ({ ok: false, status: 'FAILED', error: 'NOT_CONNECTED' }) } },
  );
  assert.ok(/ÉCHOUÉE/.test(res.text), res.text);
  assert.ok(!/CONFIRMÉE/.test(res.text));
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
