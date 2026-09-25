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
  const orig = axios.post; const origGet = axios.get;
  axios.post = async (url, body, cfg) => { calls.push({ url: String(url), body, timeout: cfg && cfg.timeout }); return handler(String(url), body, calls.length); };
  axios.get = async () => { throw Object.assign(new Error('400'), { response: { status: 400, data: {} } }); }; // repli public : jamais de réseau réel
  return { calls, restore: () => { axios.post = orig; axios.get = origGet; } };
}

test('état des connexions : ordre par niveau, modèles forts manquants signalés', () => {
  withKeys(['GROQ_API_KEY', 'GEMINI_API_KEY', 'OPENROUTER_API_KEY', 'HUGGINGFACE_API_KEY']);
  const s = llm.getProviderStatus();
  assert.deepEqual(s.reasoning.slice(0, 5), ['gemini-primary', 'gemini-secondary', 'gemini-flash', 'groq', 'openrouter']);
  assert.deepEqual(s.standard.slice(0, 4), ['gemini-primary', 'gemini-secondary', 'gemini-flash', 'groq']);
  assert.deepEqual(s.missingStrongModels, ['claude']);
  withKeys(['GROQ_API_KEY', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY']);
  const s2 = llm.getProviderStatus();
  assert.deepEqual(s2.reasoning.slice(0, 2), ['claude', 'groq'], 'Claude Haiku passe avant les replis gratuits');
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

test('sans clé Anthropic, niveau STANDARD : Gemma 4 31B en premier ; si Gemini échoue, Groq prend le relais', async () => {
  withKeys(['GROQ_API_KEY', 'GEMINI_API_KEY']);
  process.env.AI_RETRY_BASE_MS = '0';
  const m = mockAxios((url) => { if (/generativelanguage/.test(url)) throw Object.assign(new Error('400'), { response: { status: 400, data: {} } }); return okGroq('réponse rapide'); });
  try {
    const r = await llm.generateAIResponse('Salut', [], null);
    assert.equal(r.provider, 'groq');
    assert.match(m.calls[0].url, /gemma-4-31b-it/);
    const groqCall = m.calls.find((c) => /groq/.test(c.url));
    assert.equal(groqCall.body.reasoning_effort, 'low');
    assert.equal(groqCall.timeout, 15000);
  } finally { m.restore(); }
});

test('RAISONNEMENT : Gemma 4 31B en premier avec un délai étendu ; jamais de Gemini PRO automatique', async () => {
  withKeys(['GROQ_API_KEY', 'GEMINI_API_KEY']);
  const m = mockAxios((url) => okGemini('analyse approfondie'));
  try {
    const r = await llm.generateAIResponse('Décision critique', [], null, undefined, null, { tier: 'reasoning' });
    assert.equal(r.provider, 'gemini-primary');
    assert.match(m.calls[0].url, /gemma-4-31b-it/);
    assert.ok(!/pro/i.test(m.calls[0].url));
    assert.equal(m.calls[0].timeout, 60000);
  } finally { m.restore(); }
});

test('Claude passe en premier pour tous les paliers et n’appelle que Haiku 4.5', async () => {
  withKeys(['GROQ_API_KEY', 'ANTHROPIC_API_KEY']);
  const m = mockAxios((url) => (/anthropic/.test(url) ? okClaude('réponse Claude') : okGroq('groq')));
  try {
    const r = await llm.generateAIResponse('Décision critique', [], null, undefined, null, { tier: 'reasoning' });
    assert.equal(r.provider, 'claude');
    assert.equal(m.calls[0].body.model, 'claude-haiku-4-5-20251001');
    assert.equal(m.calls.length, 1);
    // Le palier standard appelle lui aussi Haiku en premier.
    m.calls.length = 0;
    const s = await llm.generateAIResponse('Salut', [], null);
    assert.equal(s.provider, 'claude');
    assert.equal(m.calls[0].body.model, 'claude-haiku-4-5-20251001');
  } finally { m.restore(); }
});

test('le repli gratuit attend la réponse ou le timeout de Claude, puis prend le relais', async () => {
  withKeys(['ANTHROPIC_API_KEY', 'GEMINI_API_KEY']);
  const oldHedge = process.env.AI_HEDGE_MS;
  process.env.AI_HEDGE_MS = '1';
  const events = [];
  const m = mockAxios(async (url, body) => {
    if (/anthropic/.test(url)) {
      events.push('claude:start:' + body.model);
      await new Promise((resolve) => setTimeout(resolve, 25));
      events.push('claude:failed');
      throw Object.assign(new Error('401'), { response: { status: 401, data: { error: { message: 'invalid key' } } } });
    }
    events.push('gemini:start');
    return okGemini('réponse de secours');
  });
  try {
    const r = await llm.generateAIResponse('Salut', [], null);
    assert.equal(r.provider, 'gemini-primary');
    assert.deepEqual(events, ['claude:start:claude-haiku-4-5-20251001', 'claude:failed', 'gemini:start']);
  } finally {
    m.restore();
    if (oldHedge === undefined) delete process.env.AI_HEDGE_MS;
    else process.env.AI_HEDGE_MS = oldHedge;
  }
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
