// TEST — AI usage ledger (RÈGLE N°2 : mesure des coûts IA). 100 % déterministe,
// aucun appel IA. Vérifie l'enregistrement, les agrégats et les ventilations.
//   node --test test/ai-usage-ledger.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-aiusage-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;

const ledger = require('../ai-engine/aiUsageLedger');

test('record + agrégats (totaux, par purpose/provider/tenant)', async () => {
  await ledger.record({ provider: 'groq', promptChars: 400, responseChars: 200, purpose: 'client_conversation', tenant: 'KEY-A' });
  await ledger.record({ provider: 'pollinations', promptChars: 800, responseChars: 400, purpose: 'client_conversation', tenant: 'KEY-B' });
  await ledger.record({ provider: 'groq', promptChars: 40, responseChars: 40, purpose: 'tool_agent', tenant: 'KEY-A' });
  const s = await ledger.summary();
  assert.equal(s.totals.calls, 3, JSON.stringify(s.totals));
  // tokens ~ (chars)/4 : (100+50)+(200+100)+(10+10) = 470
  assert.equal(s.totals.tokens, 150 + 300 + 20);
  assert.ok(s.totals.cost > 0, 'coût groq > 0');
  assert.equal(s.byPurpose.client_conversation.calls, 2);
  assert.equal(s.byPurpose.tool_agent.calls, 1);
  assert.equal(s.byProvider.groq.calls, 2);
  assert.equal(s.byProvider.pollinations.calls, 1);
  assert.equal(s.byTenant['KEY-A'].calls, 2);
  assert.equal(s.byTenant['KEY-B'].calls, 1);
});

test('fournisseur gratuit (pollinations) -> coût 0', async () => {
  const before = (await ledger.summary()).byProvider.pollinations.cost;
  assert.equal(before, 0, 'pollinations gratuit');
});

test('record ne jette jamais (non bloquant) même avec entrée invalide', async () => {
  const r = await ledger.record({});
  // provider inconnu -> coût 0, mais doit renvoyer un objet, pas throw
  assert.ok(r === null || typeof r === 'object');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
