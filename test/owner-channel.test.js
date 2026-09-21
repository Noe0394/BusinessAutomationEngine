// TEST RUNNER — canal propriétaire (self-chat -> Chat Intelligent), anti-boucle, isolation, file d'attente.
//   node --test test/owner-channel.test.js
'use strict';
require('./helpers/auth').actAsAdmin(); // identité authentifiée de test (deny-by-default : voir ai-engine/authz.js)
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-owner-'));
const platformOrchestrator = require('../ai-engine/platformOrchestrator');
platformOrchestrator.notifyTenantChat = async () => {};
const owner = require('../ai-engine/ownerChannel');
const alertCenter = require('../ai-engine/alertCenter');
const router = require('../ai-engine/conversationRouter');
const contactIdentity = require('../ai-engine/contactIdentity');
const chatOrchestrator = require('../ai-engine/chatOrchestrator');
const mpv = require('../ai-engine/manualPaymentValidator');
const storage = require('../ai-engine/storageAdapter');

const SELF = '22670000000@s.whatsapp.net';
function fakeSession() {
  const sent = [];
  return {
    sent,
    isSelfChatJid: (j) => String(j).split(':')[0] === SELF || String(j) === '777000111222333@lid',
    getSelfIds: () => ({ pn: SELF, lid: '777000111222333@lid' }),
    isConnected: () => true,
    sendMessage: async (to, text) => { sent.push({ to, text }); return { key: { id: 'OUT' + sent.length } }; },
  };
}
let seq = 0;
const ownerMsg = (text, remoteJid, extra) => ({ key: { remoteJid: remoteJid || SELF, fromMe: true, id: 'OM' + (++seq) }, message: Object.assign({ conversation: text }, extra || {}) });

async function enable(t) { await storage.set('auto_settings', t, { tenant: t, whatsapp: true }); }
const getSettings = (t) => storage.get('auto_settings', t, {});

test('TEST 7 : message du propriétaire dans son self-chat -> Chat Intelligent -> réponse dans le MÊME self-chat', async () => {
  const t = 'o1'; await enable(t);
  const s = fakeSession();
  const seen = [];
  const out = await owner.handleOwnerMessage({ tenantId: t, session: s, msg: ownerMsg('Donne-moi le rapport des ventes') }, {
    getSettings, chat: async ({ text }) => { seen.push(text); return { text: 'Voici le rapport : 3 ventes.' }; },
  });
  assert.equal(out.handled, 'CHAT');
  assert.deepEqual(seen, ['Donne-moi le rapport des ventes']);
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].to, SELF, 'réponse dans le même self-chat');
  assert.match(s.sent[0].text, /3 ventes/);
  assert.ok(s.sent[0].text.endsWith(owner.MARK), 'message Cyrus signé techniquement');
});

test('isolation : un message hors self-chat n\'atteint JAMAIS le Chat Intelligent (client/contact)', async () => {
  const t = 'o2'; await enable(t);
  const s = fakeSession();
  let called = 0;
  const out = await owner.handleOwnerMessage({ tenantId: t, session: s, msg: ownerMsg('Mets la campagne en pause', '22670999999@s.whatsapp.net') }, { getSettings, chat: async () => { called++; return { text: 'ok' }; } });
  assert.equal(out.ignored, 'NOT_OWNER');
  assert.equal(called, 0);
  assert.equal(s.sent.length, 0);
});

test('un numéro propriétaire configuré est reconnu ; un LID ne l\'est jamais', () => {
  const settings = { ownerNumbers: ['+226 70 12 34 56'] };
  assert.equal(owner.isConfiguredOwner(settings, contactIdentity.resolveIdentity({ jid: '22670123456@s.whatsapp.net' })), true);
  assert.equal(owner.isConfiguredOwner(settings, contactIdentity.resolveIdentity({ jid: '22670123456@lid' })), false);
  assert.equal(owner.isConfiguredOwner({}, contactIdentity.resolveIdentity({ jid: '22670123456@s.whatsapp.net' })), false);
});

