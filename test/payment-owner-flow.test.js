// TEST RUNNER — paiements : pendingActionId, OUI/NON du propriétaire, EXECUTE -> VERIFY, idempotence.
//   node --test test/payment-owner-flow.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-pay-'));
const platformOrchestrator = require('../ai-engine/platformOrchestrator');
platformOrchestrator.notifyTenantChat = async () => {};
const alertCenter = require('../ai-engine/alertCenter');
const pendingActions = require('../ai-engine/pendingActions');
const mpv = require('../ai-engine/manualPaymentValidator');
const contactIdentity = require('../ai-engine/contactIdentity');

const notes = [];
alertCenter.setDeliverers([async (tenant, text, alert) => { notes.push({ tenant, text, alert }); return { ok: true, channel: 'test', messageId: 'WA' + notes.length }; }]);

function apiMock(responses) {
  const calls = [];
  const http = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    const r = responses.shift() || { status: 200, body: { ok: true, uid: 'u1', email: 'x', course_id: 'c1', account_created: true, password_reset_link: 'https://reset.example/1' } };
    return { ok: r.status < 400, status: r.status, json: async () => r.body };
  };
  return { http, calls };
}
const okBody = (email, course) => ({ status: 200, body: { ok: true, uid: 'uid_' + email, email, course_id: course, account_created: true, profile_created: true, expires_at: 123, password_reset_link: 'https://reset.example/' + email } });

async function proof(tenant, from, text, extra) {
  const identity = await contactIdentity.resolveContact(tenant, Object.assign({ jid: from, pushName: 'Marie' }, (extra && extra.id) || {}));
  return mpv.registerProof(Object.assign({ tenantId: tenant, channel: 'WHATSAPP', from, text, hasAttachment: true, courseId: 'cuisine', product: 'Cuisine pro', proofMessageId: 'PM' + Math.random().toString(36).slice(2, 7), identity }, extra || {}));
}

test('parseOwnerDecision : OUI/NON stricts, réponses ambiguës jamais interprétées', () => {
  for (const t of ['ok', "d'accord", 'attends', 'je vais voir', 'peut-être', 'ok je vais voir', 'hmm', 'oui mais attends', 'je ne sais pas', 'on verra demain']) {
    assert.equal(mpv.parseOwnerDecision(t).decision, null, `« ${t} » ne doit rien déclencher`);
  }
  for (const t of ['oui', 'Oui !', 'OUI PA-AB12', 'valider', 'Je valide', 'confirme']) assert.equal(mpv.parseOwnerDecision(t).decision, 'YES', t);
  for (const t of ['non', 'NON PA-AB12', 'refuser', 'Je refuse']) assert.equal(mpv.parseOwnerDecision(t).decision, 'NO', t);
  assert.equal(mpv.parseOwnerDecision('OUI pa-ab12').pendingActionId, 'PA-AB12');
  assert.equal(mpv.parseOwnerDecision('oui non').decision, null);
});

test('TEST 10 (logique) : preuve -> pendingActionId + notification -> OUI -> exécution API -> vérification -> client notifié', async () => {
  const t = 'pay1';
  notes.length = 0;
  const r = await proof(t, '22670123456@s.whatsapp.net', 'Voici mon reçu 5000 FCFA email: marie@mail.com');
  assert.equal(r.created, true);
  assert.match(r.pendingActionId, /^PA-[A-Z0-9]{4}$/);
  assert.equal(r.record.declaredAmount, '5000 FCFA');
  assert.equal(r.record.customerName, 'Marie');
  assert.equal(r.record.customerPhone, '+22670123456');
  assert.equal(notes.length, 1);
  assert.match(notes[0].text, /Preuve de paiement reçue de Marie/);
  assert.ok(notes[0].text.includes(r.pendingActionId), 'la notification porte la référence');
  assert.match(notes[0].text, /OUI.*valider.*NON/s);
  const pa = await pendingActions.get(t, r.pendingActionId);
  assert.equal(pa.notification.messageId, 'WA1', 'message notifié mémorisé pour la réponse en citation');

  // preuve dupliquée (même contenu, message différent) : ni 2e action ni 2e notification
  const dup = await proof(t, '22670123456@s.whatsapp.net', 'Voici mon reçu 5000 FCFA email: marie@mail.com');
  assert.equal(dup.duplicate, true);
  assert.equal(notes.length, 1);
  assert.equal((await pendingActions.listOpen(t)).length, 1);

  const { http, calls } = apiMock([okBody('marie@mail.com', 'cuisine')]);
  const delivered = [];
  const deps = { deliverToClient: async (m) => { delivered.push(m); }, executeOptions: { env: { CYRUS_PLATFORM_API_KEY: 'sk_test' }, http } };
  const decision = mpv.parseOwnerDecision('OUI');
  assert.equal(decision.decision, 'YES');
  const out = await mpv.resolveOwnerDecision(t, { decision: 'YES', pendingActionId: decision.pendingActionId, courseHint: decision.courseHint }, deps);
  assert.equal(out.kind, 'approved', JSON.stringify(out));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.email, 'marie@mail.com');
  assert.equal(delivered.length, 1);
  assert.match(delivered[0].text, /reset\.example/);
  assert.equal((await pendingActions.get(t, r.pendingActionId)).status, 'DONE');

  // « OUI » répété (retry, message dupliqué) : aucune 2e exécution
  const again = await mpv.resolveOwnerDecision(t, { decision: 'YES', pendingActionId: r.pendingActionId }, deps);
  assert.equal(again.kind, 'already_handled');
  assert.equal(calls.length, 1);
  assert.equal(delivered.length, 1);
});

