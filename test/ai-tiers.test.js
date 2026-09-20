// TEST RUNNER — connexion des IA : niveau « raisonnement » pour les décisions critiques, cascade économique pour le reste.
//   node --test test/ai-tiers.test.js
// axios est simulé (aucun appel réseau) : on vérifie QUEL modèle est appelé, avec QUEL effort/délai, dans QUEL ordre.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-tiers-'));
const axios = require('axios');
const llm = require('../lib/ai/llmFallbackEngine');

const KEYS = ['GROQ_API_KEY', 'GEMINI_API_KEY', 'DEEPSEEK_API_KEY', 'OPENROUTER_API_KEY', 'HUGGINGFACE_API_KEY', 'OPENAI_API_KEY', 'MISTRAL_API_KEY', 'ANTHROPIC_API_KEY'];
function withKeys(keys) { for (const k of KEYS) delete process.env[k]; for (const k of keys) process.env[k] = 'test-' + k; }

const okGroq = (content, finish) => ({ data: { choices: [{ message: { content }, finish_reason: finish || 'stop' }] } });
const okGemini = (t) => ({ data: { candidates: [{ content: { parts: [{ text: t }] } }] } });
const okClaude = (t) => ({ data: { content: [{ text: t }] } });
function mockAxios(handler) {
  const calls = [];
  const orig = axios.post;
  axios.post = async (url, body, cfg) => { calls.push({ url: String(url), body, timeout: cfg && cfg.timeout }); return handler(String(url), body, calls.length); };
  return { calls, restore: () => { axios.post = orig; } };
}

