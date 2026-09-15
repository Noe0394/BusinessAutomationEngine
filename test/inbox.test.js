// TEST RUNNER — lecture de la boîte de réception par la couche intelligence.
//   node --test test/inbox.test.js
// Isolé : stockage redirigé, notification admin moquée, runtime moqué — aucun
// appel réseau, aucune session WhatsApp/Telegram réelle.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-inbox-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;

const platformOrchestrator = require('../ai-engine/platformOrchestrator');
platformOrchestrator.notifyTenantChat = async () => {};

const chatOrchestrator = require('../ai-engine/chatOrchestrator');
const actionExecutorMod = require('../lib/intelligence/action-executor');

test('detectIntent reconnaît une demande de boîte de réception', () => {
  assert.equal(chatOrchestrator.detectIntent("quel est le dernier message que j'ai reçu et le numéro de l'expéditeur", null), 'inbox');
  assert.equal(chatOrchestrator.detectIntent('es-tu vraiment connecté à mon whatsapp ?', null), 'inbox');
  assert.equal(chatOrchestrator.detectIntent('montre moi mes messages reçus', null), 'inbox');
  // Ne doit PAS confondre avec un objectif de vente.
  assert.equal(chatOrchestrator.detectIntent('je veux vendre 10 formations', null), 'goal');
});

function mockDeps(readResult) {
  return {
    runtime: {
      actionExecutor: {
        execute: async (action, payload) => {
          assert.equal(action, 'READ_RECENT_MESSAGES');
          assert.ok(payload.channel);
          return { ok: true, result: readResult };
        },
      },
    },
  };
}

test('handle(inbox) cite un vrai dernier message + expéditeur', async () => {
  const res = await chatOrchestrator.handle(
    { text: 'quel est le dernier message reçu et le numéro de l\'expéditeur ?', history: [], tenantId: '__admin__', sessionId: 's1' },
    mockDeps({
      connected: true, connectedNumber: '22600000000',
      messages: [
        { from: '22611111111@s.whatsapp.net', number: '22611111111', name: 'Awa', text: 'Bonjour, la formation est encore dispo ?', hasMedia: false, isGroup: false, ts: 1789000000 },
        { from: '22622222222@s.whatsapp.net', number: '22622222222', name: null, text: 'Ok merci', hasMedia: false, isGroup: false, ts: 1788000000 },
      ],
    }),
  );
  assert.ok(res && res.text, 'réponse non vide');
  assert.ok(/Awa/.test(res.text), 'nom de l\'expéditeur présent');
  assert.ok(/22611111111/.test(res.text), 'numéro de l\'expéditeur présent');
  assert.ok(/formation est encore dispo/.test(res.text), 'contenu du message présent');
  assert.ok(/22600000000/.test(res.text), 'numéro connecté indiqué');
});

test('handle(inbox) : connecté mais tampon vide -> message honnête, jamais vide', async () => {
  const res = await chatOrchestrator.handle(
    { text: 'quel est le dernier message reçu ?', history: [], tenantId: '__admin__', sessionId: 's2' },
    mockDeps({ connected: true, connectedNumber: '22600000000', messages: [] }),
  );
  assert.ok(/connecté/i.test(res.text));
  assert.ok(/aucun message/i.test(res.text), 'explique honnêtement l\'absence de message bufferisé');
});

test('handle(inbox) : non connecté -> le dit clairement', async () => {
  const res = await chatOrchestrator.handle(
    { text: 'es-tu connecté à mon whatsapp ?', history: [], tenantId: '__admin__', sessionId: 's3' },
    mockDeps({ connected: false, connectedNumber: null, messages: [] }),
  );
  assert.ok(/pas connecté/i.test(res.text));
});

test('action READ_RECENT_MESSAGES route vers runtime.getRecentMessages', async () => {
  let called = null;
  const exec = actionExecutorMod.createActionExecutor({
    runtime: { getRecentMessages: async (p) => { called = p; return { ok: true, channel: p.channel, connected: true, messages: [{ from: 'x', text: 'hi' }] }; } },
  });
  const out = await exec.execute('READ_RECENT_MESSAGES', { channel: 'WHATSAPP', limit: 5 }, {});
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(called.channel, 'WHATSAPP');
  assert.equal(out.result.messages[0].text, 'hi');
});

test('action READ_RECENT_MESSAGES sans runtime -> RUNTIME_MISSING (jamais un crash)', async () => {
  const exec = actionExecutorMod.createActionExecutor({ runtime: {} });
  const out = await exec.execute('READ_RECENT_MESSAGES', { channel: 'WHATSAPP' }, {});
  assert.equal(out.ok, false);
  assert.equal(out.error, 'RUNTIME_MISSING:getRecentMessages');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
