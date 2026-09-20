// TEST RUNNER — centre d'alertes + actions en attente.
//   node --test test/alert-center.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-alert-'));
const alertCenter = require('../ai-engine/alertCenter');
const pendingActions = require('../ai-engine/pendingActions');
const storageAdapter = require('../ai-engine/storageAdapter');

function capture() {
  const sent = [];
  alertCenter.setDeliverers([async (tenant, text) => { sent.push({ tenant, text }); return { ok: true, channel: 'test', messageId: 'M' + sent.length }; }]);
  return sent;
}

test('politique par défaut : INFO/ATTENTION enregistrés seulement, IMPORTANT+ envoyés', async () => {
  const sent = capture();
  const a = await alertCenter.raise('t1', { type: 'PRIVATE_CASUAL', title: 'Salut de Jean' });
  assert.equal(a.delivered, false);
  assert.equal(a.reason, 'POLICY_STORED_ONLY');
  const b = await alertCenter.raise('t1', { type: 'PRIVATE_SENSITIVE', title: 'Jean a écrit', body: 'Message : “Ta maman est là ?”' });
  assert.equal(b.delivered, true);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /Jean a écrit/);
  const stored = await alertCenter.list('t1');
  assert.equal(stored.length, 2);
});

test('idempotence : même idempotencyKey = une seule alerte et une seule notification', async () => {
  const sent = capture();
  const k = 'msg:ABC123';
  const a = await alertCenter.raise('t2', { type: 'URGENT_MESSAGE', title: 'Urgent', idempotencyKey: k });
  const b = await alertCenter.raise('t2', { type: 'URGENT_MESSAGE', title: 'Urgent', idempotencyKey: k });
  assert.equal(a.delivered, true);
  assert.equal(b.duplicate, true);
  assert.equal(sent.length, 1);
});

test('agrégation : 5 messages consécutifs = 1 notification immédiate + 1 récapitulatif', async () => {
  const sent = capture();
  await storageAdapter.set('auto_settings', 't3', { tenant: 't3', alertPolicy: { aggregateWindowMs: 1200 } });
  const raiseMsg = (n) => alertCenter.raise('t3', {
    type: 'HUMAN_INTERVENTION_REQUIRED', title: 'Jean Dupont vient de t’écrire', body: `msg ${n}`, lastBody: `msg ${n}`,
    groupKey: 'msg:jean', aggregateTitle: (c) => `Jean Dupont vient d’envoyer ${c + 1} messages`,
  });
  const r = [];
  for (let i = 1; i <= 5; i++) r.push(await raiseMsg(i));
  assert.equal(r[0].delivered, true);
  assert.ok(r.slice(1).every((x) => x.aggregated === true));
  assert.equal(sent.length, 1, 'une seule notification immédiate');
  await new Promise((res) => setTimeout(res, 1500));
  assert.equal(sent.length, 2, 'un récapitulatif à la fin de la fenêtre');
  assert.match(sent[1].text, /5 messages/);
  assert.match(sent[1].text, /Dernier message : “msg 5”/);
  const stored = await alertCenter.list('t3');
  assert.equal(stored.length, 1);
  assert.equal(stored[0].count, 5);
});

test('aucun identifiant technique ne part dans une notification', async () => {
  const sent = capture();
  await alertCenter.raise('t4', { type: 'PRIVATE_SENSITIVE', title: 'Message de 218374650128374@lid', body: '22670123456@s.whatsapp.net' });
  assert.ok(!/@lid|@s\.whatsapp\.net/.test(sent[0].text));
});

test('repli : le premier deliverer en échec laisse la main au suivant', async () => {
  const sent = [];
  alertCenter.setDeliverers([
    async () => ({ ok: false, channel: 'whatsapp', error: 'non connecté' }),
    async (tenant, text) => { sent.push(text); return { ok: true, channel: 'studio_chat' }; },
  ]);
  const r = await alertCenter.raise('t5', { type: 'CAMPAIGN_BLOCKED', title: 'Campagne bloquée' });
  assert.equal(r.delivered, true);
  assert.equal(r.channel, 'studio_chat');
  assert.equal(sent.length, 1);
});

test('pendingActions : création idempotente, résolution ciblée, jamais « la dernière »', async () => {
  const a = await pendingActions.create('p1', { type: 'PAYMENT', summary: 'Paiement Marie', idempotencyKey: 'pay:1' });
  const a2 = await pendingActions.create('p1', { type: 'PAYMENT', summary: 'Paiement Marie', idempotencyKey: 'pay:1' });
  assert.equal(a.created, true);
  assert.equal(a2.created, false);
  assert.equal(a.action.pendingActionId, a2.action.pendingActionId);
  // une seule action ouverte : « OUI » sans identifiant vise celle-là
  const one = await pendingActions.resolveTarget('p1', {});
  assert.equal(one.action.pendingActionId, a.action.pendingActionId);
  // deux actions ouvertes : ambigu, aucune action choisie
  const b = await pendingActions.create('p1', { type: 'PAYMENT', summary: 'Paiement Paul', idempotencyKey: 'pay:2' });
  const amb = await pendingActions.resolveTarget('p1', {});
  assert.equal(amb.ambiguous, true);
  assert.equal(amb.action, undefined);
  // identifiant cité
  const cited = await pendingActions.resolveTarget('p1', { pendingActionId: b.action.pendingActionId.toLowerCase() });
  assert.equal(cited.action.pendingActionId, b.action.pendingActionId);
  // message notifié cité en réponse
  await pendingActions.patch('p1', a.action.pendingActionId, { notification: { messageId: 'WAID1', at: Date.now() } });
  const quoted = await pendingActions.resolveTarget('p1', { quotedMessageId: 'WAID1' });
  assert.equal(quoted.action.pendingActionId, a.action.pendingActionId);
});

test('pendingActions : un seul exécutant (APPROVED puis EXECUTING atomiques), pas de double exécution', async () => {
  const { action } = await pendingActions.create('p2', { type: 'PAYMENT', idempotencyKey: 'pay:x' });
  const id = action.pendingActionId;
  const [r1, r2] = await Promise.all([
    pendingActions.transition('p2', id, 'PENDING', 'APPROVED'),
    pendingActions.transition('p2', id, 'PENDING', 'APPROVED'),
  ]);
  assert.equal([r1, r2].filter((r) => r.ok).length, 1);
  const rej = await pendingActions.transition('p2', id, 'PENDING', 'REJECTED');
  assert.equal(rej.ok, false);
});

test('pendingActions : expiration', async () => {
  const { action } = await pendingActions.create('p3', { type: 'PAYMENT', ttlMs: 1 });
  await new Promise((res) => setTimeout(res, 15));
  const open = await pendingActions.listOpen('p3');
  assert.equal(open.length, 0);
  const a = await pendingActions.get('p3', action.pendingActionId);
  assert.equal(a.status, 'EXPIRED');
});