test('TEST 11 (logique) : NON -> aucune activation, retour client, nouvelle preuve = nouvelle tentative distincte', async () => {
  const t = 'pay2';
  const from = '22670555000@s.whatsapp.net';
  const p1 = await proof(t, from, 'Voici mon reçu email: paul@mail.com');
  const { http, calls } = apiMock([]);
  const delivered = [];
  const deps = { deliverToClient: async (m) => { delivered.push(m); }, executeOptions: { env: { CYRUS_PLATFORM_API_KEY: 'sk_test' }, http } };
  const out = await mpv.resolveOwnerDecision(t, { decision: 'NO' }, deps);
  assert.equal(out.kind, 'rejected');
  assert.equal(calls.length, 0, 'aucun appel API : aucune activation');
  assert.match(delivered[0].text, /renvoie-nous une preuve correcte/);
  assert.equal((await pendingActions.get(t, p1.pendingActionId)).status, 'REJECTED');

  // le même « NON » rejoué ne fait rien de plus
  const again = await mpv.resolveOwnerDecision(t, { decision: 'NO', pendingActionId: p1.pendingActionId }, deps);
  assert.equal(again.kind, 'already_handled');

  // nouvelle preuve -> nouvelle tentative
  const p2 = await proof(t, from, 'Voici le nouveau reçu email: paul@mail.com');
  assert.equal(p2.created, true);
  assert.notEqual(p2.pendingActionId, p1.pendingActionId);
  assert.equal(p2.record.attempt, 2);
  assert.equal((await pendingActions.listOpen(t)).length, 1);
});

test('EXECUTE ≠ SUCCESS : API sans confirmation explicite -> échec, client non prévenu, retry possible par identifiant', async () => {
  const t = 'pay3';
  const p = await proof(t, '22670666000@s.whatsapp.net', 'Voici mon reçu email: awa@mail.com');
  const { http, calls } = apiMock([{ status: 200, body: {} }]);
  const delivered = [];
  const deps = { deliverToClient: async (m) => { delivered.push(m); }, executeOptions: { env: { CYRUS_PLATFORM_API_KEY: 'sk_test' }, http } };
  const out = await mpv.resolveOwnerDecision(t, { decision: 'YES' }, deps);
  assert.equal(out.kind, 'error');
  assert.equal(out.unverified, true);
  assert.equal(delivered.length, 0, 'jamais « activé » sans confirmation de l\'API');
  assert.equal((await pendingActions.get(t, p.pendingActionId)).status, 'FAILED');
  assert.match(out.text, /OUI PA-/);

  const deps2 = { deliverToClient: async (m) => { delivered.push(m); }, executeOptions: { env: { CYRUS_PLATFORM_API_KEY: 'sk_test' }, http: apiMock([okBody('awa@mail.com', 'cuisine')]).http } };
  const retry = await mpv.resolveOwnerDecision(t, { decision: 'YES', pendingActionId: p.pendingActionId }, deps2);
  assert.equal(retry.kind, 'approved');
  assert.equal(delivered.length, 1);
  assert.equal(calls.length, 1);
});

test('erreur HTTP de l\'API : échec, client non prévenu', async () => {
  const t = 'pay4';
  await proof(t, '22670777000@s.whatsapp.net', 'Voici mon reçu email: kofi@mail.com');
  const { http } = apiMock([{ status: 500, body: { error: 'Échec de l\'inscription.' } }]);
  const delivered = [];
  const out = await mpv.resolveOwnerDecision(t, { decision: 'YES' }, { deliverToClient: async (m) => { delivered.push(m); }, executeOptions: { env: { CYRUS_PLATFORM_API_KEY: 'sk_test' }, http } });
  assert.equal(out.kind, 'error');
  assert.equal(delivered.length, 0);
});