test('état des connexions : ordre par niveau, modèles forts manquants signalés', () => {
  withKeys(['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'HUGGINGFACE_API_KEY']);
  const s = llm.getProviderStatus();
  assert.deepEqual(s.reasoning.slice(0, 3), ['groq', 'gemini', 'openrouter']);
  assert.deepEqual(s.standard.slice(0, 2), ['groq', 'gemini']);
  assert.deepEqual(s.missingStrongModels, ['claude', 'openai']);
  withKeys(['GROQ_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
  const s2 = llm.getProviderStatus();
  assert.deepEqual(s2.reasoning.slice(0, 3), ['claude', 'openai', 'groq'], 'les modèles les plus forts passent en premier au niveau raisonnement');
  assert.deepEqual(s2.missingStrongModels, []);
});

test('niveau RAISONNEMENT : Groq gpt-oss-120b en effort « high », marge de tokens et délai étendus', async () => {
  withKeys(['GROQ_API_KEY']);
  const m = mockAxios(() => okGroq('décision réfléchie'));
  try {
    const r = await llm.generateAIResponse('Quel outil ?', [], null, undefined, null, { tier: 'reasoning', maxTokens: 200 });
    assert.equal(r.text, 'décision réfléchie');
    assert.equal(m.calls[0].body.model, 'openai/gpt-oss-120b');
    assert.equal(m.calls[0].body.reasoning_effort, 'high');
    assert.ok(m.calls[0].body.max_tokens >= 2500);
    assert.equal(m.calls[0].timeout, 60000);
  } finally { m.restore(); }
});

test('niveau STANDARD : cascade économique inchangée (effort « low », délai court, Gemini Flash en secours)', async () => {
  withKeys(['GROQ_API_KEY', 'GEMINI_API_KEY']);
  let n = 0;
  const m = mockAxios((url) => { n++; if (/groq/.test(url)) throw Object.assign(new Error('500'), { response: { status: 500 } }); return okGemini('réponse rapide'); });
  try {
    const r = await llm.generateAIResponse('Salut', [], null);
    assert.equal(r.provider, 'gemini');
    assert.equal(m.calls[0].body.reasoning_effort, 'low');
    assert.equal(m.calls[0].timeout, 15000);
    assert.match(m.calls[1].url, /gemini-3\.6-flash/);
  } finally { m.restore(); }
});

test('RAISONNEMENT : si Groq échoue, Gemini PRO (pas Flash) prend le relais avec un délai étendu', async () => {
  withKeys(['GROQ_API_KEY', 'GEMINI_API_KEY']);
  const m = mockAxios((url) => { if (/groq/.test(url)) throw Object.assign(new Error('429'), { response: { status: 429 } }); return okGemini('analyse approfondie'); });
  try {
    const r = await llm.generateAIResponse('Décision critique', [], null, undefined, null, { tier: 'reasoning' });
    assert.equal(r.provider, 'gemini');
    assert.match(m.calls[1].url, /gemini-pro-latest/);
    assert.equal(m.calls[1].timeout, 60000);
  } finally { m.restore(); }
});

test('RAISONNEMENT : un modèle fort configuré (Claude) est appelé EN PREMIER, avec son modèle de raisonnement', async () => {
  withKeys(['GROQ_API_KEY', 'ANTHROPIC_API_KEY']);
  const m = mockAxios((url) => (/anthropic/.test(url) ? okClaude('réponse Claude') : okGroq('groq')));
  try {
    const r = await llm.generateAIResponse('Décision critique', [], null, undefined, null, { tier: 'reasoning' });
    assert.equal(r.provider, 'claude');
    assert.equal(m.calls[0].body.model, 'claude-sonnet-5');
    assert.equal(m.calls.length, 1);
    // au niveau standard, la cascade économique reste en tête (Groq avant Claude)
    m.calls.length = 0;
    const s = await llm.generateAIResponse('Salut', [], null);
    assert.equal(s.provider, 'groq');
  } finally { m.restore(); }
});

test('réponse coupée (finish_reason=length) : nouvelle tentative avec plus de marge, jamais une réponse tronquée', async () => {
  withKeys(['GROQ_API_KEY']);
  const m = mockAxios((url, body, n) => (n === 1 ? okGroq('Vous pouvez régler par Orange Money au 07 00', 'length') : okGroq('Vous pouvez régler par Orange Money au 07 00 00 00 00.', 'stop')));
  try {
    const r = await llm.generateAIResponse('Comment payer ?', [], null, undefined, null, { maxTokens: 220 });
    assert.equal(r.text, 'Vous pouvez régler par Orange Money au 07 00 00 00 00.');
    assert.equal(m.calls.length, 2);
    assert.equal(m.calls[1].body.max_tokens, 4096);
  } finally { m.restore(); }
});

test('les décisions critiques sont réellement déclarées « raisonnement » dans le code', () => {
  const src = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
  assert.match(src('ai-engine/jarvis/agentLoop.js'), /purpose: 'jarvis_agent', tier: 'reasoning'/);
  assert.match(src('ai-engine/toolAgent.js'), /tier: 'reasoning'/);
  assert.match(src('ai-engine/chatOrchestrator.js'), /purpose: 'ad_campaign_parse', tier: 'reasoning'/);
  assert.match(src('ai-engine/chatOrchestrator.js'), /purpose: 'group_campaign_parse', tier: 'reasoning'/);
  assert.match(src('ai-engine/offerClarifier.js'), /tier: 'reasoning'/);
});

test('ARBITRAGE d\'intention par IA : réellement appelé en production (il ne l\'était jamais) et au niveau raisonnement', async () => {
  const platformOrchestrator = require('../ai-engine/platformOrchestrator');
  platformOrchestrator.notifyTenantChat = async () => {};
  const alertCenter = require('../ai-engine/alertCenter');
  alertCenter.setDeliverers([async () => ({ ok: true, channel: 't' })]);
  const autoResponder = require('../ai-engine/autoResponder');
  const seen = [];
  const orig = llm.generateAIResponse;
  llm.generateAIResponse = async (prompt, h, c, mode, skills, meta) => { seen.push({ purpose: meta && meta.purpose, tier: meta && meta.tier }); return { text: /Tu classes l'intention/.test(prompt) ? '{"intent":"PURCHASE_INTENT","deferral":"demain"}' : 'Très bien, je vous attends demain.', provider: 'stub' }; };
  try {
    const runtime = { sendMessageVerified: async () => ({ status: 'SUCCESS', confirmationId: 'C1' }) };
    // message ambigu : refus ET envie d'acheter -> le code ne tranche pas seul, l'IA arbitre
    await autoResponder.handleIncoming({ tenantId: 'arb', channel: 'WHATSAPP', from: '22670123123@s.whatsapp.net', name: 'Awa', text: "Non merci pas maintenant mais je veux m'inscrire demain", messageId: 'AR1' }, { runtime, settings: { whatsapp: true, debounceMs: 0 } });
    const arb = seen.find((s) => s.purpose === 'intent_arbitration');
    assert.ok(arb, 'l\'arbitrage IA doit être appelé : ' + JSON.stringify(seen));
    assert.equal(arb.tier, 'reasoning');
  } finally { llm.generateAIResponse = orig; }
});
