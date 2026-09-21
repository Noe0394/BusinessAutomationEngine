// TEST — exécution FIABLE des ordres : gérer les Services métiers de bout en bout (créer, modifier, pause, supprimer, RESTAURER), chaque action vérifiée par relecture ;
// ordres directs instantanés ; la garde refuse « fait » quand la preuve n'est pas du bon type (lecture ≠ écriture, mauvais outil) ; fonction absente = dit clairement.
//   node --test test/verified-execution.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-verif-'));
process.env.GITHUB_TOKEN = ''; process.env.GEMINI_API_KEY = 'test-key'; process.env.SPECIALISTS_ENABLED = 'false';
require('./helpers/auth').actAsAdmin();
const toolRegistry = require('../ai-engine/toolRegistry');
const businessServices = require('../ai-engine/businessServices');
const serviceCommands = require('../ai-engine/serviceCommands');
const orchestrator = require('../ai-engine/chatOrchestrator');
const claimGuard = require('../ai-engine/claimGuard');
const agentLoop = require('../ai-engine/jarvis/agentLoop');
const { ownerOf, authz } = require('./helpers/auth');

const mk = (T) => { const P = ownerOf(T); return { P, call: (name, args) => authz.runAs(P, () => toolRegistry.execute(T, name, args, {})) }; };
const names = async (T) => (await businessServices.list(T)).map((s) => s.name);

test('OUTILS : supprimer (vérifié par relecture) puis RESTAURER ; corbeille visible ; ambigu / introuvable = messages clairs', async () => {
  const T = 'v1'; const { call } = mk(T);
  await businessServices.create(T, { name: 'Formation Grillade', products: [{ name: 'Cours', price: 5000 }], commercial: { price: 5000 } });
  await businessServices.create(T, { name: 'Formation Pâtisserie' });
  let r = await call('deleteBusinessService', { service: 'Formation' }); assert.equal(r.state, 'FAILED'); assert.match(r.error.message, /Plusieurs services/);
  r = await call('deleteBusinessService', { service: 'Boulangerie' }); assert.equal(r.state, 'FAILED'); assert.match(r.error.message, /Vos services/);
  r = await call('deleteBusinessService', { service: 'Grillade' });
  assert.equal(r.state, 'SUCCESS'); assert.equal(r.verified, true); assert.equal(r.risk, 'LOW_WRITE'); assert.ok(!(await names(T)).includes('Formation Grillade'));
  r = await call('listDeletedBusinessServices', {}); assert.equal(r.result.count, 1);
  r = await call('restoreBusinessService', { service: 'Grillade' });
  assert.equal(r.state, 'SUCCESS'); assert.ok((await names(T)).includes('Formation Grillade'));
  const back = (await businessServices.list(T)).find((s) => s.name === 'Formation Grillade'); assert.equal(back.products[0].price, 5000, 'données restaurées à l\'identique');
  r = await call('restoreBusinessService', {}); assert.equal(r.state, 'FAILED'); assert.match(r.error.message, /Aucun service supprimé/);
});

