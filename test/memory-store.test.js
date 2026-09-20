// TEST — Mémoire 7 jours refondue : stockage journalier, verrou d'écriture, idempotence, migration, purge exacte.
//   node --test test/memory-store.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-mem-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.SECRET_VAULT_KEY = 'test-vault-key-mem';

const mh = require('../ai-engine/messageHistory');
const storageAdapter = require('../ai-engine/storageAdapter');

const DAY = 86400000;
const nowSec = () => Math.floor(Date.now() / 1000);
let seq = 0;
const T = () => 'tMem' + (++seq);
const msg = (o) => Object.assign({ channel: 'WHATSAPP', direction: 'in', party: '22670000001@s.whatsapp.net', name: 'Awa', text: 'salut', ts: nowSec() }, o);

test('écritures simultanées : aucun message perdu (verrou par conversation)', async () => {
  const t = T();
  await Promise.all(Array.from({ length: 80 }, (_, i) => mh.record(t, msg({ text: 'm' + i, messageId: 'id' + i, ts: nowSec() - i }))));
  const all = await mh.getSince(t, 'WHATSAPP');
  assert.equal(all.length, 80);
  assert.equal(new Set(all.map((m) => m.text)).size, 80);
  const idx = await mh.listConversations(t, 'WHATSAPP');
  assert.equal(idx[0].messageCount, 80, 'index cohérent avec les messages');
});

test('plus de plafond de 2000 : un compte très actif garde toute la fenêtre 7 jours', async () => {
  const t = T();
  const jobs = [];
  for (let i = 0; i < 2600; i += 1) jobs.push(mh.record(t, msg({ text: 'x' + i, messageId: 'b' + i, ts: nowSec() - (i % 6) * 3600 - Math.floor(i / 6) })));
  await Promise.all(jobs);
  assert.equal((await mh.getSince(t, 'WHATSAPP')).length, 2600);
});

test('idempotence : même identifiant = un seul message (envoi + écho, import d\'historique)', async () => {
  const t = T();
  await mh.record(t, msg({ direction: 'out', messageId: 'W1', text: 'réponse' }));
  await mh.record(t, msg({ direction: 'out', messageId: 'W1', text: 'réponse', confirmationId: 'W1' }));
  await mh.record(t, msg({ direction: 'in', messageId: 'W1', text: 'autre sens' }));
  const all = await mh.getSince(t, 'WHATSAPP');
  assert.equal(all.length, 2, 'même id mais sens différent = messages distincts');
  assert.equal(all.find((m) => m.direction === 'out').confirmationId, 'W1', 'identifiant de confirmation complété');
  await mh.record(t, msg({ text: 'sans id', ts: 1000000000 + 5 }));
  await mh.record(t, msg({ text: 'sans id', ts: nowSec() - 5 }));
  await mh.record(t, msg({ text: 'sans id', ts: nowSec() - 5 }));
  assert.equal((await mh.getSince(t, 'WHATSAPP')).filter((m) => m.text === 'sans id').length, 1);
});

test('messages hors fenêtre : jamais stockés ; import antérieur rangé dans le bon jour', async () => {
  const t = T();
  assert.equal(await mh.record(t, msg({ text: 'trop vieux', ts: nowSec() - 8 * 86400 })), null);
  await mh.record(t, msg({ text: 'il y a 5 jours', ts: nowSec() - 5 * 86400, messageId: 'h1' }));
  await mh.record(t, msg({ text: 'maintenant', messageId: 'h2' }));
  const all = await mh.getSince(t, 'WHATSAPP');
  assert.deepEqual(all.map((m) => m.text), ['il y a 5 jours', 'maintenant'], 'ordre chronologique');
  const ids = storageAdapter.listIds('message_history').filter((i) => i.startsWith(t + '__'));
  assert.equal(ids.length, 2, 'un document par jour');
});

test('migration de l\'ancien format (un document par canal) sans perte dans la fenêtre', async () => {
  const t = T();
  const mk = (text, ageMs) => ({ channel: 'WHATSAPP', direction: 'in', party: '226700@c.us', number: '226700', name: 'X', text, tsMs: Date.now() - ageMs, ts: Math.floor((Date.now() - ageMs) / 1000), chatId: '226700@c.us', messageId: text });
  storageAdapter.set('message_history', `${t}__WHATSAPP`, { tenantId: t, channel: 'WHATSAPP', messages: [mk('vieux', 9 * DAY), mk('a', 3 * DAY), mk('b', DAY), mk('c', 1000)] });
  const all = await mh.getSince(t, 'WHATSAPP');
  assert.deepEqual(all.map((m) => m.text), ['a', 'b', 'c']);
  assert.ok(!storageAdapter.listIds('message_history').includes(`${t}__WHATSAPP`), 'ancien document supprimé');
});

test('purge exacte : jours périmés supprimés, jour-frontière filtré au message près', async () => {
  const t = T();
  await mh.record(t, msg({ text: 'récent', messageId: 'p1' }));
  const oldShard = `${t}__WHATSAPP__` + new Date(Date.now() - 9 * DAY).toISOString().slice(0, 10).replace(/-/g, '');
  storageAdapter.set('message_history', oldShard, { messages: [{ tsMs: Date.now() - 9 * DAY, text: 'périmé', direction: 'in', party: 'p' }] });
  const border = `${t}__WHATSAPP__` + new Date(Date.now() - 7 * DAY).toISOString().slice(0, 10).replace(/-/g, '');
  storageAdapter.set('message_history', border, { messages: [{ tsMs: Date.now() - 7 * DAY - 1000, text: 'juste avant', direction: 'in', party: 'p' }, { tsMs: Date.now() - 7 * DAY + 60000, text: 'juste après', direction: 'in', party: 'p' }] });
  const rep = await mh.cleanupExpired(t);
  assert.ok(rep.removedMessages >= 2);
  assert.ok(!storageAdapter.listIds('message_history').includes(oldShard), 'jour périmé supprimé');
  const texts = (await mh.getSince(t, 'WHATSAPP')).map((m) => m.text);
  assert.ok(texts.includes('juste après') && !texts.includes('juste avant') && !texts.includes('périmé'));
});

test('getConversation / index restent cohérents après refonte', async () => {
  const t = T();
  await mh.record(t, msg({ text: 'q1', party: '22671@s.whatsapp.net', messageId: 'c1' }));
  await mh.record(t, msg({ text: 'r1', direction: 'out', party: '22671@s.whatsapp.net', messageId: 'c2' }));
  const conv = await mh.getConversation(t, 'WHATSAPP', '22671', 10);
  assert.deepEqual(conv.map((m) => m.text), ['q1', 'r1']);
  assert.equal((await mh.findConversations(t, { query: 'awa' })).length, 1);
});
