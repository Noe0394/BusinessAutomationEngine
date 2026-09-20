// TEST — Questions du Chat Intelligent sur la mémoire 7 jours : périodes, contacts, sujets, étendue réelle.
//   node --test test/memory-query.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-mq-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.SECRET_VAULT_KEY = 'test-vault-key-mq';

const mh = require('../ai-engine/messageHistory');
const mq = require('../ai-engine/memoryQuery');
const chatOrchestrator = require('../ai-engine/chatOrchestrator');

const T = 'tMq';
const DAY = 86400000;
const NOW = Date.now();
const sec = (ms) => Math.floor(ms / 1000);
const AWA = '22670000001@s.whatsapp.net';
const KOFFI = '22670000002@s.whatsapp.net';
const PAUL = '22670000003@s.whatsapp.net';

test('périodes exactes : hier, avant-hier, aujourd\'hui, il y a N jours', () => {
  const y = mq.parsePeriod('ce qu\'Awa a dit hier', NOW);
  assert.equal(y.label, 'hier');
  assert.equal(y.from, mq.localMidnight(NOW, 1));
  assert.equal(y.to, mq.localMidnight(NOW, 0) - 1);
  const ay = mq.parsePeriod('les discussions d\'avant-hier', NOW);
  assert.equal(ay.label, 'avant-hier');
  assert.equal(ay.to, mq.localMidnight(NOW, 1) - 1);
  assert.equal(mq.parsePeriod('aujourd\'hui', NOW).from, mq.localMidnight(NOW, 0));
  assert.equal(mq.parsePeriod('il y a 3 jours', NOW).label, 'il y a 3 jours');
  assert.equal(mq.parsePeriod('cette semaine', NOW).label, 'les 7 derniers jours');
});

test('cibles et sujets', () => {
  assert.deepEqual(mq.parseTarget('Retrouve ma dernière discussion avec Koffi Traoré'), { name: 'Koffi Traoré' });
  assert.deepEqual(mq.parseTarget('Qu\'est-ce qu\'Awa m\'a dit hier ?'), { name: 'Awa' });
  assert.deepEqual(mq.parseTarget('discussion avec +226 70 00 00 01'), { phone: '22670000001' });
  assert.ok(mq.parseTopic('Qui a parlé de la formation cette semaine ?').words.includes('formation'));
  assert.ok(mq.parseTopic('combien de personnes ont demandé le prix aujourd\'hui').words.includes('prix'));
});

test('détection de question mémoire (et non des autres intentions)', () => {
  for (const q of ['Retrouve ma dernière discussion avec Awa', 'Qu\'est-ce que ce client m\'a dit hier ?', 'Qui a parlé de la formation cette semaine ?', 'Donne-moi les 10 dernières discussions d\'avant-hier', 'Fais-moi un résumé de la conversation avec Awa', 'Combien de personnes ont demandé le prix aujourd\'hui ?']) {
    assert.equal(chatOrchestrator.detectIntent(q), 'memory', q);
  }
  assert.notEqual(chatOrchestrator.detectIntent('Crée une campagne pour la formation'), 'memory');
});

test('setup : messages sur plusieurs jours, deux canaux', async () => {
  const rec = (o) => mh.record(T, Object.assign({ channel: 'WHATSAPP', direction: 'in' }, o));
  await rec({ party: AWA, name: 'Awa', text: 'Bonjour, quel est le prix de la formation ?', ts: sec(mh_h(NOW, 26)), messageId: 'a1' });
  await rec({ party: AWA, direction: 'out', text: 'La formation est à 8000 FCFA.', ts: sec(mh_h(NOW, 25.9)), messageId: 'a2' });
  await rec({ party: AWA, name: 'Awa', text: 'Merci, je vais réfléchir', ts: sec(mh_h(NOW, 25.8)), messageId: 'a3' });
  await rec({ party: KOFFI, name: 'Koffi Traoré', text: 'Je veux m\'inscrire à la formation', ts: sec(mh_h(NOW, 50)), messageId: 'k1' });
  await rec({ party: PAUL, name: 'Paul', text: 'C\'est combien le prix ?', ts: sec(mh_h(NOW, 1)), messageId: 'p1' });
  await rec({ party: '-100777', name: 'Marie', channel: 'TELEGRAM', text: 'Bonjour, prix du coaching ?', ts: sec(mh_h(NOW, 2)), messageId: 't1', chatId: '-100777' });
});
function mh_h(now, hoursAgo) { return now - hoursAgo * 3600 * 1000; }

