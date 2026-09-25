'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const originalEnv = {};
for (const key of ['AI_ENGINE_STORAGE_DIR', 'GITHUB_TOKEN', 'GITHUB_DATA_REPO', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY', 'DEEPSEEK_API_KEY', 'HUGGINGFACE_API_KEY', 'OPENAI_API_KEY', 'MISTRAL_API_KEY']) {
  originalEnv[key] = process.env[key];
  delete process.env[key];
}
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-llm-cache-'));
process.env.AI_ENGINE_STORAGE_DIR = tempDir;
process.env.ANTHROPIC_API_KEY = 'unit-test-key';

const axios = require('axios');
const llm = require('../lib/ai/llmFallbackEngine');
const usageLedger = require('../ai-engine/aiUsageLedger');
const originalPost = axios.post;
const requests = [];
axios.post = async (url, body) => {
  requests.push(body);
  if (url.includes('groq.com')) {
    return { data: {
      model: 'openai/gpt-oss-120b',
      choices: [{ message: { content: 'Réponse vérifiée.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 900, completion_tokens: 80, prompt_tokens_details: { cached_tokens: 250 } },
    } };
  }
  return {
    data: {
      model: 'claude-haiku-4-5-20251001',
      content: [{ type: 'text', text: 'Réponse vérifiée.' }],
      usage: { input_tokens: 200, cache_creation_input_tokens: 6000, cache_read_input_tokens: 0, output_tokens: 2 },
    },
  };
};

test('Haiku official cache is limited to long stable text history and records provider usage', async () => {
  const history = [
    { role: 'user', text: 'stable context '.repeat(800) },
    { role: 'assistant', text: 'stable reply '.repeat(800) },
  ];
  const result = await llm.generateAIResponse('continue', history, null, undefined, null, { tenant: 'TENANT-A', cacheScope: 'TENANT-A:session-1', purpose: 'cache_test' });
  assert.equal(result.text, 'Réponse vérifiée.');
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].cache_control, { type: 'ephemeral' });
  assert.equal(requests[0].model, 'claude-haiku-4-5-20251001');

  const usage = await usageLedger.summary();
  assert.equal(usage.byProvider.claude.measuredCalls, 1);
  assert.equal(usage.byProvider.claude.estimatedCalls, 0);
  assert.equal(usage.byProvider.claude.cacheWriteTokens, 6000);
  assert.equal(usage.byProvider.claude.cacheReadTokens, 0);
  assert.equal(usage.byProvider.claude.tokens, 6202);
  assert.equal(usage.byProvider.claude.cost, 0.00771);
  assert.equal(usage.recent[0].tokenSource, 'provider');
  assert.equal(Object.hasOwn(usage.recent[0], 'prompt'), false);

  await llm.generateAIResponse('continue', history, null, undefined, null, { tenant: 'TENANT-B', cacheScope: 'TENANT-B:session-1', purpose: 'cache_test' });
  assert.notEqual(requests[1].system, requests[0].system, 'different tenants must have different provider cache prefixes');
  assert.equal(requests[1].cache_control.type, 'ephemeral');
});

test('short conversations do not request a provider cache', async () => {
  const before = requests.length;
  await llm.generateAIResponse('salut', [], null, undefined, null, { tenant: 'TENANT-A' });
  assert.equal(requests.length, before + 1);
  assert.equal(Object.hasOwn(requests[before], 'cache_control'), false);
});

test('OpenAI-compatible providers retain their measured token and cached-token usage', async () => {
  delete process.env.ANTHROPIC_API_KEY;
  process.env.GROQ_API_KEY = 'unit-test-key';
  const result = await llm.generateAIResponse('salut', [], null, undefined, null, { tenant: 'TENANT-B' });
  assert.equal(result.provider, 'groq');
  const usage = await usageLedger.summary();
  assert.equal(usage.byProvider.groq.measuredCalls, 1);
  assert.equal(usage.byProvider.groq.inputTokens, 900);
  assert.equal(usage.byProvider.groq.outputTokens, 80);
  assert.equal(usage.byProvider.groq.cacheReadTokens, 250);
  assert.equal(usage.byProvider.groq.measuredTokens, 980);
});

test.after(() => {
  axios.post = originalPost;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) { /* test cleanup */ }
});
