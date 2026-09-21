// TEST — Cyrus multi-métiers : cycle de vie client générique (commandes, SAV, relances à 10 vérifications), auto-connaissance (première personne,
// registres réels), présentation adaptative (formation, commerce, restaurant, prestation, e-commerce), guidage pas à pas vérifié, états de tâches
// longues, liaison de groupes vérifiée, Rapport & Activité (données réelles, isolation, filtres), boucle d'auto-amélioration contrôlée.
//   node --test test/multi-metiers.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-mm-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.GITHUB_TOKEN = '';
process.env.FOLLOWUPS_ENABLED = '';
require('./helpers/auth').actAsAdmin();

const HOUR = 3600 * 1000;
const lifecycle = require('../ai-engine/customerLifecycle');
const self = require('../ai-engine/cyrusSelf');
const guided = require('../ai-engine/guidedSetup');
const intel = require('../ai-engine/activityIntelligence');
const taskQueue = require('../ai-engine/taskQueue');
const businessServices = require('../ai-engine/businessServices');
const autoResponder = require('../ai-engine/autoResponder');
const toolRegistry = require('../ai-engine/toolRegistry');
const orchestrator = require('../ai-engine/chatOrchestrator');
const { ownerOf, authz } = require('./helpers/auth');

const T = 'mm_tenant_a'; const T2 = 'mm_tenant_b';
const noHistory = { lastMessages: async () => [], isOptedOut: async () => false, settings: { followUps: true } };
const client = (id, name) => ({ channel: 'WHATSAPP', id, name });

// ------------------------------------------------------------------ cycle de vie
test('dossiers : transitions valides, livraison → suivi planifié une seule fois', async () => {
  const o = await lifecycle.recordOrder(T, { serviceId: 's1', serviceName: 'Boutique', contact: client('22670000001', 'Awa'), items: [{ name: 'Robe', qty: 2, price: 5000 }] });
  assert.equal(o.total, 10000); assert.equal(o.status, 'ORDERED');
  await assert.rejects(() => lifecycle.setOrderStatus(T, o.id, 'DELIVERED').then(() => lifecycle.setOrderStatus(T, o.id, 'PAID')), (e) => e.code === 'INVALID_TRANSITION');
  const r = await lifecycle.setOrderStatus(T, (await lifecycle.recordOrder(T, { contact: client('22670000002', 'Ben') })).id, 'PAID');
  assert.equal(r.order.status, 'PAID');
  const d = await lifecycle.setOrderStatus(T, r.order.id, 'DELIVERED');
  assert.equal(d.followUp.created, true); assert.equal(d.followUp.followUp.kind, 'POST_DELIVERY');
  const again = await lifecycle.planFollowUp(T, { kind: 'POST_DELIVERY', orderId: r.order.id, contact: client('22670000002') });
  assert.equal(again.created, false, 'un seul suivi par dossier');
  const tasks = await taskQueue.list(T, { type: 'FOLLOW_UP' });
  assert.ok(tasks.length >= 1);
});

test('SAV : une réclamation = un dossier (dédoublonné) puis résolution', async () => {
  const a = await lifecycle.openCase(T, { contact: client('22670000003', 'Chloé'), category: 'livraison', summary: 'colis en retard' });
  const b = await lifecycle.openCase(T, { contact: client('22670000003', 'Chloé'), category: 'livraison', summary: 'toujours rien' });
  assert.equal(a.created, true); assert.equal(b.created, false); assert.equal(b.case.mentions, 2);
  const c = await lifecycle.resolveCase(T, a.case.id, 'colis livré');
  assert.equal(c.status, 'RESOLVED');
});

