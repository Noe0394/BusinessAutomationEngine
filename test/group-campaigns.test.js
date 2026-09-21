// TEST RUNNER — campagnes de groupes administrés : ciblage réel, programmation, intérêt, preuve de paiement, confirmation.
//   node --test test/group-campaigns.test.js
// Le transport WhatsApp est un faux (aucun envoi réel) ; toute la logique métier, le stockage, le scheduler, le workflow de
// paiement et l'Identity Resolver sont les vrais modules.
'use strict';
require('./helpers/auth').actAsAdmin(); // identité authentifiée de test (deny-by-default : voir ai-engine/authz.js)
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-gc-'));
const platformOrchestrator = require('../ai-engine/platformOrchestrator');
platformOrchestrator.notifyTenantChat = async () => {};
const alertCenter = require('../ai-engine/alertCenter');
const notes = [];
alertCenter.setDeliverers([async (t, text) => { notes.push(text); return { ok: true, channel: 't', messageId: 'W' + notes.length }; }]);
const gc = require('../ai-engine/groupCampaigns');
const businessServices = require('../ai-engine/businessServices');
const chatOrchestrator = require('../ai-engine/chatOrchestrator');
const contactIdentity = require('../ai-engine/contactIdentity');
const conversationState = require('../ai-engine/jarvis/conversationState');
const mpv = require('../ai-engine/manualPaymentValidator');
const pendingActions = require('../ai-engine/pendingActions');
const autoResponder = require('../ai-engine/autoResponder');
const assistantLayerMod = require('../ai-engine/assistantLayer');

const GROUPS = [
  { id: '1203630001@g.us', name: 'Épicerie du Quartier', size: 120, isAdmin: true },
  { id: '1203630002@g.us', name: 'EPICERIE Fraîche 2', size: 80, isAdmin: true },
  { id: '1203630003@g.us', name: 'Épicerie Solidaire', size: 60, isAdmin: false },
  { id: '1203630004@g.us', name: 'Famille', size: 12, isAdmin: true },
];
function runtimeFor(groups) {
  const rt = { sent: [], connected: true, groups: groups.map((g) => Object.assign({}, g)) };
  rt.listGroups = async () => ({ ok: true, connected: rt.connected, paired: true, groups: rt.groups });
  rt.sendToGroups = async ({ groupIds, text }) => { rt.sent.push({ groupIds, text }); return { ok: true, sent: groupIds.length, total: groupIds.length, results: groupIds.map((id) => ({ id, name: rt.groups.find((g) => g.id === id).name, ok: true })) }; };
  return rt;
}
const INSTRUCTION = `Pendant 3 jours, cible tous mes groupes administrés dont le nom contient Épicerie. Chaque jour, envoie un message à 8h, 12h et 18h. Utilise les messages que je fournis : « Bonjour à tous ! Promo épicerie ce matin. » « Midi : offre spéciale sur nos produits frais. » « Dernière chance ce soir, ne ratez pas la promo ! » Objectif du mois : 1 000 000 FCFA.`;
const llmStub = async () => JSON.stringify({ productName: 'Pack Épicerie', serviceName: '' });

async function makeService(tenant, over) {
  return businessServices.create(tenant, Object.assign({ name: 'Pack Épicerie', type: 'ecommerce', commercial: { price: 15000, currency: 'FCFA', description: 'Panier familial livré chaque semaine.', paymentTerms: 'Orange Money : 07 00 00 00 00 (Awa K.) · Wave : 05 11 22 33 44' } }, over || {}));
}
const D = (iso) => new Date(iso);

test('ciblage : vrais noms, insensible casse/accents, UNIQUEMENT les groupes où le compte est admin', async () => {
  const rt = runtimeFor(GROUPS);
  const r = await gc.resolveTargets('t1', 'épicerie', rt);
  assert.equal(r.ok, true);
  assert.deepEqual(r.groups.map((g) => g.name), ['Épicerie du Quartier', 'EPICERIE Fraîche 2']);
  assert.deepEqual(r.notAdmin, ['Épicerie Solidaire']);
  assert.ok(r.groups.every((g) => !/@g\.us/.test(g.name)), 'jamais un groupId à la place du nom');
  rt.connected = false;
  assert.equal((await gc.resolveTargets('t1', 'épicerie', rt)).error, 'NOT_CONNECTED');
});