test('anti-boucle : message généré par Cyrus (marqueur), écho, doublon, canal désactivé', async () => {
  const t = 'o3'; await enable(t);
  const s = fakeSession();
  let called = 0;
  const deps = { getSettings, chat: async () => { called++; return { text: 'réponse' }; } };
  const a = await owner.handleOwnerMessage({ tenantId: t, session: s, msg: ownerMsg('🔔 alerte' + owner.MARK) }, deps);
  assert.equal(a.ignored, 'CYRUS_GENERATED');
  const m = ownerMsg('bonjour');
  await owner.handleOwnerMessage({ tenantId: t, session: s, msg: m }, deps);
  const dup = await owner.handleOwnerMessage({ tenantId: t, session: s, msg: m }, deps);
  assert.equal(dup.ignored, 'DUPLICATE');
  // écho : le texte que Cyrus vient d'envoyer revient sans marqueur (canal qui le retire)
  const echo = await owner.handleOwnerMessage({ tenantId: t, session: s, msg: ownerMsg('réponse') }, deps);
  assert.equal(echo.ignored, 'ECHO_OF_CYRUS');
  assert.equal(called, 1);
  await storage.set('auto_settings', 'o3b', { tenant: 'o3b', whatsapp: true, ownerChannel: false });
  const off = await owner.handleOwnerMessage({ tenantId: 'o3b', session: s, msg: ownerMsg('salut') }, deps);
  assert.equal(off.ignored, 'OWNER_CHANNEL_DISABLED');
});

test('anti-boucle : plafond de messages par minute (aucune réponse au-delà)', async () => {
  const t = 'o4'; await enable(t);
  const s = fakeSession();
  const deps = { getSettings, chat: async ({ text }) => ({ text: 'r:' + text }) };
  let ignored = 0;
  for (let i = 0; i < 26; i++) { const r = await owner.handleOwnerMessage({ tenantId: t, session: s, msg: ownerMsg('m' + i) }, deps); if (r.ignored === 'RATE_LIMITED') ignored++; }
  assert.ok(ignored >= 5, 'plafond atteint : ' + ignored);
  assert.ok(s.sent.length <= 20);
});

test('TEST 10 (via canal propriétaire) : OUI relié à l\'action précise, réponse dans le self-chat', async () => {
  const t = 'o5'; await enable(t);
  const notes = [];
  alertCenter.setDeliverers([async (tenant, text) => { notes.push(text); return { ok: true, channel: 't', messageId: 'W1' }; }]);
  const idn = await contactIdentity.resolveContact(t, { jid: '22670123456@s.whatsapp.net', pushName: 'Marie' });
  const p = await mpv.registerProof({ tenantId: t, channel: 'WHATSAPP', from: '22670123456@s.whatsapp.net', text: 'Voici mon reçu email: marie@mail.com', hasAttachment: true, courseId: 'cuisine', proofMessageId: 'PMX', identity: idn });
  const calls = [];
  const http = async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true, uid: 'u', course_id: 'cuisine', account_created: true, password_reset_link: 'https://r.example/1' }) }; };
  const clientMsgs = [];
  const s = fakeSession();
  const deps = { getSettings, chat: async () => { throw new Error('ne doit pas passer par le chat'); }, paymentDeps: () => ({ deliverToClient: async (m) => { clientMsgs.push(m); }, executeOptions: { env: { CYRUS_PLATFORM_API_KEY: 'k' }, http } }) };

  // réponse ambiguë : rien n'est exécuté
  const amb = await owner.handleOwnerMessage({ tenantId: t, session: s, msg: ownerMsg('ok') }, deps);
  assert.equal(amb.handled, 'AMBIGUOUS_DECISION');
  assert.equal(calls.length, 0);
  assert.match(s.sent[0].text, /Je n'ai rien exécuté/);

  const yes = await owner.handleOwnerMessage({ tenantId: t, session: s, msg: ownerMsg('OUI') }, deps);
  assert.equal(yes.handled, 'DECISION');
  assert.equal(yes.kind, 'approved');
  assert.equal(yes.pendingActionId, p.pendingActionId);
  assert.equal(calls.length, 1);
  assert.equal(clientMsgs.length, 1);
  assert.equal(s.sent[1].to, SELF);
  assert.match(s.sent[1].text, /confirmé par l'API/);
});