test('deux paiements en attente : « OUI » seul est ambigu (rien exécuté), « OUI PA-x » cible exactement celui-là', async () => {
  const t = 'pay5';
  const a = await proof(t, '22670100001@s.whatsapp.net', 'Voici mon reçu email: a@mail.com', { id: { pushName: 'Alice' } });
  const b = await proof(t, '22670100002@s.whatsapp.net', 'Voici mon reçu email: b@mail.com', { id: { pushName: 'Bob' } });
  const { http, calls } = apiMock([okBody('b@mail.com', 'cuisine')]);
  const delivered = [];
  const deps = { deliverToClient: async (m) => { delivered.push(m); }, executeOptions: { env: { CYRUS_PLATFORM_API_KEY: 'sk_test' }, http } };
  const amb = await mpv.resolveOwnerDecision(t, { decision: 'YES' }, deps);
  assert.equal(amb.kind, 'ambiguous');
  assert.equal(calls.length, 0);
  assert.ok(amb.text.includes(a.pendingActionId) && amb.text.includes(b.pendingActionId));
  const ok = await mpv.resolveOwnerDecision(t, { decision: 'YES', pendingActionId: b.pendingActionId }, deps);
  assert.equal(ok.kind, 'approved');
  assert.equal(calls[0].body.email, 'b@mail.com');
  assert.equal((await pendingActions.get(t, a.pendingActionId)).status, 'PENDING', 'l\'autre paiement reste en attente');
});

test('réponse en citation du message notifié : cible cette action même s\'il y en a plusieurs', async () => {
  const t = 'pay6';
  const a = await proof(t, '22670200001@s.whatsapp.net', 'Voici mon reçu email: c@mail.com');
  await proof(t, '22670200002@s.whatsapp.net', 'Voici mon reçu email: d@mail.com');
  const pa = await pendingActions.get(t, a.pendingActionId);
  const { http, calls } = apiMock([okBody('c@mail.com', 'cuisine')]);
  const out = await mpv.resolveOwnerDecision(t, { decision: 'YES', quotedMessageId: pa.notification.messageId }, { executeOptions: { env: { CYRUS_PLATFORM_API_KEY: 'sk_test' }, http } });
  assert.equal(out.kind, 'approved');
  assert.equal(calls[0].body.email, 'c@mail.com');
});

test('sans identifiant de cours : demande de précision, aucune exécution', async () => {
  const t = 'pay7';
  await mpv.registerProof({ tenantId: t, channel: 'WHATSAPP', from: '22670300001@s.whatsapp.net', text: 'Voici mon reçu email: e@mail.com', hasAttachment: true, proofMessageId: 'X1' });
  const { http, calls } = apiMock([]);
  const out = await mpv.resolveOwnerDecision(t, { decision: 'YES' }, { executeOptions: { env: { CYRUS_PLATFORM_API_KEY: 'sk_test' }, http } });
  assert.equal(out.kind, 'need_course');
  assert.equal(calls.length, 0);
});

test('la décision du tchat (VALIDER) et celle de WhatsApp (OUI) partagent la même action : pas de double exécution', async () => {
  const t = 'pay8';
  const p = await proof(t, '22670400001@s.whatsapp.net', 'Voici mon reçu email: f@mail.com');
  const m1 = apiMock([okBody('f@mail.com', 'cuisine')]);
  const deps1 = { executeOptions: { env: { CYRUS_PLATFORM_API_KEY: 'sk_test' }, http: m1.http } };
  const viaChat = await mpv.resolveAdminDecision(t, 'VALIDER', deps1);
  assert.equal(viaChat.kind, 'approved');
  const m2 = apiMock([okBody('f@mail.com', 'cuisine')]);
  const viaWa = await mpv.resolveOwnerDecision(t, { decision: 'YES', pendingActionId: p.pendingActionId }, { executeOptions: { env: { CYRUS_PLATFORM_API_KEY: 'sk_test' }, http: m2.http } });
  assert.equal(viaWa.kind, 'already_handled');
  assert.equal(m1.calls.length, 1);
  assert.equal(m2.calls.length, 0);
});

test('aucune notification de paiement ne contient un identifiant technique', async () => {
  const t = 'pay9';
  notes.length = 0;
  await proof(t, '999888777666555@lid', 'Voici mon reçu email: g@mail.com', { id: { pushName: null } });
  assert.ok(!/@lid|999888777666555/.test(notes[0].text), notes[0].text);
  assert.match(notes[0].text, /Contact WhatsApp non identifié/);
});
