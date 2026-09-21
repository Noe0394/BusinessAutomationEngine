// TEST — limite de 10 échanges IA / heure / client : compteur, isolation par client et par tenant, atomicité sous concurrence,
// idempotence, persistance au redémarrage, fenêtre glissante, passage au propriétaire au 10e échange, AUCUN appel IA après la limite,
// groupes (limite par membre), propriétaire illimité, priorité des offres et mémoire commerciale.
//   node --test test/client-ai-quota.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-quota-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.AI_RETRY_BASE_MS = '0';
process.env.GITHUB_TOKEN = '';
process.env.GEMINI_API_KEY = 'test-key';
process.env.AUTO_REPLY_DEBOUNCE_MS = '0';
require('./helpers/auth').actAsAdmin();

const axios = require('axios');
const quota = require('../ai-engine/clientAiQuota');
const llm = require('../lib/ai/llmFallbackEngine');
const autoResponder = require('../ai-engine/autoResponder');
const alertCenter = require('../ai-engine/alertCenter');
const businessServices = require('../ai-engine/businessServices');
const conversationRouter = require('../ai-engine/conversationRouter');

const HOUR = 3600 * 1000;
let aiCalls = 0; const prompts = [];
const origPost = axios.post; const origGet = axios.get;
const VARIANTS = ['Avec plaisir, je vous détaille tout ça.', 'Excellente question, voici ce qu\'il faut savoir.', 'Bien sûr, dites-moi ce qui vous intéresse le plus.', 'Je vous explique le programme en quelques mots.', 'Oui, c\'est une formation très complète.', 'Volontiers, on avance ensemble sur ce point.', 'Merci de votre intérêt, voilà les précisions demandées.', 'Pas de souci, je reviens sur chaque détail.', 'Content de vous aider à y voir plus clair.', 'Très bonne remarque, regardons cela ensemble.', 'Allons droit au but avec les informations utiles.', 'Je vous réponds sur ce point précisément.', 'Comptez sur moi pour vous guider pas à pas.', 'Ce sujet mérite un éclaircissement, le voici.', 'Voici de quoi vous décider sereinement.'];
axios.post = async (url, body) => {
  aiCalls += 1; prompts.push(JSON.stringify(body));
  return { data: { candidates: [{ content: { parts: [{ text: VARIANTS[aiCalls % VARIANTS.length] }] } }] } };
};
axios.get = async () => { throw new Error('pas de réseau'); };
test.after(() => { axios.post = origPost; axios.get = origGet; try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) { /* nettoyage */ } });

const alerts = [];
alertCenter.setDeliverers([async (tenant, text) => { alerts.push({ tenant, text }); return { ok: true, channel: 'test' }; }]);
const sent = [];
const runtime = { sendMessageVerified: async ({ to, text, tenantId }) => { sent.push({ to, text, tenantId }); return { status: 'SUCCESS', confirmationId: 'C' + sent.length }; } };
const settings = { whatsapp: true, telegram: true, debounceMs: 0, groupReplies: true };

// ---------------------------------------------------------------------------- compteur pur
test('compteur : 10 échanges autorisés, le 11e refusé ; idempotent par exchangeId (retry/régénération ne comptent pas deux fois)', async () => {
  for (let i = 1; i <= 10; i++) assert.equal((await quota.consume('tq1', 'cA', 'm' + i)).allowed, true);
  const again = await quota.consume('tq1', 'cA', 'm3'); // retry du même échange
  assert.equal(again.allowed, true); assert.equal(again.count, 10);
  const r = await quota.consume('tq1', 'cA', 'm11');
  assert.equal(r.allowed, false); assert.equal(r.count, 10); assert.equal(r.exhausted, true);
});

test('ISOLATION : client A (7) n\'affecte pas client B (2) ; un autre tenant est indépendant même avec la même clé de client', async () => {
  for (let i = 0; i < 7; i++) await quota.consume('tq2', 'A', 'a' + i);
  for (let i = 0; i < 2; i++) await quota.consume('tq2', 'B', 'b' + i);
  assert.equal((await quota.status('tq2', 'A')).count, 7);
  assert.equal((await quota.status('tq2', 'B')).count, 2);
  for (let i = 0; i < 10; i++) await quota.consume('tq3', 'A', 'z' + i); // autre tenant, même clé « A »
  assert.equal((await quota.status('tq2', 'A')).count, 7);
  assert.equal((await quota.status('tq3', 'A')).exhausted, true);
});

