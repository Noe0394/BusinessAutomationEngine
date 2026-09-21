// TEST — le Chat Intelligent comme centre d'actions : configurer un Service
// Métier, importer des contacts depuis un fichier joint, générer un média —
// via les outils du registre. Déterministe (pas d'appel IA ; generateImage moqué).
//   node --test test/chat-actions.test.js

'use strict';

require('./helpers/auth').actAsAdmin(); // identité authentifiée de test (deny-by-default : voir ai-engine/authz.js)
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-chatact-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.SECRET_VAULT_KEY = 'test-vault-chatact';

const registry = require('../ai-engine/toolRegistry');
const chatUploads = require('../ai-engine/chatUploads');
const businessServices = require('../ai-engine/businessServices');

const T = 'tChatAct';

test('configureBusinessService : crée un service métier via une instruction', async () => {
  const r = await registry.execute(T, 'configureBusinessService', {
    name: 'Formations Cuisine', type: 'formation', price: 8000, currency: 'FCFA',
    products: 'Formation Épicerie|8000; Formation Pâtisserie|12000',
    rules: 'Jamais plus de 10% de remise', objectives: 'Vendre 10 formations/semaine',
  }, {});
  assert.equal(r.state, 'SUCCESS', JSON.stringify(r));
  assert.ok(r.result.serviceId);
  const list = await businessServices.list(T);
  assert.ok(list.find((s) => s.name === 'Formations Cuisine'));
  // le prix est réellement lisible ensuite par le chat
  const price = await registry.execute(T, 'getProductPrice', { query: 'Épicerie' }, {});
  assert.equal(price.result.price, 8000);
});

test('importContactsFromFile : importe les contacts d\'un CSV joint', async () => {
  const ref = await chatUploads.save(T, { originalname: 'contacts.csv', mimetype: 'text/csv', buffer: Buffer.from('nom,telephone\nAwa,22600000001\nKoffi,22600000002\nAwa2,22600000001\n', 'utf8') });
  const r = await registry.execute(T, 'importContactsFromFile', { fileId: ref.id }, {});
  assert.equal(r.state, 'SUCCESS', JSON.stringify(r));
  assert.equal(r.result.imported, 2);
  assert.equal(r.result.duplicates, 1);
  const c = await registry.execute(T, 'countContacts', {}, {});
  assert.equal(c.result.total, 2);
});

test('generateImage : génère et rend un média téléchargeable', async () => {
  const fakeGen = async () => ({ buffer: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]), mimetype: 'image/jpeg' });
  const r = await registry.execute(T, 'generateImage', { prompt: 'affiche promo formation' }, { generateImage: fakeGen });
  assert.equal(r.state, 'SUCCESS', JSON.stringify(r));
  assert.equal(r.result.media, true);
  assert.ok(r.result.fileId);
  // le fichier est réellement récupérable pour téléchargement
  const f = await chatUploads.readFile(T, r.result.fileId);
  assert.ok(f && f.buffer && f.buffer.length > 0);
});

test('generateImage : sans moteur d\'image -> échec honnête (pas de faux succès)', async () => {
  const r = await registry.execute(T, 'generateImage', { prompt: 'x' }, {});
  assert.equal(r.state, 'FAILED');
  assert.equal(r.error.code, 'IMAGE_ENGINE_UNAVAILABLE');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
