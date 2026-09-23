// TEST RUNNER — Services Métiers : coffre chiffré, registre, test de connexion,
// et clé du coffre effectivement utilisée par le connecteur.
//   node --test test/business-services.test.js
// Isolé : stockage temporaire, clé de coffre fixée, HTTP moqué — zéro réseau réel.

'use strict';

require('./helpers/auth').actAsAdmin(); // identité authentifiée de test (deny-by-default : voir ai-engine/authz.js)
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

// ---------------------------------------------------------------------------
// MÉMOIRE MÉTIER EN TEXTE LIBRE (refonte 2026-09-23) : un service peut être créé/modifié avec SEULEMENT un
// texte libre ("memo"), duquel les champs structurés (prix, description, paiement...) sont extraits
// automatiquement — jamais bloquant, jamais destructeur des champs déjà explicitement renseignés.
const axios = require('axios');
const okGemini = (t) => ({ data: { candidates: [{ content: { parts: [{ text: t }] } }] } });
function mockAxiosOnce(handler) {
  const orig = axios.post;
  axios.post = async (url, body, cfg) => handler(String(url), body);
  return () => { axios.post = orig; };
}

test('Service créé UNIQUEMENT avec un mémo libre : extraction automatique des champs structurés', async () => {
  const t = 'tMemo1';
  process.env.GEMINI_API_KEY = 'test-key';
  const restore = mockAxiosOnce(() => okGemini(JSON.stringify({
    price: 8000, promoPrice: 5000, currency: 'FCFA', description: 'Formation Épicerie et Bouillon',
    advantages: null, paymentTerms: 'Wave au 07 00 00 00 00 au nom de Awa', target: null,
    period: 'Promo jusqu\'au 25 septembre', accessTerms: null,
  })));
  try {
    const svc = await businessServices.create(t, {
      name: 'Formation Épicerie',
      commercial: { memo: 'Je propose une formation Épicerie et Bouillon à 8 000 FCFA. Promotion à 5 000 FCFA jusqu\'au 25 septembre. Paiement Wave au 07 00 00 00 00 au nom de Awa.' },
    });
    assert.equal(svc.commercial.memo, 'Je propose une formation Épicerie et Bouillon à 8 000 FCFA. Promotion à 5 000 FCFA jusqu\'au 25 septembre. Paiement Wave au 07 00 00 00 00 au nom de Awa.', 'le mémo brut est conservé VERBATIM');
    assert.equal(svc.commercial.price, 8000, 'prix extrait du mémo');
    assert.equal(svc.commercial.promoPrice, 5000, 'promo extraite du mémo');
    assert.match(svc.commercial.paymentTerms, /Wave/, 'moyen de paiement extrait du mémo');
    assert.match(svc.commercial.period, /25 septembre/, 'période extraite du mémo');
    // Le mémo apparaît aussi tel quel dans le contexte injecté au LLM (rien n'est jamais perdu).
    const text = await businessServices.getEngineContextText(t);
    assert.match(text, /Mémoire de l'activité/);
    assert.match(text, /Épicerie et Bouillon/);
  } finally { restore(); delete process.env.GEMINI_API_KEY; }
});

test('extraction du mémo : ne touche JAMAIS un champ déjà explicitement renseigné (le mémo peut dire autre chose, le champ structuré prime)', async () => {
  const t = 'tMemo2';
  process.env.GEMINI_API_KEY = 'test-key';
  const restore = mockAxiosOnce(() => okGemini(JSON.stringify({ description: 'Devrait être ignoré' })));
  try {
    const svc = await businessServices.create(t, {
      name: 'Service explicite',
      commercial: { description: 'Description choisie explicitement par le vendeur', memo: 'Un mémo qui parle d\'autre chose.' },
    });
    assert.equal(svc.commercial.description, 'Description choisie explicitement par le vendeur', 'le champ structuré déjà rempli n\'est jamais écrasé par l\'extraction');
  } finally { restore(); delete process.env.GEMINI_API_KEY; }
});

test('extraction du mémo : échec/indisponibilité de l\'IA -> JAMAIS bloquant, le mémo brut reste sauvegardé', async () => {
  const t = 'tMemo3';
  delete process.env.GEMINI_API_KEY; delete process.env.GROQ_API_KEY; delete process.env.OPENROUTER_API_KEY;
  delete process.env.HUGGINGFACE_API_KEY; delete process.env.DEEPSEEK_API_KEY; delete process.env.OPENAI_API_KEY;
  delete process.env.MISTRAL_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  // Aucune clé IA configurée -> la cascade retombe sur Pollinations (repli public) : on le bloque ici pour
  // simuler une extraction totalement indisponible, sans appel réseau réel dans ce test.
  const restore = mockAxiosOnce(() => { throw new Error('offline'); });
  const origGet = axios.get;
  axios.get = async () => { throw new Error('offline'); };
  try {
    const svc = await businessServices.create(t, { name: 'Service sans IA', commercial: { memo: 'Prix 3000 FCFA, paiement Orange Money au 05 00 00 00 00.' } });
    assert.ok(svc.id, 'la création réussit malgré l\'échec total de l\'extraction');
    assert.equal(svc.commercial.memo, 'Prix 3000 FCFA, paiement Orange Money au 05 00 00 00 00.', 'le mémo brut reste consultable même sans extraction réussie');
    assert.equal(svc.commercial.price, null, 'aucun prix INVENTÉ en l\'absence d\'extraction réussie');
  } finally { restore(); axios.get = origGet; }
});

test('updateBusinessService memoAppend : ajoute au mémo SANS effacer le reste, ni les champs structurés existants', async () => {
  const t = 'tMemo4';
  const toolsServices = require('../ai-engine/toolsServices');
  process.env.GEMINI_API_KEY = 'test-key';
  const restore = mockAxiosOnce(() => okGemini(JSON.stringify({ description: null, promoPrice: null, target: null, period: null, accessTerms: null, advantages: null })));
  let svc; let r;
  try {
    svc = await businessServices.create(t, { name: 'Service à compléter', commercial: { memo: 'Premier texte.', price: 10000, paymentTerms: 'Orange Money au 05 00 00 00 00' } });
    r = await toolsServices.TOOLS.updateBusinessService.execute({ service: 'Service à compléter', memoAppend: 'Ajout : promo à 7000 FCFA jusqu\'au 30.' }, { tenant: t });
  } finally { restore(); delete process.env.GEMINI_API_KEY; }
  assert.equal(r.ok, true, JSON.stringify(r));
  const after = await businessServices.get(t, svc.id);
  assert.match(after.commercial.memo, /Premier texte\./, 'ancien mémo conservé');
  assert.match(after.commercial.memo, /promo à 7000/, 'nouvelle note ajoutée');
  assert.equal(after.commercial.price, 10000, 'champ structuré existant non affecté par un simple ajout au mémo');
  assert.equal(after.commercial.paymentTerms, 'Orange Money au 05 00 00 00 00', 'moyen de paiement existant non effacé');
});

test('updateBusinessService paymentTerms : "change mon numéro Wave" remplace le champ visé sans toucher au reste', async () => {
  const t = 'tMemo5';
  const toolsServices = require('../ai-engine/toolsServices');
  await businessServices.create(t, { name: 'Service Wave', commercial: { price: 5000, description: 'Ma description', paymentTerms: 'Wave au 01 00 00 00 00' } });
  const r = await toolsServices.TOOLS.updateBusinessService.execute({ service: 'Service Wave', paymentTerms: 'Wave au 09 99 99 99 99' }, { tenant: t });
  assert.equal(r.ok, true, JSON.stringify(r));
  const after = (await businessServices.list(t)).find((s) => s.name === 'Service Wave');
  assert.equal(after.commercial.paymentTerms, 'Wave au 09 99 99 99 99');
  assert.equal(after.commercial.price, 5000, 'prix conservé');
  assert.equal(after.commercial.description, 'Ma description', 'description conservée');
});

test('MULTI-SERVICES : le contexte de la conversation (hint) l\'emporte sur "le plus récent"', async () => {
  const t = 'tMulti1';
  await businessServices.create(t, { name: 'Formation Cuisine', commercial: { price: 8000 } });
  await businessServices.create(t, { name: 'Formation Couture', commercial: { price: 12000 } }); // créée APRÈS, donc "la plus récente"
  // Sans indice de contexte : repli sur la plus récente (comportement existant, inchangé).
  const noHint = await businessServices.getPrioritizedContext(t, { hint: '' });
  assert.equal(noHint.priority, 'Formation Couture', 'sans contexte, repli sur le service le plus récent');
  // Avec un indice de contexte (ex: service qui a suscité l'intérêt du client dans CETTE conversation, voir
  // ai-engine/autoResponder.js) : le service pertinent l'emporte, même si ce n'est pas le plus récent.
  const withHint = await businessServices.getPrioritizedContext(t, { hint: 'Formation Cuisine' });
  assert.equal(withHint.priority, 'Formation Cuisine', 'le contexte déjà engagé l\'emporte sur "le plus récent"');
});

test('Aucun champ requis hors le nom : un service peut être créé sans prix/description/paiement/API', async () => {
  const t = 'tMemo6';
  const svc = await businessServices.create(t, { name: 'Service minimal' });
  assert.ok(svc.id);
  assert.equal(svc.commercial.price, null);
  assert.equal(svc.commercial.paymentTerms, '');
  assert.equal(svc.connection.kind, 'none', 'aucune API requise');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