test('ATOMICITÉ : 40 messages simultanés du même client -> exactement 10 échanges passent', async () => {
  const res = await Promise.all(Array.from({ length: 40 }, (_, i) => quota.consume('tq4', 'racer', 'r' + i)));
  assert.equal(res.filter((r) => r.allowed).length, 10);
  assert.equal(res.filter((r) => !r.allowed).length, 30);
  assert.equal((await quota.status('tq4', 'racer')).count, 10);
});

test('FENÊTRE GLISSANTE : après une heure les échanges expirent et le compteur repart, sans rien effacer d\'autre', async () => {
  const t0 = Date.now();
  for (let i = 0; i < 10; i++) await quota.consume('tq5', 'w', 'w' + i, t0 + i * 1000);
  assert.equal((await quota.consume('tq5', 'w', 'w-x', t0 + 30 * 60000)).allowed, false);
  const later = await quota.consume('tq5', 'w', 'w-new', t0 + HOUR + 500); // le plus ancien est sorti de la fenêtre
  assert.equal(later.allowed, true);
  assert.equal(later.count, 10, '9 restants dans la fenêtre + le nouveau');
  const s = await quota.status('tq5', 'w', t0 + 2 * HOUR + 20000);
  assert.equal(s.count, 0);
});

test('PERSISTANCE : le compteur survit à un redémarrage du processus (module rechargé, même stockage)', async () => {
  for (let i = 0; i < 10; i++) await quota.consume('tq6', 'persist', 'p' + i);
  for (const k of Object.keys(require.cache)) if (/ai-engine[\\/](clientAiQuota|storageAdapter)\.js$/.test(k)) delete require.cache[k];
  const fresh = require('../ai-engine/clientAiQuota');
  assert.notEqual(fresh, quota);
  const s = await fresh.status('tq6', 'persist');
  assert.equal(s.count, 10); assert.equal(s.exhausted, true);
});

test('clé de client stable entre canaux (contactId), et par EXPÉDITEUR en groupe', () => {
  assert.equal(quota.clientKeyFor({ channel: 'WHATSAPP', from: '1@s.whatsapp.net', identity: { contactId: 'ct_9' } }), quota.clientKeyFor({ channel: 'TELEGRAM', from: '77', identity: { contactId: 'ct_9' } }));
  assert.notEqual(quota.clientKeyFor({ channel: 'WHATSAPP', from: 'g@g.us', senderId: 'x@s.whatsapp.net' }), quota.clientKeyFor({ channel: 'WHATSAPP', from: 'g@g.us', senderId: 'y@s.whatsapp.net' }));
});

// ---------------------------------------------------------------------------- bout en bout (vrai gateway, HTTP simulé)
// La protection anti-boucle existante (8 messages / 2 min) coupe déjà les rafales : on la remet à zéro pour tester la limite horaire elle-même.
async function resetLoop(tenantId, from) {
  const cs = require('../ai-engine/jarvis/conversationState');
  const st = await cs.get(tenantId, 'WHATSAPP', from); st.recentTs = []; await cs.save(st);
}
async function ask(tenantId, from, text, n, extra) {
  await resetLoop(tenantId, from);
  return autoResponder.handleIncoming(Object.assign({ tenantId, channel: 'WHATSAPP', from, name: 'Awa', text, messageId: `${from}-${n}` }, extra || {}),
    { runtime, settings, identity: { contactId: 'ct_' + from, label: 'Awa Traoré', labelWithPhone: 'Awa Traoré (+226 70 12 34 56)', phoneNumber: '22670123456' } });
}

