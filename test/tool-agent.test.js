// TEST — Tool Agent : sélection d'outil par le LLM + exécution vérifiée +
// réponse ancrée. Le LLM est STUBBÉ (déterministe) ; les outils tapent le vrai
// stockage temporaire. Prouve la boucle Chat → sélection → tool call → réponse.
//   node --test test/tool-agent.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-agent-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.SECRET_VAULT_KEY = 'test-vault-key-agent';

const businessServices = require('../ai-engine/businessServices');
const toolAgent = require('../ai-engine/toolAgent');

const T = 'tAgent';

// LLM stub : 1er appel = décision {tool,args} ; 2e appel = phrase de réponse.
function makeLlm(decision) {
  let n = 0;
  return async (prompt) => {
    n += 1;
    if (n === 1) return JSON.stringify(decision);
    // réponse : renvoie le prompt tronqué pour prouver que le résultat réel y est
    return 'Réponse ancrée sur : ' + prompt.split('Résultat/erreur (données RÉELLES')[1] || 'ok';
  };
}

test('setup service + produit', async () => {
  await businessServices.create(T, { name: 'Cuisine', type: 'formation', products: [{ name: 'Formation Épicerie et Bouillon', price: 8000 }], commercial: { currency: 'FCFA' } });
});

test('sélectionne getProductPrice et répond avec le VRAI prix', async () => {
  const llm = makeLlm({ tool: 'getProductPrice', args: { query: 'Épicerie et Bouillon' } });
  const out = await toolAgent.runToolAgent({ text: 'Quel est le prix de ma formation Épicerie ?', history: [], tenantId: T }, { llm });
  assert.ok(out, 'un résultat est renvoyé');
  assert.equal(out.toolCall.name, 'getProductPrice');
  assert.equal(out.toolCall.state, 'SUCCESS');
  assert.equal(out.toolCall.result.price, 8000);
  assert.match(out.text, /8000/, 'la réponse cite le prix réel : ' + out.text);
});

test('tool:null -> renvoie null (conversation générique reprend la main)', async () => {
  const llm = makeLlm({ tool: null });
  const out = await toolAgent.runToolAgent({ text: 'salut ça va ?', history: [], tenantId: T }, { llm });
  assert.equal(out, null);
});

test('envoi non confirmé -> état UNCONFIRMED honnête (pas de faux succès)', async () => {
  const llm = makeLlm({ tool: 'sendWhatsAppMessage', args: { to: '22600000000', text: 'ok' } });
  const runtime = { sendMessageVerified: async () => ({ status: 'PENDING', confirmationId: null }) };
  const out = await toolAgent.runToolAgent({ text: 'envoie ok à ce numéro', history: [], tenantId: T }, { llm, runtime, permissions: ['messages:send'] });
  assert.equal(out.toolCall.state, 'UNCONFIRMED');
  assert.notEqual(out.actionLog[0].status, 'done');
});

test('outil halluciné (hors registre) -> null (jamais exécuté)', async () => {
  const llm = makeLlm({ tool: 'toolInexistant', args: {} });
  const out = await toolAgent.runToolAgent({ text: 'fais un truc', history: [], tenantId: T }, { llm });
  assert.equal(out, null);
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