test('OUTILS : pause / réactivation / modification vérifiées ; configureBusinessService ne DUPLIQUE plus un service existant', async () => {
  const T = 'v2'; const { call } = mk(T);
  await businessServices.create(T, { name: 'Boutique', commercial: { price: 1000 } });
  let r = await call('setBusinessServiceStatus', { service: 'Boutique', status: 'paused' }); assert.equal(r.state, 'SUCCESS'); assert.equal((await businessServices.list(T))[0].lifecycle, 'paused');
  r = await call('setBusinessServiceStatus', { service: 'Boutique', status: 'nimporte' }); assert.equal(r.state, 'FAILED');
  r = await call('setBusinessServiceStatus', { service: 'Boutique', status: 'active' }); assert.equal(r.state, 'SUCCESS');
  r = await call('updateBusinessService', { service: 'Boutique', price: 2500, addProducts: 'Robe|8000; Sac|5000', name: 'Boutique Awa' });
  assert.equal(r.state, 'SUCCESS'); const s = (await businessServices.list(T))[0]; assert.equal(s.name, 'Boutique Awa'); assert.equal(s.commercial.price, 2500); assert.equal(s.products.length, 2);
  r = await call('updateBusinessService', { service: 'Boutique Awa', removeProducts: 'Sac' }); assert.equal(r.state, 'SUCCESS'); assert.deepEqual((await businessServices.list(T))[0].products.map((p) => p.name), ['Robe']);
  r = await call('configureBusinessService', { name: 'Boutique Awa', price: 3000 }); assert.equal(r.state, 'SUCCESS'); assert.equal(r.result.updated, true);
  assert.equal((await businessServices.list(T)).length, 1, 'aucun doublon'); assert.equal((await businessServices.list(T))[0].commercial.price, 3000);
  r = await call('updateBusinessService', { service: 'Boutique Awa' }); assert.equal(r.state, 'FAILED'); assert.match(r.error.message, /ce qu'il faut modifier/);
});

test("ORDRES DIRECTS : « supprime le service X » exécuté et VÉRIFIÉ sans IA, compte rendu sur l'état réel ; multiples, tous, sans nom, restauration", async () => {
  const T = 'v3'; const P = ownerOf(T);
  for (const n of ['Formation Grillade', 'Épicerie et Charcuterie', 'Traiteur']) await businessServices.create(T, { name: n });
  const run = (text) => orchestrator.handle({ text, history: [], tenantId: T, sessionId: 's', principal: P }, {});
  assert.equal(orchestrator.detectIntent('Supprime le service Traiteur'), 'svccmd');
  let r = await run('Supprime le service Traiteur');
  assert.equal(r.intent, 'svccmd'); assert.match(r.text, /✅ Service « Traiteur » supprimé — vérifié/); assert.match(r.text, /Vos services actuels \(2\)/); assert.ok(!(await names(T)).includes('Traiteur'));
  assert.equal(r.actionLog[0].status, 'done');
  r = await run('Supprime le service métier « Épicerie et Charcuterie » s\'il te plaît');
  assert.match(r.text, /Épicerie et Charcuterie » supprimé/); assert.equal((await names(T)).length, 1, 'un nom contenant « et » reste UN service');
  r = await run('Supprime le service Boulangerie'); assert.match(r.text, /❌/); assert.match(r.text, /Vos services/); assert.equal((await names(T)).length, 1);
  r = await run('supprime tous les services'); assert.match(r.text, /Par sécurité/); assert.equal((await names(T)).length, 1, 'jamais de suppression de masse sur un ordre');
  r = await run('Supprime le service'); assert.match(r.text, /Quel service/);
  r = await run('Restaure le service Traiteur'); assert.match(r.text, /✅ Service « Traiteur » restauré — vérifié/); assert.ok((await names(T)).includes('Traiteur'));
  r = await run('Mets le service Traiteur en pause'); assert.match(r.text, /mis en pause — vérifié/); assert.equal((await businessServices.list(T)).find((s) => s.name === 'Traiteur').lifecycle, 'paused');
  r = await run('Réactive le service Traiteur'); assert.match(r.text, /réactivé/);
  await businessServices.create(T, { name: 'Alpha Cours' }); await businessServices.create(T, { name: 'Beta Cours' });
  r = await run('Supprime les services Alpha Cours et Beta Cours'); assert.match(r.text, /Alpha Cours » supprimé/); assert.match(r.text, /Beta Cours » supprimé/);
  assert.equal(orchestrator.detectIntent('Supprime ce contact'), null === orchestrator.detectIntent('Supprime ce contact') ? orchestrator.detectIntent('Supprime ce contact') : null, 'un autre sujet n\'est pas capté');
});

test("GARDE : une LECTURE ne prouve pas une écriture ; le mauvais outil non plus ; le bon outil vérifié oui ; un échec ne prouve rien", () => {
  const claim = "C'est fait, le service Formation X est supprimé."; const req = 'Supprime le service Formation X';
  assert.equal(claimGuard.guard(claim, { toolCalls: [{ name: 'getBusinessServices', state: 'SUCCESS', risk: 'READ' }] }, { request: req }).blocked, true, 'lecture seule');
  assert.equal(claimGuard.guard(claim, { toolCalls: [{ name: 'configureBusinessService', state: 'SUCCESS', risk: 'LOW_WRITE' }] }, { request: req }).blocked, true, 'mauvais outil (création ≠ suppression)');
  assert.equal(claimGuard.guard(claim, { toolCalls: [{ name: 'deleteBusinessService', state: 'UNCONFIRMED', risk: 'LOW_WRITE' }] }, { request: req }).blocked, true, 'non confirmé');
  assert.equal(claimGuard.guard(claim, { toolCalls: [{ name: 'deleteBusinessService', state: 'SUCCESS', risk: 'LOW_WRITE' }] }, { request: req }).blocked, false, 'bon outil, vérifié');
  const g = claimGuard.guard(claim, null, { request: req }); assert.equal(g.blocked, true); assert.match(g.text, /deleteBusinessService/, 'dit quelle fonction existe');
  const noTool = claimGuard.guard("C'est fait, le compte comptable est synchronisé et validé.", null, { request: 'Synchronise mon compte comptable Sage' });
  assert.equal(noTool.blocked, true); assert.match(noTool.text, /ne fait pas partie de mes fonctions|n'ai pas de fonction/);
});

test("AGENT : plan avec une seule LECTURE puis « c'est fait » du modèle = bloqué ; aucune fonction pour l'action = dit clairement ; simple conversation = rendue à la discussion ; outil correct = confirmé avec preuve", async () => {
  const T = 'v4'; const { P } = mk(T); await businessServices.create(T, { name: 'Formation Grillade' });
  const scripted = (plans, answer) => { let i = 0; return async (prompt) => (/Réponds UNIQUEMENT en JSON/.test(prompt) ? plans[Math.min(i++, plans.length - 1)] : answer); };
  const run = (text, llm) => authz.runAs(P, () => agentLoop.runAgentLoop({ text, history: [], tenantId: T, sessionId: 's' }, { llm, rawText: text }));
  let r = await run('Supprime le service Formation Grillade', scripted(['{"tool":"getBusinessServices","args":{}}', '{"done":true}'], "C'est fait, le service Formation Grillade est supprimé."));
  assert.doesNotMatch(r.text, /c'est fait, le service/i); assert.match(r.text, /Je n'ai rien exécuté/); assert.ok((await names(T)).includes('Formation Grillade'));
  r = await run('Synchronise mon compte comptable Sage', scripted(['{"tool":null,"impossible":true}'], 'x'));
  assert.equal(r.impossible, true); assert.match(r.text, /Je n'ai rien exécuté/);
  r = await run('Envoie un dossier à la mairie', scripted(['{"tool":null}'], 'x')); assert.equal(r.impossible, true, 'une action sans outil ne retombe jamais sur la conversation libre');
  r = await run('Bonjour comment vas-tu', scripted(['{"tool":null}'], 'x')); assert.equal(r, null);
  r = await run('Supprime le service Formation Grillade', scripted(['{"tool":"deleteBusinessService","args":{"service":"Formation Grillade"}}', '{"done":true}'], "C'est fait, le service est supprimé."));
  assert.match(r.text, /C'est fait/); assert.match(r.text, /✔ Vérifié : deleteBusinessService/); assert.ok(!(await names(T)).includes('Formation Grillade'));
});