test('relance : les 10 vérifications décident SEND / WAIT / CANCEL / HUMAN', async () => {
  const o = await lifecycle.recordOrder(T, { contact: client('22670000010', 'Dan') });
  await lifecycle.setOrderStatus(T, o.id, 'PAYMENT_PENDING');
  const fu = (await lifecycle.listFollowUps(T, { kind: 'PAYMENT_REMINDER' })).find((f) => f.orderId === o.id);
  // 1) sans autorisation → HUMAN (aucun envoi automatique non autorisé)
  let d = await lifecycle.decideFollowUp(T, fu, { lastMessages: async () => [], isOptedOut: async () => false, settings: {} });
  assert.equal(d.action, 'HUMAN'); assert.ok(d.reasons.includes('AUTHORIZATION_REQUIRED'));
  // 2) client vient d'écrire → WAIT
  d = await lifecycle.decideFollowUp(T, fu, Object.assign({}, noHistory, { lastMessages: async () => [{ direction: 'in', ts: Date.now() - HOUR }] }));
  assert.equal(d.action, 'WAIT'); assert.ok(d.reasons.includes('RECENT_CLIENT_ACTIVITY'));
  // 3) contacté il y a peu → WAIT
  d = await lifecycle.decideFollowUp(T, fu, Object.assign({}, noHistory, { lastMessages: async () => [{ direction: 'out', ts: Date.now() - HOUR }] }));
  assert.ok(d.reasons.includes('CONTACTED_RECENTLY'));
  // 4) opt-out → CANCEL
  d = await lifecycle.decideFollowUp(T, fu, Object.assign({}, noHistory, { isOptedOut: async () => true }));
  assert.equal(d.action, 'CANCEL'); assert.ok(d.reasons.includes('OPTED_OUT'));
  // 5) tout est bon → SEND
  d = await lifecycle.decideFollowUp(T, fu, noHistory);
  assert.equal(d.action, 'SEND');
  // 6) action déjà réalisée (payé) → CANCEL
  await lifecycle.setOrderStatus(T, o.id, 'PAID');
  d = await lifecycle.decideFollowUp(T, fu, noHistory);
  assert.equal(d.action, 'CANCEL'); assert.ok(d.reasons.includes('PAYMENT_ALREADY_DONE'));
});

test('relance : Service inactif → CANCEL ; réclamation ouverte → HUMAN ; envoi vérifié ou échec honnête', async () => {
  const o = await lifecycle.recordOrder(T, { serviceId: 'svcX', contact: client('22670000011', 'Eve') });
  const fu = (await lifecycle.planFollowUp(T, { kind: 'LOYALTY', contact: client('22670000011', 'Eve'), serviceId: 'svcX', dueAt: Date.now() - 1000 })).followUp;
  let d = await lifecycle.decideFollowUp(T, fu, Object.assign({}, noHistory, { service: async () => ({ lifecycle: 'paused' }) }));
  assert.ok(d.reasons.includes('SERVICE_INACTIVE'));
  await lifecycle.openCase(T, { contact: client('22670000011', 'Eve'), category: 'produit', summary: 'défaut' });
  d = await lifecycle.decideFollowUp(T, fu, noHistory);
  assert.equal(d.action, 'HUMAN'); assert.ok(d.reasons.includes('OPEN_SAV_CASE'));
  void o;
  // envoi réel simulé au niveau runtime (jamais le canal) : succès vérifié
  const fu2 = (await lifecycle.planFollowUp(T, { kind: 'SATISFACTION', contact: client('22670000012', 'Fred'), dueAt: Date.now() - 1000 })).followUp;
  const sent = [];
  const runtime = { sendMessageVerified: async (m) => { sent.push(m); return { status: 'SUCCESS', confirmationId: 'c1' }; } };
  const out = await lifecycle.runFollowUp(T, fu2.id, Object.assign({}, noHistory, { runtime }));
  assert.equal(out.ok, true); assert.equal(sent.length, 1); assert.match(sent[0].text, /Bonjour Fred/);
  assert.equal((await lifecycle.listFollowUps(T, { status: 'SENT' })).some((f) => f.id === fu2.id), true);
  // une relance déjà envoyée n'est jamais renvoyée
  const again = await lifecycle.runFollowUp(T, fu2.id, Object.assign({}, noHistory, { runtime }));
  assert.equal(again.skipped, 'SENT'); assert.equal(sent.length, 1);
});

test('tâches durables : nouveaux états publics + pause/reprise + gestionnaire FOLLOW_UP du worker', async () => {
  assert.deepEqual(taskQueue.PUBLIC_STATES, ['QUEUED', 'RUNNING', 'WAITING_EXTERNAL', 'VERIFYING', 'COMPLETED', 'FAILED', 'CANCELLED', 'PAUSED']);
  assert.equal(taskQueue.normalizeState('PROCESSING'), 'RUNNING');
  const t = await taskQueue.enqueue(T, { type: 'SEND_MESSAGE', payload: { channel: 'WHATSAPP', to: 'x', text: 'y' }, runAt: Date.now() + 10 * HOUR });
  const p = await taskQueue.pause(T, t.id || t.task && t.task.id);
  assert.equal(p.state, 'PAUSED');
  const r = await taskQueue.resume(T, p.id);
  assert.equal(r.state, 'QUEUED');
  const w = await taskQueue.setState(T, p.id, 'WAITING_EXTERNAL');
  assert.equal(w.state, 'WAITING_EXTERNAL');
  const handlers = require('../ai-engine/toolsExtra').queueHandlers(T, null);
  assert.equal(typeof handlers.FOLLOW_UP, 'function');
  const res = await handlers.FOLLOW_UP({ payload: { followUpId: 'inconnu' } });
  assert.equal(res.ok, false); assert.equal(res.retryable, false);
});