test('Chat -> outil -> campagne : liste de groupes figée, horaires, messages fournis, objectif ; réponse sans identifiant technique', async () => {
  const t = 't2'; await makeService(t);
  const rt = runtimeFor(GROUPS);
  assert.equal(chatOrchestrator.detectIntent(INSTRUCTION, null), 'groupcampaign');
  const out = await chatOrchestrator.handle({ text: INSTRUCTION, history: [], tenantId: t, sessionId: 's', lastAssistantMessage: null }, { runtime: rt, llm: llmStub });
  assert.ok(out.toolCall && out.toolCall.name === 'createGroupCampaign' && out.toolCall.state === 'SUCCESS', JSON.stringify(out).slice(0, 500));
  assert.match(out.text, /Épicerie du Quartier, EPICERIE Fraîche 2/);
  assert.match(out.text, /Ignorés \(tu n'y es pas administrateur\) : Épicerie Solidaire/);
  assert.ok(!/@g\.us|@lid/.test(out.text));
  const [c] = await gc.list(t);
  assert.deepEqual(c.groups.map((g) => g.id), ['1203630001@g.us', '1203630002@g.us']);
  assert.deepEqual(c.slots.map((s) => s.time), ['08:00', '12:00', '18:00']);
  assert.equal(c.slots[0].message, 'Bonjour à tous ! Promo épicerie ce matin.');
  assert.equal(c.slots[2].message, 'Dernière chance ce soir, ne ratez pas la promo !');
  assert.equal(c.days, 3);
  assert.equal(c.endAt - c.startAt, 3 * 24 * 3600 * 1000);
  assert.deepEqual(c.goal && [c.goal.amount, c.goal.currency, c.goal.period], [1000000, 'FCFA', 'mois']);
  assert.equal(c.serviceName, 'Pack Épicerie');
});

test('Chat : information manquante -> question ; la réponse (messages) est reprise verbatim', async () => {
  const t = 't3'; await makeService(t);
  const rt = runtimeFor(GROUPS);
  const q = await chatOrchestrator.handle({ text: 'Pendant 1 semaine, cible tous mes groupes administrés dont le nom contient Épicerie, envoie un message à 9h chaque jour.', history: [], tenantId: t, sessionId: 's', lastAssistantMessage: null }, { runtime: rt, llm: llmStub });
  assert.equal(q.isPlanningQuestion, true);
  assert.match(q.text, /Quels messages/);
  const done = await chatOrchestrator.handle({ text: '« Bonjour ! Découvrez notre panier de la semaine 🛒 »', history: [], tenantId: t, sessionId: 's', lastAssistantMessage: Object.assign({ role: 'assistant' }, q) }, { runtime: rt, llm: llmStub });
  assert.equal(done.toolCall.state, 'SUCCESS');
  const [c] = await gc.list(t);
  assert.equal(c.slots[0].message, 'Bonjour ! Découvrez notre panier de la semaine 🛒');
  assert.equal(c.days, 7);
});

test('aucun groupe administré / WhatsApp déconnecté : refus honnête, rien n\'est créé', async () => {
  const t = 't4'; await makeService(t);
  const rt = runtimeFor(GROUPS.map((g) => Object.assign({}, g, { isAdmin: false })));
  const a = await chatOrchestrator.handle({ text: INSTRUCTION, history: [], tenantId: t, sessionId: 's', lastAssistantMessage: null }, { runtime: rt, llm: llmStub });
  assert.match(a.text, /tu n'y es pas administrateur/);
  assert.equal((await gc.list(t)).length, 0);
  rt.connected = false;
  const b = await chatOrchestrator.handle({ text: INSTRUCTION, history: [], tenantId: t, sessionId: 's', lastAssistantMessage: null }, { runtime: rt, llm: llmStub });
  assert.match(b.text, /WhatsApp n'est pas connecté|WHATSAPP_NOT_CONNECTED/);
  assert.equal((await gc.list(t)).length, 0);
});

async function createCampaign(t, rt, nowIso, extra) {
  const target = await gc.resolveTargets(t, 'épicerie', rt);
  const r = await gc.create(t, Object.assign({ keyword: 'épicerie', groups: target.groups, days: 3, now: D(nowIso).getTime(), serviceName: 'Pack Épicerie', slots: [
    { time: '08:00', message: 'M-matin' }, { time: '12:00', message: 'M-midi' }, { time: '18:00', message: 'M-soir' }] }, extra || {}));
  assert.ok(r.ok, JSON.stringify(r));
  return r.result.campaign;
}

test('scheduler : un envoi par créneau et par jour (idempotent), créneaux passés à la création ignorés, arrêt automatique', async () => {
  const t = 't5'; await makeService(t); const rt = runtimeFor(GROUPS);
  const camp = await createCampaign(t, rt, '2026-09-21T07:00:00Z');
  // 07:59 : rien ; 08:00 : matin ; 08:01 : pas de doublon
  assert.equal((await gc.tick(t, rt, D('2026-09-21T07:59:00Z'))).length, 0);
  const a = await gc.tick(t, rt, D('2026-09-21T08:00:30Z'));
  assert.equal(a[0].status, 'done');
  assert.deepEqual(rt.sent.map((s) => s.text), ['M-matin']);
  assert.deepEqual(rt.sent[0].groupIds, ['1203630001@g.us', '1203630002@g.us']);
  await gc.tick(t, rt, D('2026-09-21T08:01:30Z'));
  await Promise.all([gc.tick(t, rt, D('2026-09-21T08:02:00Z')), gc.tick(t, rt, D('2026-09-21T08:02:00Z'))]);
  assert.equal(rt.sent.length, 1, 'jamais deux envois pour le même créneau');
  // midi et soir
  await gc.tick(t, rt, D('2026-09-21T12:05:00Z'));
  await gc.tick(t, rt, D('2026-09-21T18:00:10Z'));
  assert.deepEqual(rt.sent.map((s) => s.text), ['M-matin', 'M-midi', 'M-soir']);
  // lendemain : le message du matin repart, mais PAS s'il est en retard de plus de 90 min (redémarrage tardif)
  await gc.tick(t, rt, D('2026-09-22T12:00:00Z'));
  const day2 = rt.sent.map((s) => s.text);
  assert.ok(!day2.slice(3).includes('M-matin'), 'créneau du matin manqué de plus de 90 min : non envoyé');
  const cur = await gc.get(t, camp.id);
  assert.equal(cur.runs['2026-09-22|08:00'].status, 'missed');
  // fin : auto-stop + alerte + plus aucun envoi
  const before = rt.sent.length;
  notes.length = 0;
  await gc.tick(t, rt, D('2026-09-24T07:30:00Z'));
  assert.equal((await gc.get(t, camp.id)).status, 'completed');
  assert.ok(notes.some((n) => /terminée/.test(n)));
  await gc.tick(t, rt, D('2026-09-24T12:00:00Z'));
  assert.equal(rt.sent.length, before);
  // suivi réel
  const rep = (await gc.report(t, camp.id)).result;
  assert.equal(rep.messagesSent, rt.sent.reduce((n, s) => n + s.groupIds.length, 0));
});

test('créneaux déjà passés le jour de la création : jamais envoyés rétroactivement', async () => {
  const t = 't6'; await makeService(t); const rt = runtimeFor(GROUPS);
  await createCampaign(t, rt, '2026-09-21T13:00:00Z');
  await gc.tick(t, rt, D('2026-09-21T13:01:00Z'));
  assert.equal(rt.sent.length, 0, 'ni 08:00 ni 12:00 (passés) ; 18:00 pas encore');
  await gc.tick(t, rt, D('2026-09-21T18:00:20Z'));
  assert.deepEqual(rt.sent.map((s) => s.text), ['M-soir']);
});

test('sécurité au moment de l\'envoi : WhatsApp coupé = report ; admin révoqué = groupe ignoré et signalé', async () => {
  const t = 't7'; await makeService(t); const rt = runtimeFor(GROUPS);
  await createCampaign(t, rt, '2026-09-21T07:00:00Z');
  rt.connected = false;
  const d = await gc.tick(t, rt, D('2026-09-21T08:00:30Z'));
  assert.equal(d[0].status, 'deferred');
  assert.equal(rt.sent.length, 0);
  rt.connected = true;
  rt.groups[1].isAdmin = false; // le compte n'est plus admin du 2e groupe
  notes.length = 0;
  const r = await gc.tick(t, rt, D('2026-09-21T08:10:00Z'));
  assert.equal(r[0].status, 'partial');
  assert.deepEqual(rt.sent[0].groupIds, ['1203630001@g.us'], 'jamais un groupe où le compte n\'est plus administrateur');
  assert.ok(notes.some((n) => /partiel/.test(n)));
});

// ------------------------------------------------------------------------------------------- intérêt -> offre -> preuve
async function setupLead(tenant, opts) {
  const o = opts || {};
  await makeService(tenant, o.serviceOver);
  const rt = runtimeFor(GROUPS);
  const camp = await createCampaign(tenant, rt, '2026-09-21T07:00:00Z');
  const identity = await contactIdentity.resolveContact(tenant, { jid: o.senderJid || '99887766554433@lid', altJids: o.altJids || [], pushName: o.pushName === undefined ? 'Awa Koné' : o.pushName });
  const dm = []; const send = async (to, text) => { dm.push({ to, text }); return { status: 'SUCCESS', confirmationId: 'C' + dm.length }; };
  return { rt, camp, identity, dm, send, senderJid: o.senderJid || '99887766554433@lid' };
}

test('intérêt d\'un membre : offre RÉELLE du service envoyée en privé, contexte (groupe/campagne/produit) conservé, une seule fois', async () => {
  const t = 't8';
  const { camp, identity, dm, send, senderJid } = await setupLead(t);
  const ok = await gc.handleGroupMessage({ tenantId: t, groupJid: '1203630001@g.us', senderJid, identity, text: 'Ça m\'intéresse, c\'est combien ?', messageId: 'G1' }, { send });
  assert.equal(ok.reason, 'OFFER_SENT');
  assert.equal(dm.length, 1);
  assert.equal(dm[0].to, senderJid);
  assert.match(dm[0].text, /Bonjour Awa Koné/);
  assert.match(dm[0].text, /15000 FCFA/);
  assert.match(dm[0].text, /Orange Money : 07 00 00 00 00 \(Awa K\.\)/);
  assert.match(dm[0].text, /capture de votre preuve de paiement/);
  assert.ok(!/99887766554433/.test(dm[0].text));
  const st = await conversationState.get(t, 'WHATSAPP', senderJid);
  assert.equal(st.groupOrigin.groupName, 'Épicerie du Quartier');
  assert.equal(st.groupOrigin.campaignId, camp.id);
  assert.equal(st.groupOrigin.productName, camp.productName);
  // pas de répétition (autre message du même membre, redélivrance)
  assert.equal((await gc.handleGroupMessage({ tenantId: t, groupJid: '1203630001@g.us', senderJid, identity, text: "Ça m'intéresse encore, je veux commander", messageId: 'G2' }, { send })).reason, 'ALREADY_ANSWERED');
  assert.equal((await gc.handleGroupMessage({ tenantId: t, groupJid: '1203630001@g.us', senderJid, identity, text: 'Ça m\'intéresse', messageId: 'G1' }, { send })).reason, 'DUPLICATE_DELIVERY');
  assert.equal(dm.length, 1);
});

test('pas d\'intérêt / autre groupe / expéditeur non identifié : aucune réponse', async () => {
  const t = 't9';
  const { identity, dm, send, senderJid } = await setupLead(t);
  assert.equal((await gc.handleGroupMessage({ tenantId: t, groupJid: '1203630001@g.us', senderJid, identity, text: 'Bonne journée à tous', messageId: 'N1' }, { send })).reason, 'NO_INTEREST');
  assert.equal((await gc.handleGroupMessage({ tenantId: t, groupJid: '1203630001@g.us', senderJid, identity, text: 'Non merci, pas intéressé', messageId: 'N2' }, { send })).reason, 'NO_INTEREST');
  assert.equal((await gc.handleGroupMessage({ tenantId: t, groupJid: '1203630004@g.us', senderJid, identity, text: 'Ça m\'intéresse !', messageId: 'N3' }, { send })).reason, 'NOT_A_CAMPAIGN_GROUP');
  assert.equal((await gc.handleGroupMessage({ tenantId: t, groupJid: '1203630003@g.us', senderJid, identity, text: 'Ça m\'intéresse !', messageId: 'N4' }, { send })).reason, 'NOT_A_CAMPAIGN_GROUP', 'groupe non administré : jamais ciblé');
  assert.equal((await gc.handleGroupMessage({ tenantId: t, groupJid: '1203630001@g.us', senderJid, identity: null, text: 'Ça m\'intéresse !', messageId: 'N5' }, { send })).reason, 'SENDER_UNIDENTIFIED');
  assert.equal(dm.length, 0);
});

test('service incomplet : aucune invention de prix/numéro, le propriétaire est prévenu', async () => {
  const t = 't10';
  const { identity, dm, send, senderJid } = await setupLead(t, { serviceOver: { commercial: { price: null, description: 'Panier familial' } } });
  notes.length = 0;
  const r = await gc.handleGroupMessage({ tenantId: t, groupJid: '1203630001@g.us', senderJid, identity, text: 'Je suis intéressée', messageId: 'M1' }, { send });
  assert.deepEqual(r.missing.sort(), ['numéro/instructions de dépôt', 'prix']);
  assert.ok(!/FCFA|Orange|Wave/.test(dm[0].text), 'aucun prix ni numéro inventé');
  assert.ok(notes.some((n) => /incomplet/.test(n)));
});

test('échec du message privé : signalé au propriétaire, nouvelle tentative possible', async () => {
  const t = 't11';
  const { identity, senderJid } = await setupLead(t);
  const bad = async () => ({ status: 'FAILED', error: 'NOT_CONNECTED' });
  notes.length = 0;
  const r = await gc.handleGroupMessage({ tenantId: t, groupJid: '1203630001@g.us', senderJid, identity, text: 'Ça m\'intéresse', messageId: 'F1' }, { send: bad });
  assert.equal(r.reason, 'DM_FAILED');
  assert.ok(notes.some((n) => /pas pu lui écrire en privé/.test(n)));
  const dm = []; const good = async (to, text) => { dm.push(text); return { status: 'SUCCESS' }; };
  const r2 = await gc.handleGroupMessage({ tenantId: t, groupJid: '1203630001@g.us', senderJid, identity, text: 'Ça m\'intéresse encore', messageId: 'F2' }, { send: good });
  assert.equal(r2.reason, 'OFFER_SENT');
  assert.equal(dm.length, 1);
});

test('parcours complet : capture SANS légende -> email demandé -> preuve rattachée au bon contact/groupe/campagne -> notification -> OUI -> API -> vérification -> client + suivi', async () => {
  const t = 't12';
  const { camp, identity, dm, send, senderJid } = await setupLead(t);
  await gc.handleGroupMessage({ tenantId: t, groupJid: '1203630001@g.us', senderJid, identity, text: 'Ça m\'intéresse', messageId: 'P0' }, { send });
  dm.length = 0; notes.length = 0;
  const deps = { send, registerProof: mpv.registerProof };
  // 1) capture sans texte
  const p1 = await gc.handleLeadProof({ tenantId: t, identity, text: '', hasAttachment: true, messageId: 'IMG1', jidForReply: senderJid }, deps);
  assert.equal(p1.reason, 'PROOF_WAITING_EMAIL');
  assert.match(dm[0].text, /adresse email/);
  assert.equal(notes.length, 0, 'pas encore de notification propriétaire : la preuve n\'est pas complète');
  // 2) l'email arrive, avec le montant déclaré
  const p2 = await gc.handleLeadProof({ tenantId: t, identity, text: 'Voici mon email : awa@mail.com — j\'ai payé 15000 FCFA', hasAttachment: false, messageId: 'TXT1', jidForReply: senderJid }, deps);
  assert.equal(p2.reason, 'PROOF_REGISTERED');
  assert.match(p2.pendingActionId, /^PA-/);
  // notification propriétaire : nom réel, groupe, offre, montant, référence
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Preuve de paiement reçue — Awa Koné/);
  assert.match(notes[0], /Groupe : Épicerie du Quartier/);
  assert.match(notes[0], /Offre : Pack Épicerie/);
  assert.match(notes[0], /Montant déclaré : 15000 FCFA/);
  assert.match(notes[0], /Veuillez confirmer/);
  assert.ok(notes[0].includes(p2.pendingActionId));
  assert.ok(!/99887766554433|@lid/.test(notes[0]));
  // rattachement exact
  const [rec] = await mpv.listPending(t);
  assert.equal(rec.origin.groupName, 'Épicerie du Quartier');
  assert.equal(rec.origin.campaignId, camp.id);
  assert.equal(rec.proofMessageId, 'IMG1', 'identifiant de la preuve (capture) conservé');
  assert.equal(rec.customerId, identity.contactId);
  // doublon : même message rejoué / nouvelle preuve pendant l'attente -> aucune 2e action
  await gc.handleLeadProof({ tenantId: t, identity, text: 'Voici mon email : awa@mail.com', hasAttachment: true, messageId: 'IMG2', jidForReply: senderJid }, deps);
  assert.equal((await pendingActions.listOpen(t)).length, 1);
  // 3) confirmation du propriétaire -> API mockée -> vérification -> client notifié
  const calls = []; const clientMsgs = [];
  const http = async (u, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ ok: true, uid: 'u1', course_id: 'cours-epicerie', account_created: true, password_reset_link: 'https://reset.example/1' }) }; };
  const out = await mpv.resolveOwnerDecision(t, { decision: 'YES', pendingActionId: p2.pendingActionId, courseHint: 'cours-epicerie' }, { deliverToClient: async (m) => { clientMsgs.push(m); }, executeOptions: { env: { CYRUS_PLATFORM_API_KEY: 'k' }, http } });
  assert.equal(out.kind, 'approved', JSON.stringify(out));
  assert.equal(calls.length, 1);
  assert.equal(clientMsgs.length, 1);
  const lead = await gc.leadForContact(t, identity.contactId);
  assert.equal(lead.status, 'CONVERTED');
  assert.equal(lead.amount.value, 15000);
  // 4) objectif + rapport réels
  await gc.setGoal(t, undefined, { amount: 1000000, currency: 'FCFA', period: 'mois' });
  const rep = (await gc.report(t)).result;
  assert.equal(rep.leads, 1); assert.equal(rep.proofsReceived, 1); assert.equal(rep.paymentsConfirmed, 1); assert.equal(rep.confirmedAmount, 15000);
  assert.equal(rep.goal.progressPercent, 1.5);
  assert.equal(rep.goal.remaining, 985000);
});