test('reprise de conversation demandée par le propriétaire', async () => {
  const t = 'o6'; await enable(t);
  alertCenter.setDeliverers([async () => ({ ok: true, channel: 't' })]);
  const from = '22670555777@s.whatsapp.net';
  const identity = await contactIdentity.resolveContact(t, { jid: from, pushName: 'Jean Dupont' });
  await router.processBatch({ tenantId: t, channel: 'WHATSAPP', from, identity, items: [{ text: 'Tu es où ?', messageId: 'Q1' }] }, { send: async () => ({ status: 'SUCCESS' }) });
  assert.equal((await router.listAwaitingOwner(t)).length, 1);
  const s = fakeSession();
  const take = await owner.handleOwnerMessage({ tenantId: t, session: s, msg: ownerMsg('Je prends la main sur la conversation avec Jean') }, { getSettings });
  assert.equal(take.handled, 'CONTROL');
  assert.equal((await router.getHandoff(t, 'WHATSAPP', from)).state, 'HUMAN_ACTIVE');
  const resume = await owner.handleOwnerMessage({ tenantId: t, session: s, msg: ownerMsg('Reprends la conversation avec Jean') }, { getSettings });
  assert.equal(resume.handled, 'CONTROL');
  assert.equal((await router.getHandoff(t, 'WHATSAPP', from)).state, 'AI_RESUMED');
  assert.match(s.sent[1].text, /je reprends la conversation avec Jean Dupont/i);
});

test('livreur WhatsApp : envoie dans le self-chat si la session est active, sinon échec (repli possible)', async () => {
  const t = 'o7'; await enable(t);
  const s = fakeSession();
  const del = owner.whatsappDeliverer({ peek: (id) => (id === t ? { session: s } : null), getSettings });
  const ok = await del(t, '🔔 Jean vient de t\'écrire');
  assert.equal(ok.ok, true);
  assert.equal(s.sent[0].to, SELF);
  assert.equal(ok.messageId, 'OUT1');
  const none = await del('autre', 'x');
  assert.equal(none.ok, false);
  assert.equal(none.error, 'SESSION_INACTIVE');
});

test('TEST 8/9 : « qui m\'a écrit », conversations à traiter, paiements en attente — états réels', async () => {
  const t = 'o8';
  for (const q of ['Donne-moi les conversations qui nécessitent mon intervention.', 'Montre-moi les personnes qui attendent ma réponse.', 'Donne-moi les paiements en attente.', "Est-ce que j'ai reçu un message important ?"]) {
    assert.equal(chatOrchestrator.detectIntent(q, null), 'ownerqueue', q);
  }
  assert.equal(chatOrchestrator.detectIntent("Qui m'a écrit aujourd'hui ?", null), 'memory');
  assert.equal(chatOrchestrator.detectIntent('crée un lien de paiement pour ma formation', null) === 'ownerqueue', false);

  alertCenter.setDeliverers([async () => ({ ok: true, channel: 't' })]);
  const send = async () => ({ status: 'SUCCESS' });
  const a = await contactIdentity.resolveContact(t, { jid: '22670101010@s.whatsapp.net', pushName: 'Awa Traoré' });
  await router.processBatch({ tenantId: t, channel: 'WHATSAPP', from: '22670101010@s.whatsapp.net', identity: a, items: [{ text: 'Est-ce que tu peux me rappeler ?', messageId: 'A1' }] }, { send });
  const b = await contactIdentity.resolveContact(t, { jid: '888777666555444@lid' });
  await router.processBatch({ tenantId: t, channel: 'WHATSAPP', from: '888777666555444@lid', identity: b, items: [{ text: 'Tu es où ?', messageId: 'B1' }] }, { send });
  await mpv.registerProof({ tenantId: t, channel: 'WHATSAPP', from: '22670202020@s.whatsapp.net', text: 'Voici mon reçu 2000 FCFA email: k@mail.com', hasAttachment: true, courseId: 'c1', proofMessageId: 'P1', identity: await contactIdentity.resolveContact(t, { jid: '22670202020@s.whatsapp.net', pushName: 'Kofi' }) });

  const convs = await chatOrchestrator.handleOwnerQueue('Donne-moi les conversations qui nécessitent mon intervention.', t);
  assert.match(convs.text, /2 conversation\(s\) attendent/);
  assert.match(convs.text, /Awa Traoré/);
  assert.match(convs.text, /Contact WhatsApp non identifié/);
  assert.ok(!/888777666555444|@lid/.test(convs.text), 'aucun identifiant technique');
  const pays = await chatOrchestrator.handleOwnerQueue('Donne-moi les paiements en attente.', t);
  assert.match(pays.text, /1 paiement\(s\) à valider/);
  assert.match(pays.text, /Kofi/);
  assert.match(pays.text, /PA-/);
  const nothing = await chatOrchestrator.handleOwnerQueue('Donne-moi les paiements en attente.', 'o8-vide');
  assert.match(nothing.text, /Aucun paiement/);
});