// ------------------------------------------------------------------ auto-connaissance
test('auto-connaissance : capacités issues des registres réels, jamais de modèle/fournisseur/clé', async () => {
  const cap = await self.capabilities(T);
  assert.ok(cap.domains.find((d) => d.id === 'sav').available, 'les outils SAV existent réellement');
  assert.ok(cap.domains.find((d) => d.id === 'followups').available);
  assert.ok(cap.agents.total >= 100, 'agents Agency Agents réellement chargés');
  assert.equal(cap.channels.WHATSAPP, false, 'aucune session connectée dans ce test');
  const all = JSON.stringify(await Promise.all(['Que peux-tu faire ?', 'Quels agents utilises-tu ?', 'Que ne peux-tu pas faire ?', 'Comment tu t\'améliores ?'].map((q) => self.answer(T, q))));
  assert.doesNotMatch(all, /gemma|gemini|groq|openrouter|hugging|api[_ -]?key|sk-|AIza/i);
});

test('auto-connaissance : questions ciblées répondent sur l\'état réel (relancer, SAV, groupe, limites)', async () => {
  const relance = await self.answer(T, 'Peux-tu relancer un prospect ?');
  assert.equal(relance.can, false); assert.match(relance.text, /canal connecté/);
  const lim = await self.answer(T, 'Que ne peux-tu pas faire ?');
  assert.match(lim.text, /WhatsApp n'est pas connecté/); assert.match(lim.text, /10 échanges par heure/);
  const grp = await self.canDo(T, 'gérer un groupe');
  assert.equal(grp.can, false);
  const unknown = await self.canDo(T, 'piloter un avion');
  assert.equal(unknown.can, false); assert.match(unknown.because, /préfère vous le dire/);
});

test('présentation adaptative : demande l\'activité si inconnue, sinon s\'adapte au métier (5 secteurs) à la première personne', async () => {
  const ask = await self.introduce('mm_tenant_empty');
  assert.equal(ask.known, false); assert.match(ask.text, /votre activité/);
  const cases = [['formation en pâtisserie', 'formation'], ['boutique de vêtements', 'commerce'], ['restaurant', 'restaurant'], ['prestation de plomberie', 'prestation'], ['vente de produits e-commerce en ligne', 'commerce']];
  for (const [activity, sector] of cases) {
    const r = await self.introduce('mm_tenant_empty', { activity });
    assert.equal(r.known, true); assert.equal(r.sector, sector, activity);
    for (const part of ['Votre besoin', 'Ce que je peux faire', 'Exemple', 'Bénéfice', 'Prochaine étape']) assert.match(r.text, new RegExp(part));
    assert.ok(self.isFirstPerson(r.text), 'jamais « Cyrus est/peut/permet »'); assert.match(r.text, /Je suis Cyrus/);
    assert.doesNotMatch(r.text, /\d+\s?(?:FCFA|€|%)/, 'aucun prix / chiffre inventé');
    assert.doesNotMatch(r.text, /garanti|100 ?%/i);
  }
  assert.equal(self.isFirstPerson('Cyrus est un assistant'), false);
});

test('trois modes reconnus : EXPLIQUE-MOI / GUIDE-MOI / FAIS-LE', () => {
  assert.equal(self.detectMode('explique-moi comment ça marche'), 'EXPLAIN');
  assert.equal(self.detectMode('guide-moi pas à pas'), 'GUIDE');
  assert.equal(self.detectMode('fais-le pour moi'), 'DO');
  assert.equal(self.detectMode('bonjour'), null);
});

// ------------------------------------------------------------------ guidage pas à pas
test('guidage : chaque étape est vérifiée sur l\'état réel, jamais sur la parole de l\'utilisateur', async () => {
  const G = 'mm_guided';
  const ev0 = await guided.start(G, 'create-service');
  assert.equal(ev0.current, 0); assert.equal(ev0.finished, false);
  assert.match(guided.render(ev0), /Étape 1\/5/);
  // « c'est fait » sans donnée réelle : toujours étape 1
  assert.equal((await guided.status(G)).current, 0);
  const svc = await businessServices.create(G, { name: 'Salon Awa', commercial: { price: 3000 }, products: [{ name: 'Tresses', price: 3000 }] });
  let ev = await guided.status(G);
  assert.equal(ev.steps[0].done, true); assert.equal(ev.steps[1].done, true); assert.equal(ev.current, 2, 'passe à l\'étape des moyens de paiement');
  await businessServices.update(G, svc.id, { commercial: { paymentTerms: 'Mobile Money', objections: 'prix négociable', price: 3000 } });
  ev = await guided.status(G);
  assert.equal(ev.finished, true); assert.match(guided.render(ev), /C'est vérifié/);
  assert.equal(guided.planForText('je veux connecter mon whatsapp'), 'connect-whatsapp');
  const wa = await guided.evaluate(G, 'connect-whatsapp', { connected: { WHATSAPP: () => false, TELEGRAM: () => false } });
  assert.equal(wa.finished, false);
  const wa2 = await guided.evaluate(G, 'connect-whatsapp', { connected: { WHATSAPP: () => true, TELEGRAM: () => false } });
  assert.equal(wa2.finished, true);
});

// ------------------------------------------------------------------ Orchestrateur : intentions et réponses réelles
test('Orchestrateur : questions propriétaire sur relances / SAV / rapport routées et factuelles', async () => {
  const O = 'mm_owner';
  const o = await lifecycle.recordOrder(O, { serviceName: 'Restaurant', contact: client('22670000020', 'Gina') });
  await lifecycle.setOrderStatus(O, o.id, 'PAID'); await lifecycle.setOrderStatus(O, o.id, 'DELIVERED');
  // le suivi est planifié automatiquement : on l'annule pour simuler « livrée sans suivi »
  for (const f of await lifecycle.listFollowUps(O)) await require('../ai-engine/storageAdapter').get('lifecycle', O).then(async (doc) => { doc.followUps[f.id].status = 'CANCELLED'; await require('../ai-engine/storageAdapter').set('lifecycle', O, doc); });
  const run = (text, extra) => orchestrator.handle(Object.assign({ text, history: [], tenantId: O, sessionId: 's' }, extra || {}), {});
  assert.equal(orchestrator.detectIntent('Quels prospects doivent être relancés aujourd\'hui ?'), 'lifecycle');
  const c = await run('Quelles sont les commandes livrées sans suivi ?');
  assert.match(c.text, /Commandes livrées sans suivi \(1\)/); assert.match(c.text, /Gina/);
  const why = await run('Pourquoi cette relance n\'a pas été envoyée à Gina ?');
  assert.match(why.text, /POST_DELIVERY/);
  const none = await run('Pourquoi cette relance n\'a pas été envoyée à Zoé ?');
  assert.match(none.text, /aucune relance planifiée/i);
  const me = await run('Que peux-tu faire ?');
  assert.equal(me.intent, 'selfknow'); assert.ok(self.isFirstPerson(me.text));
  const g1 = await run('Guide-moi pour configurer mon service métier');
  assert.equal(g1.intent, 'guide'); assert.equal(g1.isPlanningQuestion, true);
  const g2 = await run('c\'est fait', { lastAssistantMessage: g1 });
  assert.match(g2.text, /n'est pas encore en place/);
  const ex = await run('Explique-moi comment créer une campagne');
  assert.match(ex.text, /brouillon/);
  const rep = await run('Donne-moi le rapport d\'activité');
  assert.equal(rep.intent, 'activityreport'); assert.match(rep.text, /Voici l'état réel de votre activité/);
});

// ------------------------------------------------------------------ outils du registre (autorisation du propriétaire)
test('Tool Registry : outils cycle de vie / rapport / auto-connaissance accessibles au propriétaire, pas au client', async () => {
  const P = ownerOf('mm_tools');
  const call = (name, args) => authz.runAs(P, () => toolRegistry.execute('mm_tools', name, args, {}));
  const rec = await call('recordOrder', { contactId: '22670000030', contactName: 'Hugo', items: [{ name: 'Menu', qty: 1, price: 2500 }] });
  assert.equal(rec.state, 'SUCCESS', JSON.stringify(rec.error));
  const upd = await call('updateOrderStatus', { orderId: rec.result.order.id, status: 'PAID' });
  assert.equal(upd.state, 'SUCCESS');
  const cand = await call('followUpCandidates', {});
  assert.equal(cand.state, 'SUCCESS');
  const me = await call('describeCapabilities', { question: 'Quels agents ?' });
  assert.equal(me.state, 'SUCCESS'); assert.match(me.result.text, /spécialistes/);
  const customer = authz.issuePrincipal({ tenant: 'mm_tools', role: 'CUSTOMER', channel: 'WHATSAPP', via: 'test' });
  const names = toolRegistry.list({ principal: customer }).map((t) => t.name);
  for (const n of ['recordOrder', 'updateOrderStatus', 'planFollowUp', 'linkServiceGroup', 'improvementCycle']) assert.ok(!names.includes(n), `${n} interdit à un client`);
});

test('liaison groupe ↔ Service métier : refusée sans compte connecté / sans droits admin, acceptée après vérification réelle', async () => {
  const L = 'mm_link';
  const svc = await businessServices.create(L, { name: 'Boutique' });
  const P = ownerOf(L);
  const run = (a) => authz.runAs(P, () => toolRegistry.execute(L, 'linkServiceGroup', a, {}));
  let r = await run({ service: 'Boutique', groupName: 'Clients VIP' });
  assert.notEqual(r.state, 'SUCCESS'); assert.match(JSON.stringify(r.error), /ACCOUNT_NOT_CONNECTED|pas connecté/);
  // session simulée connectée : groupe existant mais non admin, puis admin
  const waManager = require('../adapters/whatsappManager');
  let isAdmin = false;
  const orig = waManager.peek;
  waManager.peek = (t) => (t === L ? { session: { isConnected: () => true, getGroupsSummary: async () => [{ id: '123@g.us', name: 'Clients VIP', isAdmin }] } } : orig(t));
  try {
    r = await run({ service: 'Boutique', groupName: 'Clients VIP' });
    assert.notEqual(r.state, 'SUCCESS'); assert.match(JSON.stringify(r.error), /NOT_ADMIN|administrateur/);
    assert.equal((await businessServices.get(L, svc.id)).groups.length, 0, 'rien de lié sans droits admin');
    r = await run({ service: 'Boutique', groupName: 'Groupe inconnu' });
    assert.match(JSON.stringify(r.error), /GROUP_NOT_FOUND|Aucun groupe/);
    isAdmin = true;
    r = await run({ service: 'Boutique', groupName: 'Clients VIP' });
    assert.equal(r.state, 'SUCCESS', JSON.stringify(r.error));
    const s = await businessServices.get(L, svc.id);
    assert.equal(s.groups.length, 1); assert.equal(s.groups[0].verified.admin, true);
  } finally { waManager.peek = orig; }
});

// ------------------------------------------------------------------ Rapport & Activité + amélioration
test('Rapport & Activité : données réelles, statuts, filtres, isolation stricte entre comptes', async () => {
  const A = 'mm_rep_a'; const B = 'mm_rep_b';
  const empty = await intel.buildReport(A);
  assert.equal(empty.empty, true); assert.match(empty.note, /je n'invente rien/);
  const o1 = await lifecycle.recordOrder(A, { serviceId: 'svc1', serviceName: 'Resto', contact: client('22670000040', 'Ines') });
  await lifecycle.setOrderStatus(A, o1.id, 'PAID'); await lifecycle.setOrderStatus(A, o1.id, 'DELIVERED');
  const o2 = await lifecycle.recordOrder(A, { serviceId: 'svc2', serviceName: 'Traiteur', contact: client('22670000041', 'Jo') });
  await lifecycle.setOrderStatus(A, o2.id, 'PAYMENT_PENDING');
  await lifecycle.openCase(B, { contact: client('22670000099', 'Autre'), category: 'produit', summary: 'secret du compte B' });
  const rep = await intel.buildReport(A);
  assert.ok(rep.totals.DONE >= 1); assert.ok(rep.totals.BLOCKED >= 1, 'paiement en attente = bloqué');
  assert.ok(!JSON.stringify(rep).includes('secret du compte B'), 'aucune fuite entre comptes');
  const svc1 = await intel.buildReport(A, { serviceId: 'svc1' });
  assert.ok(svc1.total > 0 && svc1.sections.done.concat(svc1.sections.notDone, svc1.sections.blocked).every((i) => i.serviceId === 'svc1'));
  const byClient = await intel.buildReport(A, { client: 'jo' });
  assert.ok(byClient.total > 0 && [].concat(...Object.values(byClient.sections)).every((i) => /Jo/.test(i.contact && i.contact.name)));
  const blockedOnly = await intel.buildReport(A, { status: 'BLOCKED' });
  assert.ok(blockedOnly.total > 0 && blockedOnly.totals.DONE === 0);
  const noneInB = await intel.buildReport(B, { serviceId: 'svc1' });
  assert.equal(noneInB.total, 0);
});

test('auto-amélioration contrôlée : observation → diagnostic → recommandation → action sûre autorisée → mesure avant/après', async () => {
  const I = 'mm_improve';
  const o = await lifecycle.recordOrder(I, { contact: client('22670000050', 'Kim') });
  await lifecycle.setOrderStatus(I, o.id, 'PAID'); await lifecycle.setOrderStatus(I, o.id, 'DELIVERED');
  const storage = require('../ai-engine/storageAdapter');
  const doc = await storage.get('lifecycle', I); for (const f of Object.values(doc.followUps)) f.status = 'CANCELLED'; await storage.set('lifecycle', I, doc); // « livrée sans suivi »
  const { created } = await intel.refresh(I);
  const rec = created.find((r) => r.key === 'DELIVERED_WITHOUT_FOLLOWUP');
  assert.ok(rec, 'le manque est observé sur les données réelles'); assert.equal(rec.kind, 'AUTO_SAFE'); assert.equal(rec.baseline, 1);
  assert.match(rec.diagnostic, /suivi/);
  assert.equal((await intel.refresh(I)).created.length, 0, 'pas de doublon de recommandation');
  // non autorisé : rien n'est appliqué
  const refused = await intel.apply(I, rec.id, {});
  assert.equal(refused.ok, false); assert.equal(refused.error, 'NOT_AUTHORIZED');
  assert.equal((await intel.metric(I, 'DELIVERED_WITHOUT_FOLLOWUP')), 1);
  // autorisée : le suivi est planifié (l'envoi restera soumis aux 10 vérifications)
  const ok = await intel.apply(I, rec.id, { authorized: true });
  assert.equal(ok.ok, true); assert.equal(ok.changed.length, 1);
  const m = await intel.measure(I, rec.id);
  assert.equal(m.item.result.measurable, true); assert.equal(m.item.result.before, 1); assert.equal(m.item.result.after, 0); assert.equal(m.item.result.improved, true);
  assert.equal(m.item.status, 'MEASURED');
  const rep = await intel.buildReport(I);
  assert.ok(rep.totals.IMPROVED >= 1, 'apparaît comme amélioré avec son résultat');
  assert.ok(rep.sections.improved.some((i) => i.result && i.result.improved));
});

test('auto-amélioration : changement technique jamais automatique ; changement de réglage seulement avec validation', async () => {
  const J = 'mm_improve2';
  const storage = require('../ai-engine/storageAdapter');
  await storage.set('improvements', J, { tenant: J, items: [
    { id: 'imp_tech', key: 'TASKS_FAILING', kind: 'TECHNICAL', status: 'PROPOSED', createdAt: Date.now(), recommendation: 'examiner', observation: 'x' },
    { id: 'imp_auth', key: 'FOLLOWUPS_WAITING_AUTH', kind: 'NEEDS_VALIDATION', status: 'PROPOSED', createdAt: Date.now(), recommendation: 'autoriser', observation: 'y', baseline: 2 },
  ] });
  const tech = await intel.apply(J, 'imp_tech', { authorized: true, approvedByOwner: true });
  assert.equal(tech.ok, false); assert.equal(tech.error, 'TECHNICAL_CHANGE_NEVER_AUTOMATIC');
  const noVal = await intel.apply(J, 'imp_auth', { authorized: true });
  assert.equal(noVal.ok, false); assert.equal(noVal.error, 'OWNER_VALIDATION_REQUIRED');
  assert.notEqual((await autoResponder.getSettings(J)).followUps, true);
  const val = await intel.apply(J, 'imp_auth', { approvedByOwner: true });
  assert.equal(val.ok, true); assert.equal((await autoResponder.getSettings(J)).followUps, true);
});

test('analyse par les spécialistes : sans donnée réelle, aucune analyse fabriquée', async () => {
  const r = await intel.analyzeWithAgents('mm_no_data');
  assert.equal(r.available, false); assert.equal(r.reason, 'NO_DATA');
});