test('aucune correspondance approximative : preuve d\'un contact sans lead, ou d\'un AUTRE contact, refusée', async () => {
  const t = 't13';
  const { identity, dm, send, senderJid } = await setupLead(t);
  await gc.handleGroupMessage({ tenantId: t, groupJid: '1203630001@g.us', senderJid, identity, text: 'Ça m\'intéresse', messageId: 'X0' }, { send });
  const stranger = await contactIdentity.resolveContact(t, { jid: '22670999888@s.whatsapp.net', pushName: 'Awa Koné' }); // même nom, autre personne
  const deps = { send, registerProof: mpv.registerProof };
  const r = await gc.handleLeadProof({ tenantId: t, identity: stranger, text: 'email: x@mail.com', hasAttachment: true, messageId: 'Z1', jidForReply: '22670999888@s.whatsapp.net' }, deps);
  assert.equal(r.reason, 'NO_OPEN_LEAD');
  assert.equal((await mpv.listPending(t)).length, 0);
  assert.notEqual(stranger.contactId, identity.contactId);
});

test('refus (NON) puis nouvelle preuve : aucune activation, nouvelle tentative distincte, lead réutilisable', async () => {
  const t = 't14';
  const { identity, dm, send, senderJid } = await setupLead(t);
  await gc.handleGroupMessage({ tenantId: t, groupJid: '1203630001@g.us', senderJid, identity, text: 'Ça m\'intéresse', messageId: 'R0' }, { send });
  const deps = { send, registerProof: mpv.registerProof };
  const p = await gc.handleLeadProof({ tenantId: t, identity, text: 'email: b@mail.com', hasAttachment: true, messageId: 'R1', jidForReply: senderJid }, deps);
  const calls = [];
  const out = await mpv.resolveOwnerDecision(t, { decision: 'NO', pendingActionId: p.pendingActionId }, { deliverToClient: async () => {}, executeOptions: { env: { CYRUS_PLATFORM_API_KEY: 'k' }, http: async () => { calls.push(1); return { ok: true, status: 200, json: async () => ({}) }; } } });
  assert.equal(out.kind, 'rejected');
  assert.equal(calls.length, 0);
  assert.equal((await gc.leadForContact(t, identity.contactId)).paymentStatus, 'REJECTED');
  const p2 = await gc.handleLeadProof({ tenantId: t, identity, text: 'email: b@mail.com', hasAttachment: true, messageId: 'R2', jidForReply: senderJid }, deps);
  assert.equal(p2.reason, 'PROOF_REGISTERED');
  assert.notEqual(p2.pendingActionId, p.pendingActionId);
});

