'use strict';

require('./helpers/auth').actAsAdmin();
const test = require('node:test');
const assert = require('node:assert/strict');
const authz = require('../ai-engine/authz');
const registry = require('../ai-engine/toolRegistry');
const chatOrchestrator = require('../ai-engine/chatOrchestrator');
const telegramManager = require('../adapters/telegramManager');

const TENANT = 'channel-login-test';
const principal = authz.issuePrincipal({ tenant: TENANT, role: 'OWNER', channel: 'WEB', via: 'test' });

test('codes Telegram : tool direct-only masqué au modèle et code traité sans appel IA', async () => {
  const secret = '482731';
  let submitted = null;
  let step = 'code_required';
  const previous = telegramManager.peek;
  telegramManager.peek = () => ({ session: {
    getLoginStep: () => step,
    submitCode: async (code) => { submitted = code; step = 'connected'; return step; },
  } });
  try {
    const visible = authz.runAs(principal, () => registry.list({ principal, allowedModules: ['telegram', 'whatsapp'] }));
    assert.ok(!visible.some((tool) => ['submitTelegramLoginCode', 'submitTelegramLoginPassword', 'startWhatsAppPairing'].includes(tool.name)));
    const blocked = await authz.runAs(principal, () => registry.execute(TENANT, 'submitTelegramLoginCode', { code: secret }, {
      principal, allowedModules: ['telegram'], permissions: [],
    }));
    assert.equal(blocked.state, 'BLOCKED');
    assert.equal(blocked.error.code, 'DIRECT_ROUTE_REQUIRED');

    let modelCalls = 0;
    const result = await authz.runAs(principal, () => chatOrchestrator.handle({
      text: `/telegram-code ${secret}`, tenantId: TENANT, sessionId: 'login-test', principal,
    }, {
      toolContext: { allowedModules: ['telegram'], permissions: [] },
      llm: async () => { modelCalls += 1; throw new Error('Le modèle ne doit pas recevoir un code de connexion.'); },
    }));

    assert.equal(submitted, secret);
    assert.equal(modelCalls, 0);
    assert.equal(result.intent, 'channel_login');
    assert.match(result.text, /connecté/i);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(secret));
  } finally { telegramManager.peek = previous; }
});
