// TEST RUNNER — Services Métiers : coffre chiffré, registre, test de connexion,
// et clé du coffre effectivement utilisée par le connecteur.
//   node --test test/business-services.test.js
// Isolé : stockage temporaire, clé de coffre fixée, HTTP moqué — zéro réseau réel.

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-svc-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.SECRET_VAULT_KEY = 'test-vault-key-123';

const secretVault = require('../ai-engine/secretVault');
const businessServices = require('../ai-engine/businessServices');
const connectorManager = require('../ai-engine/connectors/connectorManager');

test('secretVault : chiffré au repos, jamais en clair sur le disque', async () => {
  const t = 'tV';
  await secretVault.setSecret(t, 'k1', 'sk_live_SECRET_VALUE');
  // Le fichier stocké ne doit PAS contenir la valeur en clair.
  const file = path.join(TMP, 'secret_vault', 'tV.json');
  const raw = fs.readFileSync(file, 'utf8');
  assert.ok(!raw.includes('sk_live_SECRET_VALUE'), 'secret jamais en clair sur disque');
  assert.equal(await secretVault.getSecret(t, 'k1'), 'sk_live_SECRET_VALUE', 'déchiffrable côté serveur');
  assert.equal(await secretVault.hasSecret(t, 'k1'), true);
  assert.deepEqual(await secretVault.listRefs(t), ['k1']);
  await secretVault.revoke(t, 'k1');
  assert.equal(await secretVault.getSecret(t, 'k1'), null, 'révoqué');
});

test('businessServices : CRUD + la clé n\'est jamais dans la fiche service', async () => {
  const t = 'tS';
  const svc = await businessServices.create(t, { name: 'Ma Formation', type: 'formation', project: 'Formation en ligne', connection: { kind: 'api', connectorType: 'platform_gateway', baseUrl: 'https://riea.example', authHeader: 'X-API-Key' }, scopes: ['students:create', 'students:suspend'], commercial: { price: 15000, currency: 'FCFA', description: 'Formation cuisine' } });
  assert.ok(svc.id);
  assert.equal(svc.connection.hasKey, false);
  const conn = await businessServices.connectApi(t, svc.id, { apiKey: 'sk_live_TESTKEY' });
  assert.equal(conn.ok, true);
  assert.equal(conn.hasKey, true);
  // La fiche service persistée ne contient QUE la référence, pas la clé.
  const rawSvc = fs.readFileSync(path.join(TMP, 'business_services', 'tS.json'), 'utf8');
  assert.ok(!rawSvc.includes('sk_live_TESTKEY'), 'clé jamais dans la fiche service');
  assert.ok(rawSvc.includes('service_' + svc.id), 'référence de coffre stockée');
  const view = await businessServices.get(t, svc.id);
  assert.equal(view.connection.hasKey, true);
});

test('businessServices : test de connexion RÉEL (mock fetch) -> CONNECTED sur 404', async () => {
  const t = 'tT';
  const savedFetch = global.fetch;
  const calls = [];
  global.fetch = async (url, init) => { calls.push({ url, init }); return { status: 404, ok: false, json: async () => ({ error: 'Compte introuvable.' }) }; };
  try {
    const svc = await businessServices.create(t, { name: 'RIEA', type: 'formation', connection: { kind: 'api', connectorType: 'platform_gateway', baseUrl: 'https://riea.example' } });
    await businessServices.connectApi(t, svc.id, { apiKey: 'sk_live_X' });
    const res = await businessServices.testConnection(t, svc.id);
    assert.equal(res.result.status, 'CONNECTED', JSON.stringify(res));
    assert.equal(res.status, 'CONNECTED');
    // La clé a bien été envoyée dans l'en-tête d'auth réel.
    assert.equal(calls[0].init.headers['X-API-Key'], 'sk_live_X');
  } finally { global.fetch = savedFetch; }
});

test('bout-en-bout : service configuré -> connecteur utilise la clé DU COFFRE', async () => {
  const t = 'tE2E';
  const svc = await businessServices.create(t, { name: 'Plateforme', type: 'formation', connection: { kind: 'api', connectorType: 'platform_gateway', baseUrl: 'https://riea.example', endpoints: { enroll: '/api/v1/agent-gateway/enroll-student', suspend: '/api/v1/agent-gateway/suspend-student' } }, scopes: ['students:create', 'students:suspend'] });
  await businessServices.connectApi(t, svc.id, { apiKey: 'sk_live_FROM_VAULT' });
  await businessServices.syncToConnectors(t);
  // Les capacités du service sont exposées au moteur pour ce tenant.
  const tools = await connectorManager.getToolsForTenant(t);
  assert.ok(tools.some((x) => x.name === 'creer_compte_eleve'), 'capacité exposée');
  // Exécution : le connecteur doit utiliser la clé DU COFFRE (pas .env).
  const calls = [];
  const mockHttp = async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ account_created: true }) }; };
  const out = await connectorManager.executeTool(t, 'creer_compte_eleve', { email: 'x@y.com', course_id: 'c1' }, { http: mockHttp });
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.equal(calls[0].init.headers['X-API-Key'], 'sk_live_FROM_VAULT', 'clé issue du coffre chiffré');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
