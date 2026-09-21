// TEST — Import de contacts (Excel/CSV déjà parsé) : normalisation, dédup,
// rejet des invalides, rapport réel, puis interrogeable par les outils du chat.
//   node --test test/contacts-import.test.js

'use strict';

require('./helpers/auth').actAsAdmin(); // identité authentifiée de test (deny-by-default : voir ai-engine/authz.js)
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-import-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.SECRET_VAULT_KEY = 'test-vault-key-import';

const contactCrm = require('../ai-engine/contactCrm');
const registry = require('../ai-engine/toolRegistry');

const T = 'tImport';

test('import : rapport réel (importés / doublons / invalides)', async () => {
  const rows = [
    { phone: '+225 06 65 04 71', name: 'Awa', fields: { pays: 'CI' } },
    { phone: '2250665047 1', name: 'Awa doublon' }, // même numéro (espaces) -> doublon
    { phone: '22600000002', name: 'Koffi' },
    { phone: 'abc', name: 'Invalide' },              // pas de numéro -> invalide
    { phone: '', name: 'Vide' },                      // vide -> invalide
  ];
  const rep = await contactCrm.importContacts(T, rows, { source: 'test_xlsx' });
  assert.equal(rep.total, 5);
  assert.equal(rep.imported, 2, JSON.stringify(rep));
  assert.equal(rep.duplicates, 1, JSON.stringify(rep));
  assert.equal(rep.invalid, 2, JSON.stringify(rep));
});

test('les contacts importés sont interrogeables par le chat (countContacts)', async () => {
  const r = await registry.execute(T, 'countContacts', {});
  assert.equal(r.state, 'SUCCESS');
  assert.equal(r.result.total, 2);
  assert.ok(r.result.byTag['importé'] >= 2, JSON.stringify(r.result.byTag));
});

test('searchContacts retrouve un importé par nom', async () => {
  const r = await registry.execute(T, 'searchContacts', { query: 'Awa' });
  assert.equal(r.state, 'SUCCESS');
  assert.equal(r.result.count, 1);
  assert.equal(r.result.contacts[0].name, 'Awa');
});

test('re-import du même fichier ne crée pas de doublons (idempotent)', async () => {
  const rep = await contactCrm.importContacts(T, [{ phone: '22600000002', name: 'Koffi' }], {});
  assert.equal(rep.imported, 0);
  assert.equal(rep.updated, 1);
  const r = await registry.execute(T, 'countContacts', {});
  assert.equal(r.result.total, 2, 'toujours 2 contacts, pas de doublon');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