test('BOUT EN BOUT : 10 échanges répondus, notification OWNER au 10e avec le vrai nom, puis AUCUN appel IA ni réponse au 11e/12e', async () => {
  const T = 'tE2E';
  await businessServices.create(T, { name: 'Formation Marketing', type: 'formation', commercial: { price: 25000, currency: 'FCFA', description: 'Formation certifiante de 6 semaines' } });
  const from = '22670123456@s.whatsapp.net';
  for (let i = 1; i <= 10; i++) await ask(T, from, i % 2 ? 'C\'est combien ?' : 'Quels sont les avantages ?', i);
  const repliesAfter10 = sent.filter((s) => s.tenantId === T).length;
  assert.equal(repliesAfter10, 10, 'chaque échange autorisé reçoit une réponse');
  const callsAfter10 = aiCalls;
  assert.ok(alerts.some((a) => a.tenant === T && /limite de conversation IA a été atteinte/i.test(a.text)), 'notification OWNER : ' + JSON.stringify(alerts));
  const notice = alerts.find((a) => a.tenant === T && /limite de conversation IA/i.test(a.text)).text;
  assert.match(notice, /Awa Traoré/); assert.match(notice, /10 échanges/); assert.match(notice, /réponse manuelle/);
  // 11e et 12e messages : aucun appel IA, aucune réponse automatique, une seule notification au total
  const o11 = await ask(T, from, 'Et pour l\'attestation ?', 11);
  const o12 = await ask(T, from, 'Vous êtes là ?', 12);
  assert.equal(aiCalls, callsAfter10, 'AUCUN appel IA supplémentaire après la limite');
  assert.equal(sent.filter((s) => s.tenantId === T).length, 10, 'aucune réponse automatique après la limite');
  assert.equal(o11.skipped, 'AI_LIMIT'); assert.equal(o12.skipped, 'AI_LIMIT');
  assert.equal(alerts.filter((a) => a.tenant === T && /limite de conversation IA/i.test(a.text)).length, 1, 'notification unique par fenêtre');
  // handoff : contexte conservé, conversation passée en réponse manuelle, listée parmi celles qui attendent le propriétaire
  const waiting = await conversationRouter.listAwaitingOwner(T, ['HUMAN_REQUIRED']);
  assert.equal(waiting.length, 1); assert.equal(waiting[0].contactLabel, 'Awa Traoré (+226 70 12 34 56)');
  const st = await require('../ai-engine/jarvis/conversationState').get(T, 'WHATSAPP', from);
  assert.equal(st.handoff.state, 'HUMAN_REQUIRED'); assert.equal(st.handoff.reason, 'AI_LIMIT');
  assert.ok(st.turns >= 10 && st.memory.askedQuestions.length >= 1, 'contexte de conversation conservé');
});

test('ISOLATION bout en bout : pendant que A est bloqué, B (autre client, même tenant) est toujours servi', async () => {
  const T = 'tE2E';
  const before = sent.filter((s) => s.tenantId === T).length;
  const out = await ask(T, '22675999888@s.whatsapp.net', 'C\'est combien ?', 1);
  assert.equal(out.sent, true);
  assert.equal(sent.filter((s) => s.tenantId === T).length, before + 1);
});

test('CONCURRENCE bout en bout : 15 messages simultanés d\'un même client ne dépassent jamais 10 appels IA d\'échange', async () => {
  const T = 'tConc'; const from = '22671000001@s.whatsapp.net';
  const startCalls = aiCalls;
  await Promise.all(Array.from({ length: 15 }, (_, i) => ask(T, from, 'C\'est combien ?', i + 1)));
  assert.ok(aiCalls - startCalls <= 10, `appels IA : ${aiCalls - startCalls}`);
  assert.ok(aiCalls - startCalls >= 1);
});

test('GROUPES : la limite s\'applique par MEMBRE — X bloqué, Y du même groupe toujours servi', async () => {
  const T = 'tGrp'; const group = '120363000000@g.us';
  const X = '22670111111@s.whatsapp.net'; const Y = '22670222222@s.whatsapp.net';
  for (let i = 1; i <= 10; i++) await ask(T, group, 'C\'est combien la formation ?', i, { senderId: X, messageId: `gx-${i}` });
  const callsX = aiCalls;
  const blocked = await ask(T, group, 'Et l\'attestation ?', 99, { senderId: X, messageId: 'gx-99' });
  assert.equal(blocked.skipped, 'AI_LIMIT'); assert.equal(aiCalls, callsX);
  const ok = await ask(T, group, 'C\'est combien la formation ?', 1, { senderId: Y, messageId: 'gy-1' });
  assert.ok(ok.sent || ok.skipped !== 'AI_LIMIT', 'un autre membre n\'est pas bloqué : ' + JSON.stringify(ok));
  assert.ok(aiCalls > callsX);
  // le groupe lui-même n'est pas mis en pause
  const st = await require('../ai-engine/jarvis/conversationState').get(T, 'WHATSAPP', group);
  assert.ok(!st.handoff || st.handoff.state !== 'HUMAN_REQUIRED');
});

