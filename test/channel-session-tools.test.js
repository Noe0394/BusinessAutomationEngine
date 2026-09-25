'use strict';

require('./helpers/auth').actAsAdmin();
const test = require('node:test');
const assert = require('node:assert/strict');
const registry = require('../ai-engine/toolRegistry');
const whatsappManager = require('../adapters/whatsappManager');
const telegramManager = require('../adapters/telegramManager');

test('WhatsApp status and logout call the existing session and verify its real state', async () => {
  let connected = true; let paired = true;
  const previous = whatsappManager.peek;
  whatsappManager.peek = () => ({ session: {
    isConnected: () => connected, isPaired: () => paired, getConnectedNumber: () => connected ? '+22660000001' : null,
    logout: async () => { connected = false; paired = false; },
  } });
  try {
    const status = await registry.execute('tenant-wa-tools', 'getWhatsAppSessionStatus', {}, { allowedModules: ['whatsapp'] });
    assert.equal(status.state, 'SUCCESS');
    assert.equal(status.result.connected, true);
    assert.equal(status.result.connectedNumber, '+22660000001');
    const out = await registry.execute('tenant-wa-tools', 'logoutWhatsAppSession', {}, { allowedModules: ['whatsapp'] });
    assert.equal(out.state, 'SUCCESS');
    assert.equal(out.verification.verified, true);
  } finally { whatsappManager.peek = previous; }
});

test('Telegram status and logout call the existing session and verify its real state', async () => {
  let connected = true; let paired = true;
  const previous = telegramManager.peek;
  telegramManager.peek = () => ({ session: {
    isConnected: () => connected, isPaired: () => paired,
    logout: async () => { connected = false; paired = false; },
  } });
  try {
    const status = await registry.execute('tenant-tg-tools', 'getTelegramSessionStatus', {}, { allowedModules: ['telegram'] });
    assert.equal(status.state, 'SUCCESS');
    assert.equal(status.result.connected, true);
    const out = await registry.execute('tenant-tg-tools', 'logoutTelegramSession', {}, { allowedModules: ['telegram'] });
    assert.equal(out.state, 'SUCCESS');
    assert.equal(out.verification.verified, true);
  } finally { telegramManager.peek = previous; }
});