test('API sans confirmation : arrêt à cette étape, client non prévenu, lead non converti', async () => {
  const t = 't15';
  const { identity, send, senderJid } = await setupLead(t);
  await gc.handleGroupMessage({ tenantId: t, groupJid: '1203630001@g.us', senderJid, identity, text: 'Ça m\'intéresse', messageId: 'A0' }, { send });
  const p = await gc.handleLeadProof({ tenantId: t, identity, text: 'email: c@mail.com', hasAttachment: true, messageId: 'A1', jidForReply: senderJid }, { send, registerProof: mpv.registerProof });
  const client = [];
  const out = await mpv.resolveOwnerDecision(t, { decision: 'YES', pendingActionId: p.pendingActionId, courseHint: 'c1' }, { deliverToClient: async (m) => { client.push(m); }, executeOptions: { env: { CYRUS_PLATFORM_API_KEY: 'k' }, http: async () => ({ ok: true, status: 200, json: async () => ({}) }) } });
  assert.equal(out.kind, 'error');
  assert.equal(client.length, 0);
  assert.notEqual((await gc.leadForContact(t, identity.contactId)).status, 'CONVERTED');
});

test('membre qui passe en privé : origine, campagne, produit et état du paiement retrouvés (même contactId via numéro réel fourni par WhatsApp)', async () => {
  const t = 't16';
  // dans le groupe, WhatsApp fournit à la fois le LID et le vrai numéro (participantPn)
  const { identity, send, senderJid } = await setupLead(t, { altJids: ['22670555444@s.whatsapp.net'] });
  assert.equal(identity.phoneNumber, '22670555444');
  await gc.handleGroupMessage({ tenantId: t, groupJid: '1203630001@g.us', senderJid, identity, text: 'Ça m\'intéresse', messageId: 'C0' }, { send });
  // plus tard il écrit en privé depuis son numéro
  const dmIdentity = await contactIdentity.resolveContact(t, { jid: '22670555444@s.whatsapp.net', pushName: 'Awa Koné' });
  assert.equal(dmIdentity.contactId, identity.contactId);
  const layer = assistantLayerMod.create({ autoResponder, getRuntime: () => null, whatsappManager: {}, aiStudioStore: {}, chatOrchestrator: {}, llmFallbackEngine: {}, chatDeps: () => ({}) });
  const r = await layer.leadDm({ tenantId: t, jid: '22670555444@s.whatsapp.net', identity: dmIdentity, text: 'Bonjour, j\'ai une question sur la livraison', hasAttachment: false, messageId: 'D1' });
  assert.equal(r.handled, false, 'simple question : conversation normale');
  const st = await conversationState.get(t, 'WHATSAPP', '22670555444@s.whatsapp.net');
  assert.equal(st.groupOrigin.groupName, 'Épicerie du Quartier');
  // le Chat Intelligent reçoit ce contexte dans son prompt
  let prompt = '';
  await autoResponder.composeReply({ tenant: t, channel: 'WHATSAPP', from: '22670555444@s.whatsapp.net', name: 'Awa Koné', text: 'Vous livrez le samedi ?', llm: async (p) => { prompt = p; return 'ok'; } });
  assert.match(prompt, /groupe WhatsApp « Épicerie du Quartier »/);
  assert.match(prompt, /produit\/service : Pack Épicerie/);
  assert.match(prompt, /instructions de paiement envoyées, en attente de sa preuve/);
  // et ne repart pas vers le routage privé
  const layer2 = assistantLayerMod.create({ autoResponder: { getSettings: async () => ({ whatsapp: true }), isEnabled: () => true, isGroupChat: () => false }, getRuntime: () => null });
  assert.equal((await layer2.route({ tenantId: t, channel: 'WHATSAPP', text: 'Tu es où ?', from: '22670555444@s.whatsapp.net', messageId: 'Q', identity: dmIdentity })).reason, 'GROUP_LEAD');
});

