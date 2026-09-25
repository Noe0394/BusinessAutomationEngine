'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-missions-'));
process.env.AI_ENGINE_STORAGE_DIR = ROOT;
process.env.SECRET_VAULT_KEY = 'test-mission-vault';

const authz = require('../ai-engine/authz');
const businessServices = require('../ai-engine/businessServices');
const missions = require('../ai-engine/missionOrchestrator');
const registry = require('../ai-engine/toolRegistry');
const storage = require('../ai-engine/storageAdapter');
const chatOrchestrator = require('../ai-engine/chatOrchestrator');
const TENANT = 'mission-test';
const principal = authz.issuePrincipal({ tenant: TENANT, role: 'OWNER', channel: 'WEB', via: 'test' });

test('mission complexe : un appel de planification puis outils déterministes vérifiés', async () => {
  await businessServices.create(TENANT, {
    name: 'Cuisine',
    products: [
      { name: 'Formation Cuisine', price: 12500 },
      { name: 'Formation Pâtisserie', price: 18000 },
    ],
    commercial: { currency: 'FCFA' },
  });
  const catalog = await authz.runAs(principal, () => registry.execute(TENANT, 'getBusinessServices', {}, { principal, permissions: [] }));
  const configuredOffer = catalog.result.services.find((service) => service.name === 'Cuisine');
  assert.equal(configuredOffer.hasConfiguredPrice, true);
  assert.deepEqual(configuredOffer.products, [
    { name: 'Formation Cuisine', price: 12500 },
    { name: 'Formation Pâtisserie', price: 18000 },
  ]);
  let aiCalls = 0;
  const llm = async () => {
    aiCalls += 1;
    return JSON.stringify({ needsInput: false, steps: [
      { id: 'prix_cuisine', tool: 'getProductPrice', args: { query: 'Formation Cuisine' }, label: 'Vérifier le prix Cuisine' },
      { id: 'prix_patisserie', tool: 'getProductPrice', args: { query: 'Formation Pâtisserie' }, label: 'Vérifier le prix Pâtisserie' },
    ] });
  };
  const result = await authz.runAs(principal, () => missions.start({
    text: 'Organise la vérification des tarifs des deux formations.',
    tenantId: TENANT, sessionId: 'mission-test-session', channel: 'CHAT',
  }, { llm, permissions: ['messages:send'] }));
  assert.equal(aiCalls, 1);
  assert.equal(result.state, 'completed');
  const persisted = await missions.get(TENANT, result.missionId);
  assert.equal(persisted.steps.length, 2);
  assert.deepEqual(persisted.steps.map((s) => s.state), ['SUCCESS', 'SUCCESS']);
  assert.deepEqual(persisted.steps.map((s) => s.result.price), [12500, 18000]);
});

test('mission : attend seulement les informations manquantes puis reprend sans rejouer les étapes réussies', async () => {
  const answers = [
    JSON.stringify({ needsInput: true, question: 'Quel canal dois-je utiliser ?', steps: [] }),
    JSON.stringify({ needsInput: false, steps: [
      { id: 'price', tool: 'getProductPrice', args: { query: 'Formation Cuisine' }, label: 'Lire le prix configuré' },
    ] }),
  ];
  let calls = 0;
  const deps = { llm: async () => { calls += 1; return answers.shift(); }, permissions: ['messages:send'] };
  const first = await authz.runAs(principal, () => missions.start({
    text: 'Organise cette mission commerciale.',
    tenantId: TENANT, sessionId: 'mission-input-session', channel: 'TELEGRAM',
  }, deps));
  assert.equal(first.state, 'waiting_input');
  assert.equal(first.isPlanningQuestion, true);
  assert.match(first.text, /Quel canal/);
  const resumed = await authz.runAs(principal, () => missions.resume({
    tenantId: TENANT, id: first.missionId, answer: 'WhatsApp',
  }, deps));
  assert.equal(calls, 2);
  assert.equal(resumed.state, 'completed');
  const persisted = await missions.get(TENANT, first.missionId);
  assert.equal(persisted.steps.filter((s) => s.state === 'SUCCESS').length, 1);
});

