// TEST — auto-présentation à la première personne, FIABLE sur les 4 interfaces (Self WhatsApp, Self Telegram, Chat intelligent, Web générique) :
// même moteur (chatOrchestrator → handleSelfKnow → cyrusSelf), jamais « Cyrus est/peut/permet ».
//   node --test test/self-presentation-channels.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-self4-'));
process.env.GITHUB_TOKEN = ''; process.env.GEMINI_API_KEY = 'test-key';
require('./helpers/auth').actAsAdmin();
const orch = require('../ai-engine/chatOrchestrator');
const cyrusSelf = require('../ai-engine/cyrusSelf');
const ownerChannel = require('../ai-engine/ownerChannel');
const { ownerOf } = require('./helpers/auth');

test('Chat intelligent (site/API) : « Présente-toi » = première personne, jamais « Cyrus est/peut »', async () => {
  const P = ownerOf('sp1');
  const r = await orch.handle({ text: 'Présente-toi', history: [], tenantId: 'sp1', sessionId: 's', principal: P }, {});
  assert.equal(r.intent, 'selfknow'); assert.ok(cyrusSelf.isFirstPerson(r.text)); assert.match(r.text, /^Pour mieux vous aider|Je suis Cyrus/);
});

test('Self WHATSAPP : « Qui es-tu ? » routé par le canal propriétaire, première personne, jamais un modèle/clé exposé', async () => {
  const sent = [];
  const adapter = ownerChannel.ADAPTERS.WHATSAPP; const orig = { reply: adapter.reply, isOwnerContext: adapter.isOwnerContext };
  adapter.reply = async (t, s, m, text) => { sent.push(text); }; adapter.isOwnerContext = () => true;
  try {
    const out = await ownerChannel.handleOwnerMessage({ tenantId: 'sp2', session: { isConnected: () => true }, msg: { key: { id: 'W1', remoteJid: '22670000000@s.whatsapp.net', fromMe: true }, message: { conversation: 'Qui es-tu ?' } }, channel: 'WHATSAPP' }, {
      getSettings: async () => ({}), chat: ({ text, tenantId, history, principal }) => orch.handle({ text, tenantId, history, sessionId: 'owner-whatsapp', principal }, {}),
    });
    assert.equal(out.handled, 'CHAT'); assert.equal(sent.length, 1); assert.ok(cyrusSelf.isFirstPerson(sent[0])); assert.doesNotMatch(sent[0], /gemma|gemini|groq|AIza|sk-[A-Za-z0-9]{10}/i);
  } finally { adapter.reply = orig.reply; adapter.isOwnerContext = orig.isOwnerContext; }
});

test('Self TELEGRAM : même canal générique (ownerChannel.ADAPTERS.TELEGRAM), première personne', async () => {
  const sent = [];
  const adapter = ownerChannel.ADAPTERS.TELEGRAM; const orig = { reply: adapter.reply, isOwnerContext: adapter.isOwnerContext };
  adapter.reply = async (t, s, m, text) => { sent.push(text); }; adapter.isOwnerContext = () => true;
  try {
    const out = await ownerChannel.handleOwnerMessage({ tenantId: 'sp3', session: {}, msg: { id: 'T1', chatId: '999', message: 'Présente-toi' }, channel: 'TELEGRAM' }, {
      getSettings: async () => ({}), chat: ({ text, tenantId, history, principal }) => orch.handle({ text, tenantId, history, sessionId: 'owner-telegram', principal }, {}),
    });
    assert.equal(out.handled, 'CHAT'); assert.equal(sent.length, 1); assert.ok(cyrusSelf.isFirstPerson(sent[0]));
  } finally { adapter.reply = orig.reply; adapter.isOwnerContext = orig.isOwnerContext; }
});

test('Présentation adaptée à l\'activité déclarée (§5) : commerçant de vêtements → capacités concrètes pour le commerce, jamais inventées', async () => {
  const r = await cyrusSelf.introduce('sp4', { activity: 'Je suis commerçant et je vends des vêtements' });
  assert.equal(r.known, true); assert.equal(r.sector, 'commerce'); assert.ok(cyrusSelf.isFirstPerson(r.text));
  for (const part of ['Votre besoin', 'Ce que je peux faire', 'Exemple', 'Bénéfice', 'Prochaine étape']) assert.match(r.text, new RegExp(part));
});
