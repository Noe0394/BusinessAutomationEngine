// TEST — le répondeur AUTOMATIQUE DES CLIENTS vouvoie TOUJOURS (jamais « tu »), avec un ton chaleureux et respectueux (jamais froid/robotique) :
// composeReply (conversation courante), composeLearning (apprenants), emotionalCloser (prospects). Le chat du PROPRIÉTAIRE (Self WhatsApp/Telegram,
// Chat intelligent) n'est pas concerné : ce n'est pas là qu'était le problème signalé.
//   node --test test/customer-politeness.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-polite-'));
process.env.GITHUB_TOKEN = ''; process.env.GEMINI_API_KEY = 'test-key';
require('./helpers/auth').actAsAdmin();
const personaManager = require('../ai-engine/personaManager');
const businessServices = require('../ai-engine/businessServices');
const autoResponder = require('../ai-engine/autoResponder');
const emotionalCloser = require('../ai-engine/emotionalCloser');

test('personaSystemPrompt(domain, {audience:"customer"}) impose le vouvoiement ; SANS ce paramètre (propriétaire), rien ne change (compatibilité)', () => {
  const customer = personaManager.personaSystemPrompt('default', { audience: 'customer' });
  assert.match(customer, /vouvoies TOUJOURS/); assert.match(customer, /jamais « tu »/);
  assert.match(customer, /chaleureu/i); assert.match(customer, /JAMAIS froid/);
  const owner = personaManager.personaSystemPrompt('default');
  assert.doesNotMatch(owner, /vouvoies TOUJOURS/, 'le chat propriétaire garde son ton habituel, non concerné par ce correctif');
  for (const domain of ['ecommerce', 'service', 'training']) assert.match(personaManager.personaSystemPrompt(domain, { audience: 'customer' }), /vouvoies TOUJOURS/, domain);
});

test('composeReply (réponse automatique à un client) : le prompt envoyé au modèle impose explicitement le vouvoiement', async () => {
  const T = 'polA'; await businessServices.create(T, { name: 'Boutique', commercial: { price: 5000 } });
  const prompts = []; const llm = async (p) => { prompts.push(String(p)); return 'Bonjour ! Le prix est de 5000 FCFA.'; };
  await autoResponder.handleIncoming({ tenantId: T, channel: 'WHATSAPP', from: '22670000001@s.whatsapp.net', name: 'Client', text: 'Bonjour, quel est le prix ?', messageId: 'p1' }, { runtime: { sendMessageVerified: async () => ({ status: 'SUCCESS', confirmationId: 'c' }) }, llm, settings: { whatsapp: true } });
  assert.ok(prompts.length >= 1); assert.match(prompts[prompts.length - 1], /vouvoies TOUJOURS/);
});

test('emotionalCloser (prospects, chemin AUTO_CLOSE) : le prompt de closing impose aussi le vouvoiement', async () => {
  const orig = require('../lib/ai/llmFallbackEngine').generateAIResponse; const seen = [];
  require('../lib/ai/llmFallbackEngine').generateAIResponse = async (p) => { seen.push(String(p)); return { text: 'Je comprends votre hésitation, prenons le temps qu\'il vous faut.', provider: 'test' }; };
  try { await emotionalCloser.handleCustomerMessage({ tenantId: 'polB', channel: 'WHATSAPP', from: '22670000099', text: 'Je vais réfléchir, c\'est un peu cher pour moi.' }); }
  finally { require('../lib/ai/llmFallbackEngine').generateAIResponse = orig; }
  assert.ok(seen.length >= 1); assert.match(seen[seen.length - 1], /vouvoies TOUJOURS/);
});

test('Le chat du PROPRIÉTAIRE (chatOrchestrator) n\'est jamais impacté : garde son registre existant', async () => {
  const orch = require('../ai-engine/chatOrchestrator'); const { ownerOf } = require('./helpers/auth');
  const P = ownerOf('polC'); const seen = [];
  const llm = async (p) => { seen.push(String(p)); return "Bonjour ! Je peux t'aider avec ça."; };
  await orch.handle({ text: 'Combien coûte le service X ?', history: [], tenantId: 'polC', sessionId: 's', principal: P }, { llm });
  if (seen.length) assert.doesNotMatch(seen[seen.length - 1], /vouvoies TOUJOURS/, 'la règle client ne doit pas fuiter vers le chat propriétaire');
});
