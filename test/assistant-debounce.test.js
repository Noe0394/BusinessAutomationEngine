'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-debounce-'));
delete process.env.AUTO_REPLY_DEBOUNCE_MS;

const assistantLayer = require('../ai-engine/assistantLayer');
const conversationState = require('../ai-engine/jarvis/conversationState');
const contactCrm = require('../ai-engine/contactCrm');
const learnerSupport = require('../ai-engine/learnerSupport');
const queue = require('../ai-engine/jarvis/conversationQueue').shared;

test('le répondeur automatique ne retarde pas les réponses privées sans réglage explicite', async () => {
  const original = {
    stateGet: conversationState.get,
    getContact: contactCrm.getContact,
    learnerPrepare: learnerSupport.prepare,
    submit: queue.submit,
  };
  let options = null;
  conversationState.get = async () => ({ turns: 0, lastReplyTs: null });
  contactCrm.getContact = async () => null;
  learnerSupport.prepare = async () => ({ active: false });
  queue.submit = async (_key, _item, _processor, o) => { options = o; return { skipped: 'test-intercept' }; };
  try {
    const layer = assistantLayer.create({
      autoResponder: {
        async getSettings() { return { enabled: true, assistant: true, firstContactMode: 'private' }; },
        isEnabled() { return true; },
        isGroupChat() { return false; },
      },
    });
    const out = await layer.route({
      tenantId: 'debounce-tenant', channel: 'WHATSAPP', text: 'Bonjour', from: '22670000000@s.whatsapp.net',
      messageId: 'debounce-message', identity: { label: 'contact' },
    });
    assert.equal(out.handled, true);
    assert.equal(options.debounceMs, 0);
  } finally {
    conversationState.get = original.stateGet;
    contactCrm.getContact = original.getContact;
    learnerSupport.prepare = original.learnerPrepare;
    queue.submit = original.submit;
  }
});