test('Chat : « Objectif du mois » rattaché à la campagne, rapport et arrêt par le Chat', async () => {
  const t = 't17'; await makeService(t); const rt = runtimeFor(GROUPS);
  await chatOrchestrator.handle({ text: INSTRUCTION.replace(' Objectif du mois : 1 000 000 FCFA.', ''), history: [], tenantId: t, sessionId: 's', lastAssistantMessage: null }, { runtime: rt, llm: llmStub });
  const g = await chatOrchestrator.handle({ text: 'Objectif du mois : 1 000 000 FCFA.', history: [], tenantId: t, sessionId: 's', lastAssistantMessage: null }, { runtime: rt, llm: llmStub });
  assert.match(g.text, /Objectif enregistré/);
  const rep = await chatOrchestrator.handle({ text: 'Donne-moi le rapport de la campagne des groupes Épicerie', history: [], tenantId: t, sessionId: 's', lastAssistantMessage: null }, { runtime: rt, llm: llmStub });
  assert.match(rep.text, /Messages réellement envoyés : 0/);
  assert.match(rep.text, /Objectif du mois : 1000000 FCFA — atteint à 0%/);
  assert.ok(!/@g\.us|@lid/.test(rep.text));
  const stop = await chatOrchestrator.handle({ text: 'Arrête la campagne des groupes épicerie', history: [], tenantId: t, sessionId: 's', lastAssistantMessage: null }, { runtime: rt, llm: llmStub });
  assert.match(stop.text, /arrêtée/);
  assert.equal((await gc.list(t))[0].status, 'stopped');
  await gc.tick(t, rt, D('2099-01-01T08:00:00Z'));
  assert.equal(rt.sent.length, 0, 'campagne arrêtée : aucun envoi');
});

