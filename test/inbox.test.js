// TEST RUNNER — lecture de la boîte de réception par la couche intelligence.
//   node --test test/inbox.test.js
// Isolé : stockage redirigé, notification admin moquée, runtime moqué — aucun
// appel réseau, aucune session WhatsApp/Telegram réelle.

'use strict';

require('./helpers/auth').actAsAdmin(); // identité authentifiée de test (deny-by-default : voir ai-engine/authz.js)
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

test('handle(inbox) : non appairé -> le dit clairement (QR à scanner)', async () => {
  const res = await chatOrchestrator.handle(
    { text: 'es-tu connecté à mon whatsapp ?', history: [], tenantId: '__admin__', sessionId: 's3' },
    mockDeps({ connected: false, paired: false, connectedNumber: null, messages: [] }),
  );
  assert.ok(/pas connecté/i.test(res.text));
  assert.ok(/appair/i.test(res.text), 'invite à appairer');
});

test('handle(inbox) : appairé mais reconnexion en cours -> ne dit PAS "pas connecté à sec"', async () => {
  const res = await chatOrchestrator.handle(
    { text: 'quel est le dernier message reçu ?', history: [], tenantId: 'KEY-123', sessionId: 's4' },
    mockDeps({ connected: false, paired: true, connectedNumber: '22664977093', messages: [] }),
  );
  assert.ok(/appair/i.test(res.text), 'reconnaît que le compte est appairé');
  assert.ok(/22664977093/.test(res.text), 'donne le numéro même hors-ligne');
  assert.ok(/reconnex|rétablit|r[ée]essaie/i.test(res.text), 'explique la reconnexion en cours');
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

test('detectIntent reconnaît une demande sur les groupes', () => {
  assert.equal(chatOrchestrator.detectIntent('quels sont mes groupes ?', null), 'groups');
  assert.equal(chatOrchestrator.detectIntent('liste mes groupes où je suis admin', null), 'groups');
  assert.equal(chatOrchestrator.detectIntent('combien de groupes j\'ai sur telegram', null), 'groups');
});

function mockGroupsDeps(listResult) {
  return {
    runtime: {
      actionExecutor: {
        execute: async (action) => {
          assert.equal(action, 'LIST_GROUPS');
          return { ok: true, result: listResult };
        },
      },
    },
  };
}

test('handle(groups) liste et filtre les groupes admin', async () => {
  const groups = [
    { id: 'g1@g.us', name: 'Clients VIP', size: 120, isAdmin: true },
    { id: 'g2@g.us', name: 'Discussion libre', size: 40, isAdmin: false },
    { id: 'g3@g.us', name: 'Formation Cuisine', size: 88, isAdmin: true },
  ];
  const all = await chatOrchestrator.handle(
    { text: 'quels sont mes groupes ?', history: [], tenantId: '__admin__', sessionId: 'g-a' },
    mockGroupsDeps({ connected: true, paired: true, groups }),
  );
  assert.ok(/Clients VIP/.test(all.text) && /Discussion libre/.test(all.text), 'liste tous les groupes');

  const adminOnly = await chatOrchestrator.handle(
    { text: 'mes groupes où je suis admin', history: [], tenantId: '__admin__', sessionId: 'g-b' },
    mockGroupsDeps({ connected: true, paired: true, groups }),
  );
  assert.ok(/Clients VIP/.test(adminOnly.text) && /Formation Cuisine/.test(adminOnly.text), 'garde les groupes admin');
  assert.ok(!/Discussion libre/.test(adminOnly.text), 'exclut les groupes non-admin');
});

test('handle(groups) : appairé mais déconnecté -> statut honnête', async () => {
  const res = await chatOrchestrator.handle(
    { text: 'mes groupes whatsapp', history: [], tenantId: 'KEY-1', sessionId: 'g-c' },
    mockGroupsDeps({ connected: false, paired: true, groups: [] }),
  );
  assert.ok(/appair/i.test(res.text) && /reconnex|rétablit|réessaie/i.test(res.text));
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