test('dernière discussion avec un contact : faits réels + étendue de la mémoire', async () => {
  const out = await mq.answer(T, 'Retrouve ma dernière discussion avec Awa', { now: NOW });
  assert.match(out.text, /Awa/);
  assert.match(out.text, /quel est le prix de la formation/);
  assert.match(out.text, /Moi : La formation est à 8000 FCFA/);
  assert.match(out.text, /Mémoire disponible : 6 messages, 4 discussions/);
});

test('ce que dit un contact hier : résumé IA fondé sur l\'extrait, repli déterministe si l\'IA échoue', async () => {
  const prompts = [];
  const withLlm = await mq.answer(T, 'Qu\'est-ce qu\'Awa m\'a dit hier ?', { now: NOW, llm: async (p) => { prompts.push(p); return 'Awa demandait le prix et va réfléchir.'; } });
  assert.match(withLlm.text, /Awa demandait le prix/);
  assert.ok(prompts[0].includes('quel est le prix de la formation'), 'le résumé reçoit les vrais messages');
  assert.ok(prompts[0].includes('N\'ajoute aucun fait absent'), 'consigne anti-invention');
  const noLlm = await mq.answer(T, 'Qu\'est-ce qu\'Awa m\'a dit hier ?', { now: NOW, llm: async () => { throw new Error('IA indisponible'); } });
  assert.match(noLlm.text, /Merci, je vais réfléchir/, 'repli : extrait réel affiché');
});

test('qui a parlé d\'un sujet / combien ont demandé : décomptes réels', async () => {
  const who = await mq.answer(T, 'Qui a parlé de la formation cette semaine ?', { now: NOW });
  assert.match(who.text, /Awa/); assert.match(who.text, /Koffi Traoré/);
  assert.doesNotMatch(who.text, /Paul/, 'Paul n\'a pas parlé de formation');
  const count = await mq.answer(T, 'Combien de personnes ont demandé le prix aujourd\'hui ?', { now: NOW });
  assert.equal(count.data.count, 2, 'Paul (WhatsApp) et Marie (Telegram) ; Awa était hier');
  assert.match(count.text, /2 discussion/);
});

test('liste des dernières discussions d\'une journée et canal ciblé', async () => {
  const list = await mq.answer(T, 'Donne-moi les 5 dernières discussions d\'avant-hier', { now: NOW });
  assert.ok(list.data.count >= 0);
  const tg = await mq.answer(T, 'Liste mes discussions Telegram de la semaine', { now: NOW });
  assert.match(tg.text, /-100777/);
  assert.doesNotMatch(tg.text, /Awa/);
});

test('contact introuvable et période avant le début de la mémoire : dit la vérité', async () => {
  const none = await mq.answer(T, 'Retrouve ma dernière discussion avec Zoé', { now: NOW });
  assert.match(none.text, /aucune discussion avec « Zoé »/);
  assert.match(none.text, /Discussions récentes/);
  const old = await mq.answer(T, 'Qui a écrit il y a 6 jours ?', { now: NOW });
  assert.match(old.text, /rien n'est enregistré avant le|Aucun/);
});

test('mémoire vide : aucune invention', async () => {
  const out = await mq.answer('tVide', 'Retrouve ma dernière discussion avec Awa', { now: NOW });
  assert.match(out.text, /aucun message en mémoire/);
});

test('bout en bout par le Chat Intelligent : handle() route vers la mémoire', async () => {
  const out = await chatOrchestrator.handle({ text: 'Retrouve ma dernière discussion avec Koffi', history: [], tenantId: T, sessionId: 's' }, { llm: async () => 'Résumé.' });
  assert.match(out.text, /Koffi Traoré/);
  assert.match(out.text, /m'inscrire à la formation/);
});