test('câblage assistantLayer.groupEntry : message de groupe réel -> identité de l\'EXPÉDITEUR (participant), offre envoyée à lui, jamais au groupe', async () => {
  const t = 't18';
  await makeService(t); const rt = runtimeFor(GROUPS);
  await createCampaign(t, rt, '2026-09-21T07:00:00Z');
  const sentVia = [];
  const runtime = { sendMessageVerified: async (p) => { sentVia.push(p); return { status: 'SUCCESS', confirmationId: 'CONF' + sentVia.length }; } };
  const layer = assistantLayerMod.create({ autoResponder, getRuntime: () => runtime, whatsappManager: {}, aiStudioStore: {}, chatOrchestrator: {}, llmFallbackEngine: {}, chatDeps: () => ({}) });
  const msg = { key: { remoteJid: '1203630001@g.us', participant: '99887766554433@lid', id: 'GM1', fromMe: false }, pushName: 'Awa Koné', message: { conversation: 'Je suis intéressée, comment payer ?' } };
  const session = { getIdentityHints: () => ({ jid: '1203630001@g.us', senderJid: '99887766554433@lid', altJids: ['22670123123@s.whatsapp.net'], pushName: 'Awa Koné', savedName: null, knownName: null }) };
  const out = await layer.groupEntry({ tenantId: t, session, msg, text: 'Je suis intéressée, comment payer ?', from: '1203630001@g.us', messageId: 'GM1', hasAttachment: false });
  assert.equal(out.reason, 'OFFER_SENT');
  assert.equal(sentVia.length, 1);
  assert.equal(sentVia[0].to, '99887766554433@lid', 'envoyé au membre, pas au groupe');
  assert.equal(sentVia[0].channel, 'WHATSAPP');
  const lead = Object.values((await require('../ai-engine/storageAdapter').get('group_leads', t, { leads: {} })).leads)[0];
  assert.equal(lead.contactLabel, 'Awa Koné');
  assert.equal(lead.phoneNumber, '22670123123', 'numéro réel fourni par WhatsApp (participantPn), jamais déduit du LID');
  assert.equal(lead.groupName, 'Épicerie du Quartier');
});

test('groupe hors campagne : aucun traitement, aucune identité créée dans l\'annuaire', async () => {
  const t = 't19'; await makeService(t); const rt = runtimeFor(GROUPS);
  await createCampaign(t, rt, '2026-09-21T07:00:00Z');
  const layer = assistantLayerMod.create({ autoResponder, getRuntime: () => ({ sendMessageVerified: async () => ({ status: 'SUCCESS' }) }), whatsappManager: {}, aiStudioStore: {}, chatOrchestrator: {}, llmFallbackEngine: {}, chatDeps: () => ({}) });
  const session = { getIdentityHints: () => ({ senderJid: '55556666777788@lid', altJids: [], pushName: 'Inconnu' }) };
  const r = await layer.groupEntry({ tenantId: t, session, msg: { key: { remoteJid: '1203630004@g.us', participant: '55556666777788@lid', id: 'Z9' } }, text: 'Ça m\'intéresse', from: '1203630004@g.us', messageId: 'Z9', hasAttachment: false });
  assert.equal(r.reason, 'NOT_A_CAMPAIGN_GROUP');
  const dir = await require('../ai-engine/storageAdapter').get('contact_identity', t, { contacts: {} });
  assert.equal(Object.keys(dir.contacts).length, 0);
});