test('PROPRIÉTAIRE ILLIMITÉ : le Chat intelligent / self-chat n\'est jamais compté (aucun contexte client)', async () => {
  const c0 = aiCalls;
  for (let i = 0; i < 25; i++) await llm.generateAIResponse('Analyse mes ventes ' + i, [], null, undefined, null, { tenant: 'tOwner', purpose: 'owner_chat' });
  assert.equal(aiCalls - c0, 25);
  assert.equal((await quota.status('tOwner', 'owner')).count, 0);
});

test('ANCIEN MODE (jarvis:false) : même limite, aucun appel IA après 10 échanges', async () => {
  const T = 'tLegacy'; const from = '22670888777@s.whatsapp.net'; const legacy = Object.assign({}, settings, { jarvis: false });
  const go = (n) => autoResponder.handleIncoming({ tenantId: T, channel: 'WHATSAPP', from, name: 'Issa', text: 'Bonjour ' + n, messageId: 'lg-' + n }, { runtime, settings: legacy, identity: { contactId: 'ct_lg', label: 'Issa', phoneNumber: '22670888777' } });
  for (let i = 1; i <= 10; i++) await go(i);
  const c = aiCalls;
  const o = await go(11);
  assert.equal(o.skipped, 'AI_LIMIT'); assert.equal(aiCalls, c);
});

test('REPRISE : quand le propriétaire rend la main pendant la limitation, l\'IA reste coupée (jamais d\'appel IA pendant la limitation)', async () => {
  const T = 'tE2E'; const from = '22670123456@s.whatsapp.net';
  await conversationRouter.resumeAutomation(T, 'WHATSAPP', from);
  const c0 = aiCalls;
  const out = await ask(T, from, 'Bonjour, toujours là ?', 50);
  assert.equal(out.skipped, 'AI_LIMIT'); assert.equal(aiCalls, c0);
});

// ---------------------------------------------------------------------------- conversation commerciale
test('PRIORITÉ DES OFFRES : service actif le plus récent d\'abord, les autres en suggestions ; le contexte de campagne prime', async () => {
  const T = 'tPrio';
  await businessServices.create(T, { name: 'Formation Excel', type: 'formation', commercial: { price: 15000, currency: 'FCFA', description: 'Excel pour débutants' } });
  await new Promise((r) => setTimeout(r, 15));
  await businessServices.create(T, { name: 'Formation Comptabilité', type: 'formation', commercial: { price: 40000, currency: 'FCFA', description: 'Attestation reconnue par l\'ordre X' } });
  const c = await businessServices.getPrioritizedContext(T, {});
  assert.equal(c.priority, 'Formation Comptabilité');
  assert.match(c.text, /SERVICE PRIORITAIRE[\s\S]*Formation Comptabilité[\s\S]*40000/);
  assert.match(c.text, /AUTRES OFFRES[\s\S]*Formation Excel/);
  assert.ok(c.text.indexOf('Formation Comptabilité') < c.text.indexOf('Formation Excel'));
  const camp = await businessServices.getPrioritizedContext(T, { hint: 'Formation Excel' });
  assert.equal(camp.priority, 'Formation Excel');
  assert.deepEqual((await businessServices.getPrioritizedContext('tVide', {})).text, '');
});

test('MÉMOIRE + CONSIGNES : le prompt contient le service prioritaire, l\'interdiction d\'inventer, et le contexte des questions précédentes', async () => {
  const T = 'tPrio'; const from = '22670555555@s.whatsapp.net';
  prompts.length = 0;
  await ask(T, from, 'Je suis intéressé, donnez-moi les informations', 1);
  await ask(T, from, 'Et l\'attestation est-elle reconnue ?', 2);
  const p2 = prompts[prompts.length - 1];
  assert.match(p2, /SERVICE PRIORITAIRE/); assert.match(p2, /Formation Comptabilité/);
  assert.match(p2, /UNIQUEMENT s/);
  assert.match(p2, /Service qui a suscité l.intérêt du client : « Formation Comptabilité »/);
  assert.match(p2, /Questions déjà posées/);
  const st = await require('../ai-engine/jarvis/conversationState').get(T, 'WHATSAPP', from);
  assert.equal(st.memory.interestService, 'Formation Comptabilité');
});
