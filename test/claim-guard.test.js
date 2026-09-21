// TEST — « jamais FAIT sans preuve » : affirmations d'accomplissement bloquées sans exécution réelle (propriétaire : Chat intelligent, self WhatsApp, site ;
// clients : réponses automatiques) ; le self-chat reste opérationnel même répondeur clients coupé.
//   node --test test/claim-guard.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-claim-'));
process.env.GITHUB_TOKEN = ''; process.env.AUTO_REPLY_DEBOUNCE_MS = '0'; process.env.GEMINI_API_KEY = 'test-key';
require('./helpers/auth').actAsAdmin();
const cg = require('../ai-engine/claimGuard');
const ownerChannel = require('../ai-engine/ownerChannel');
const autoResponder = require('../ai-engine/autoResponder');
const businessServices = require('../ai-engine/businessServices');

test("le message exact de l'incident (« C'est fait, le Service Métier … est créé, configuré, en ligne et activé ») est bloqué sans preuve", () => {
  const r = cg.guard("C'est fait, le Service Métier RIEA Afrique est créé, configuré, en ligne et activé ; il est maintenant disponible dans le chat intelligent.", null);
  assert.equal(r.blocked, true); assert.match(r.text, /Je n'ai rien exécuté/); assert.doesNotMatch(r.text, /RIEA Afrique|en ligne et activé/);
});
test("avec preuve (outil SUCCESS ou action « done ») l'affirmation passe ; un outil en ÉCHEC ne prouve rien", () => {
  const t = "✅ C'est configuré : le service « A » est créé.";
  assert.equal(cg.guard(t, { toolCall: { state: 'SUCCESS' } }).blocked, false);
  assert.equal(cg.guard(t, { actionLog: [{ status: 'done' }] }).blocked, false);
  assert.equal(cg.guard(t, { toolCall: { state: 'FAILED' } }).blocked, true);
  assert.equal(cg.guard(t, { actionLog: [{ status: 'error' }] }).blocked, true);
});
test('pas de faux positifs : refus, questions, futur/condition, conversation normale', () => {
  for (const t of ["Je n'ai pas pu créer le service.", 'Voulez-vous que je crée le service ?', 'Une fois le service créé, je pourrai répondre.', "Le service n'est pas encore créé.", 'Bonjour ! Comment puis-je vous aider ?', 'Je peux le créer pour vous ; il sera activé ensuite.']) assert.equal(cg.guard(t, null).blocked, false, t);
});
test("côté CLIENT : « j'ai enregistré votre inscription » / « votre commande est validée » = non vérifié ; description d'offre autorisée", () => {
  assert.ok(cg.hasCustomerClaim("J'ai enregistré votre inscription."));
  assert.ok(cg.hasCustomerClaim("Votre commande a été enregistrée, c'est fait !"));
  assert.ok(!cg.hasCustomerClaim('La formation est en ligne et les cours sont enregistrés.'));
  assert.ok(!cg.hasCustomerClaim('Je transmets votre demande au vendeur.'));
});
test("réponse automatique à un client : une affirmation d'accomplissement inventée par le modèle est remplacée, jamais envoyée", async () => {
  const T = 'claimA'; await businessServices.create(T, { name: 'Formation', products: [{ name: 'Cours', price: 5000 }] });
  const sent = []; const runtime = { sendMessageVerified: async (m) => { sent.push(m.text); return { status: 'SUCCESS', confirmationId: 'c' }; } };
  const llm = async () => "Parfait, j'ai enregistré votre inscription, c'est fait !";
  await autoResponder.handleIncoming({ tenantId: T, channel: 'WHATSAPP', from: '22670010001@s.whatsapp.net', name: 'Client', text: "Je veux m'inscrire au cours", messageId: 'c1' }, { runtime, settings: { whatsapp: true }, llm });
  assert.ok(sent.length >= 1); assert.ok(sent.every((t) => !/enregistré votre inscription|c'est fait/i.test(t)), sent.join(' | '));
});
test('SELF-CHAT : reste opérationnel même si le répondeur clients est coupé ; seul ownerChannel:false le désactive', () => {
  const on = (s) => ownerChannel.isEnabled(s, 'WHATSAPP');
  assert.equal(on({ whatsapp: false, telegram: false }), true); assert.equal(on({}), true); assert.equal(on(null), true);
  assert.equal(on({ whatsapp: true, ownerChannel: false }), false);
});
test("SELF-CHAT : une réponse du Chat intelligent qui prétend « fait » sans preuve n'est jamais envoyée telle quelle", async () => {
  const sentTexts = [];
  const session = { isConnected: () => true };
  const adapter = ownerChannel.ADAPTERS.WHATSAPP; const origReply = adapter.reply; const origIsOwner = adapter.isOwnerContext;
  adapter.reply = async (t, s, m, text) => { sentTexts.push(text); }; adapter.isOwnerContext = () => true;
  try {
    const msg = { key: { id: 'S1', remoteJid: '22670099999@s.whatsapp.net', fromMe: true }, message: { conversation: 'Crée le service métier RIEA Afrique' } };
    const out = await ownerChannel.handleOwnerMessage({ tenantId: 'claimOwner', session, msg, channel: 'WHATSAPP' }, {
      getSettings: async () => ({ whatsapp: false }),
      chat: async () => ({ text: "C'est fait, le Service Métier RIEA Afrique est créé et activé." }),
      history: { load: async () => [], append: async () => {} },
    });
    assert.equal(out.handled, 'CHAT');
    assert.equal(sentTexts.length, 1); assert.match(sentTexts[0], /Je n'ai rien exécuté/); assert.doesNotMatch(sentTexts[0], /est créé/);
    const msg2 = { key: { id: 'S2', remoteJid: '22670099999@s.whatsapp.net', fromMe: true }, message: { conversation: 'Crée le service RIEA' } };
    await ownerChannel.handleOwnerMessage({ tenantId: 'claimOwner', session, msg: msg2, channel: 'WHATSAPP' }, {
      getSettings: async () => ({}), chat: async () => ({ text: "✅ C'est configuré : le service « RIEA » est créé.", toolCall: { name: 'configureBusinessService', state: 'SUCCESS' } }),
      history: { load: async () => [], append: async () => {} },
    });
    assert.match(sentTexts[1], /C'est configuré/, 'avec preuve, la confirmation est envoyée');
  } finally { adapter.reply = origReply; adapter.isOwnerContext = origIsOwner; }
});
