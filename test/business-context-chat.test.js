// TEST — Maillon DONNÉES → INTELLIGENCE : le chat lit réellement les données
// du Service Métier (prix, produits, règles, objectifs) au lieu de les inventer.
//   node --test test/business-context-chat.test.js
// Isolé : stockage temporaire, aucun réseau (on teste le rendu du contexte et
// le routage d'intention, PAS l'appel LLM lui-même).

'use strict';

require('./helpers/auth').actAsAdmin(); // identité authentifiée de test (deny-by-default : voir ai-engine/authz.js)
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-bizchat-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.SECRET_VAULT_KEY = 'test-vault-key-bizchat';

const businessServices = require('../ai-engine/businessServices');
const chatOrchestrator = require('../ai-engine/chatOrchestrator');

test('getEngineContextText expose produits + prix + règles + objectifs réels', async () => {
  const t = 'tCtx';
  await businessServices.create(t, {
    name: 'Ma Formation', type: 'formation', project: 'Formation en ligne',
    commercial: { price: 8000, currency: 'FCFA', description: 'Cuisine africaine', target: 'restaurateurs' },
    products: [{ name: 'Formation Épicerie et Bouillon', price: 8000 }, { name: 'Formation Pâtisserie', price: 12000 }],
    rules: ['Jamais plus de 10% de remise'],
    objectives: ['Vendre 10 formations par semaine'],
    scopes: ['students:create'],
  });
  const txt = await businessServices.getEngineContextText(t);
  assert.match(txt, /Formation Épicerie et Bouillon\s*:\s*8000/, 'le prix réel du produit figure dans le contexte : ' + txt);
  assert.match(txt, /Formation Pâtisserie\s*:\s*12000/);
  assert.match(txt, /10%\s+de\s+remise/, 'la règle figure');
  assert.match(txt, /Vendre 10 formations/, 'l\'objectif figure');
  assert.match(txt, /students:create/, 'la capacité autorisée figure');
});

test('getEngineContextText vide s\'il n\'y a aucun service (pas d\'invention)', async () => {
  const txt = await businessServices.getEngineContextText('tVide');
  assert.equal(txt, '');
});

test('detectIntent route une question factuelle vers "businessinfo"', () => {
  assert.equal(chatOrchestrator.detectIntent('Quel est le prix de ma formation Épicerie et Bouillon ?'), 'businessinfo');
  assert.equal(chatOrchestrator.detectIntent('c\'est combien ma formation ?'), 'businessinfo');
  assert.equal(chatOrchestrator.detectIntent('montre-moi mes produits'), 'businessinfo');
  assert.equal(chatOrchestrator.detectIntent('quels sont mes objectifs ?'), 'businessinfo');
});

test('detectIntent NE capte PAS un ordre d\'action comme businessinfo', () => {
  // "présente ma formation à ce client" est une ACTION, pas une consultation :
  // ne doit pas être happé par businessinfo (pas de cue de consultation).
  assert.notEqual(chatOrchestrator.detectIntent('présente ma formation à ce client'), 'businessinfo');
  // Un vrai objectif reste un objectif.
  assert.equal(chatOrchestrator.detectIntent('vends 10 formations aujourd\'hui'), 'goal');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