test('objectif de vente : une lecture seule ne peut pas être déclarée comme vente accomplie', async () => {
  const answers = [
    JSON.stringify({ needsInput: false, steps: [
      { id: 'offer', tool: 'getProductPrice', args: { query: 'Formation Cuisine' }, label: 'Vérifier l’offre configurée' },
    ] }),
    JSON.stringify({ needsInput: true, question: 'Quelle liste de contacts dois-je utiliser ?', steps: [] }),
  ];
  let calls = 0;
  const result = await authz.runAs(principal, () => missions.start({
    text: 'Vends la formation Cuisine à 10 nouveaux clients.',
    tenantId: TENANT, sessionId: 'mission-sales-session', channel: 'WHATSAPP',
  }, { llm: async () => { calls += 1; return answers.shift(); }, permissions: ['messages:send'] }));
  assert.equal(calls, 2);
  assert.equal(result.state, 'waiting_input', JSON.stringify(result));
  assert.match(result.text, /Quelle liste de contacts/);
  assert.doesNotMatch(result.text, /terminée/);
});

test('les outils de mission sont enregistrés dans le registre commun', () => {
  const names = registry.describe().map((tool) => tool.name);
  for (const name of ['getObjectiveMission', 'pauseObjectiveMission', 'resumeObjectiveMission', 'stopObjectiveMission']) assert.ok(names.includes(name), name);
});

test('après redémarrage une campagne en pause reste en pause jusqu’à une demande explicite', async () => {
  const id = 'mission-restart-pause';
  let campaignStatus = 'paused';
  let resumeCalls = 0;
  const previousExecute = registry.execute;
  storage.set(missions.NS, TENANT, { tenant: TENANT, missions: { [id]: {
    id, tenant: TENANT, sessionId: 'restart', channel: 'WHATSAPP', objective: 'Vendre la formation Cuisine',
    state: 'monitoring', steps: [{ id: 'launch', tool: 'launchCampaign', state: 'SUCCESS',
      args: { draftId: 'draft-restart' }, executedArgs: { draftId: 'draft-restart' },
      result: { campaignId: 'campaign-restart', channel: 'WHATSAPP' } }],
    progress: [], createdAt: Date.now(), updatedAt: Date.now(),
  } } });
  registry.execute = async (_tenant, name) => {
    if (name === 'getCampaignStatus') return { state: 'SUCCESS', result: { status: campaignStatus, total: 8, sent: 2, failed: 0, pendingCount: 6 } };
    if (name === 'resumeCampaign') { resumeCalls += 1; campaignStatus = 'running'; return { state: 'SUCCESS', result: { resumed: true } }; }
    if (name === 'pauseCampaign') { campaignStatus = 'paused'; return { state: 'SUCCESS', result: { paused: true } }; }
    return { state: 'SUCCESS', result: {} };
  };
  try {
    await authz.runAs(principal, () => missions.recoverMonitoring(TENANT, id, { permissions: ['messages:send'] }));
    assert.equal(resumeCalls, 0, 'la reprise après redémarrage ne doit pas lancer d’envoi');
    assert.equal((await missions.get(TENANT, id)).progress[0].status, 'paused');

    const resumed = await authz.runAs(principal, () => missions.control({ tenantId: TENANT, id, action: 'resume' }, { permissions: ['messages:send'] }));
    assert.equal(resumeCalls, 1);
    assert.equal(resumed.state, 'monitoring');
    await authz.runAs(principal, () => missions.control({ tenantId: TENANT, id, action: 'pause' }, { permissions: ['messages:send'] }));
  } finally { registry.execute = previousExecute; }
});

test('Chat Intelligent envoie un objectif explicite au planificateur persistant partagé', async () => {
  assert.equal(chatOrchestrator.detectIntent('Aujourd’hui, je veux vendre 10 accès à ma formation Cuisine.'), 'goal');
  let aiCalls = 0;
  const result = await authz.runAs(principal, () => chatOrchestrator.handle({
    text: 'Aujourd’hui, je veux vendre 10 accès à ma formation Cuisine.',
    tenantId: TENANT, sessionId: 'chat-objective-session', principal,
  }, { llm: async () => { aiCalls += 1; return JSON.stringify({ needsInput: true, question: 'Quelle liste dois-je cibler ?', steps: [] }); } }));
  assert.equal(aiCalls, 1);
  assert.equal(result.state, 'waiting_input', JSON.stringify(result));
  assert.match(result.text, /Quelle liste/);
});
