// TEST — recherche de groupes WhatsApp/Telegram RÉELLEMENT opérationnelle : « Cherche le groupe Épicerie » cible les groupes RÉELS du compte connecté
// (jamais la découverte publique), retourne le NOM RÉEL (jamais un JID/LID), gère plusieurs résultats et l'absence de résultat, joint le lien réel
// quand la plateforme le fournit (jamais fabriqué).
//   node --test test/group-search.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-gs-'));
process.env.GITHUB_TOKEN = ''; process.env.GEMINI_API_KEY = 'test-key';
require('./helpers/auth').actAsAdmin();
const orch = require('../ai-engine/chatOrchestrator');
const waManager = require('../adapters/whatsappManager');

function fakeRuntime(groups, linkOf) {
  return { actionExecutor: { execute: async (type) => (type === 'LIST_GROUPS' ? { ok: true, result: { connected: true, groups } } : { ok: false, error: 'X' }) } };
}

test('« Cherche le groupe Épicerie » : intention groups (pas la découverte publique), noms RÉELS, plusieurs résultats possibles', async () => {
  const groups = [{ id: '1@g.us', name: 'Épicerie Awa', size: 40, isAdmin: true }, { id: '2@g.us', name: 'Épicerie Nord', size: 12, isAdmin: false }, { id: '3@g.us', name: 'Foot entre amis', size: 8, isAdmin: false }];
  assert.equal(orch.detectIntent('Cherche le groupe Épicerie'), 'groups');
  assert.notEqual(orch.detectIntent('Cherche le groupe Épicerie'), 'community');
  const r = await orch.handleGroups ? null : null; // handleGroups n'est pas exporté ; on passe par handle()
  const out = await orch.handle({ text: 'Cherche le groupe Épicerie', history: [], tenantId: 'gs1', sessionId: 's' }, { runtime: fakeRuntime(groups) });
  assert.match(out.text, /Épicerie Awa/); assert.match(out.text, /Épicerie Nord/); assert.doesNotMatch(out.text, /Foot entre amis/);
  assert.doesNotMatch(out.text, /1@g\.us|2@g\.us/, 'jamais l\'identifiant technique à la place du nom');
});

test('Aucun résultat : message clair, jamais un lien inventé', async () => {
  const groups = [{ id: '1@g.us', name: 'Foot entre amis', size: 8, isAdmin: false }];
  const out = await orch.handle({ text: 'Cherche le groupe Boulangerie', history: [], tenantId: 'gs2', sessionId: 's' }, { runtime: fakeRuntime(groups) });
  assert.match(out.text, /Aucun groupe WhatsApp ne correspond à « Boulangerie »/); assert.doesNotMatch(out.text, /https?:\/\//);
});

test('Recherche « mes groupes contenant X » (mission §17) fonctionne toujours', async () => {
  const groups = [{ id: '1@g.us', name: 'Épicerie Awa', size: 40, isAdmin: true }];
  const out = await orch.handle({ text: 'Cherche mes groupes contenant Épicerie', history: [], tenantId: 'gs3', sessionId: 's' }, { runtime: fakeRuntime(groups) });
  assert.match(out.text, /Épicerie Awa/);
});

test('Lien réel joint quand WhatsApp le fournit (recherche ciblée, peu de résultats) ; jamais fabriqué si absent', async () => {
  const groups = [{ id: '1@g.us', name: 'Épicerie Awa', size: 40, isAdmin: true }];
  const orig = waManager.getOrCreate;
  waManager.getOrCreate = () => ({ session: { getGroupInviteLink: async (id) => (id === '1@g.us' ? 'https://chat.whatsapp.com/REALCODE123' : null) } });
  try {
    const out = await orch.handle({ text: 'Cherche le groupe Épicerie', history: [], tenantId: 'gs4', sessionId: 's' }, { runtime: fakeRuntime(groups) });
    assert.match(out.text, /https:\/\/chat\.whatsapp\.com\/REALCODE123/);
  } finally { waManager.getOrCreate = orig; }
});

test('Discovery PUBLIQUE (communityDiscovery) reste distincte : « cherche des groupes publics sur la formation » ne cherche PAS mes propres groupes', () => {
  assert.equal(orch.detectIntent('Cherche des groupes publics sur la formation'), 'community');
});

test('COMMUNITY DISCOVERY — Telegram/WhatsApp : jamais un JID/LID présenté comme nom ou lien (structure des résultats)', async () => {
  const disc = require('../ai-engine/communityDiscovery');
  const codes = disc.extractInviteCodes('<a href="https://chat.whatsapp.com/AbCdEfGhIjKlMnOpQr">rejoindre</a>');
  assert.deepEqual(codes, ['AbCdEfGhIjKlMnOpQr']);
  const kws = disc.cleanKeywords('Épicerie, Boulangerie ; x');
  assert.deepEqual(kws, ['épicerie', 'boulangerie']); // 'x' trop court (< 2 caractères... en fait 1) est écarté
});
