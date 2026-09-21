// TEST — Base de connaissances + outil getDocumentation : le chat peut puiser la
// VRAIE procédure produit (ex. configurer un Service Métier) au lieu d'inventer.
//   node --test test/knowledge-base.test.js

'use strict';

require('./helpers/auth').actAsAdmin(); // identité authentifiée de test (deny-by-default : voir ai-engine/authz.js)
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-kb-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;

const kb = require('../ai-engine/knowledgeBase');
const registry = require('../ai-engine/toolRegistry');

test('search trouve l\'article de configuration du Service Métier', () => {
  const hits = kb.search('comment configurer mon service métier');
  assert.ok(hits.length > 0);
  assert.equal(hits[0].id, 'services-metiers-configurer', JSON.stringify(hits.map((h) => h.id)));
  assert.ok(Array.isArray(hits[0].steps) && hits[0].steps.length >= 5, 'des étapes concrètes existent');
});

test('search trouve l\'article import de contacts', () => {
  const hits = kb.search('importer des contacts excel');
  assert.equal(hits[0].id, 'contacts-import');
});

test('outil getDocumentation renvoie la procédure réelle', async () => {
  const r = await registry.execute('anyTenant', 'getDocumentation', { query: 'configurer service métier' });
  assert.equal(r.state, 'SUCCESS');
  assert.equal(r.result.found, true);
  assert.match(r.result.articles[0].title, /Service Métier/i);
});

test('getDocumentation : requête hors sujet -> found:false (pas d\'invention)', async () => {
  const r = await registry.execute('anyTenant', 'getDocumentation', { query: 'zzz sujet inexistant xyzzy' });
  assert.equal(r.state, 'SUCCESS');
  assert.equal(r.result.found, false);
});

test('la FAQ pointe vers des articles existants', () => {
  for (const f of kb.FAQ) {
    if (f.articleId) assert.ok(kb.get(f.articleId), 'article FAQ manquant: ' + f.articleId);
  }
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
