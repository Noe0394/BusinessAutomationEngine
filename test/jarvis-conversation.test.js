// TEST — Jarvis conversationnel : intentions, refus respecté, anti-répétition,
// NO_ACTION, montants non inventés, isolation, concurrence/debounce, purge 7 j.
//   node --test test/jarvis-conversation.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-jarvis-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.SECRET_VAULT_KEY = 'test-vault-key-jarvis';

const businessServices = require('../ai-engine/businessServices');
const autoResponder = require('../ai-engine/autoResponder');
const contactCrm = require('../ai-engine/contactCrm');
const conversationState = require('../ai-engine/jarvis/conversationState');
const { classify } = require('../ai-engine/jarvis/intentClassifier');
const { ConversationQueue } = require('../ai-engine/jarvis/conversationQueue');
const storageAdapter = require('../ai-engine/storageAdapter');

const T = 'tJarvis';
let mid = 0;

// LLM de test : "vendeur pressant" qui essaie toujours de vendre (pire cas)
function pushyLlm(reply) { return async () => reply || 'La formation est à 8000 FCFA. Souhaitez-vous vous inscrire ?'; }
function runtime(record) {
  return { sendMessageVerified: async (p) => { record.push(p); return { status: 'SUCCESS', confirmationId: 'WAMID-J-' + record.length }; } };
}
async function say(from, text, llm, rec, extra) {
  return autoResponder.handleIncoming(
    { tenantId: T, channel: 'WHATSAPP', from, name: 'Client', text, messageId: 'm' + (++mid) },
    Object.assign({ runtime: runtime(rec), llm, debounceMs: 0, notify: async () => {} }, extra || {}),
  );
}

test('setup', async () => {
  await businessServices.create(T, { name: 'Cuisine', type: 'formation', products: [{ name: 'Formation Épicerie', price: 8000 }], commercial: { currency: 'FCFA' } });
  await autoResponder.setSettings(T, { whatsapp: true });
});

test('classification : les phrases-pièges du cahier des charges', () => {
  const expect = {
    'Non merci, ça ne m\'intéresse pas.': 'REFUSAL',
    'J\'ai dit non.': 'REFUSAL',
    'Je ne veux pas acheter': 'REFUSAL',
    'Ce n\'est pas intéressant pour moi': 'DISINTEREST',
    'Ne m\'écrivez plus': 'STOP',
    'Je vais réfléchir.': 'HESITATION',
    'Laissez-moi demander à mon mari.': 'HESITATION',
    'C\'est trop cher pour moi.': 'PRICE_OBJECTION',
    'Ce n\'est pas dans mon budget actuellement.': 'PRICE_OBJECTION',
    'Je veux m\'inscrire mais demain.': 'PURCHASE_INTENT',
    'Ok je paie demain': 'PAYMENT_INTENT',
    'Bonjour, combien coûte la formation ?': 'QUESTION',
    'Finalement, comment se passe l\'inscription ?': 'QUESTION',
    'Oui j\'ai compris, merci.': 'CONFIRMATION',
    'Merci': 'THANKS',
    'Non, je veux m\'inscrire': 'PURCHASE_INTENT',
  };
  for (const [text, intent] of Object.entries(expect)) assert.equal(classify(text).intent, intent, text);
  assert.equal(classify('Je veux m\'inscrire mais demain.').flags.deferral, 'demain');
  const rep = classify('Ça fait trois fois que je demande le prix…');
  assert.equal(rep.intent, 'QUESTION'); assert.ok(rep.flags.repeatComplaint);
  assert.notEqual(classify('Je vais réfléchir').intent, 'PAYMENT_INTENT');
});

test('question simple : répond avec le prix réellement configuré', async () => {
  const rec = [];
  const out = await say('22601', 'Bonjour, combien coûte la formation ?', pushyLlm('La formation est à 8000 FCFA.'), rec);
  assert.equal(out.sent, true);
  assert.match(rec[0].text, /8000/);
});

test('REFUS : le vendeur IA pressant est neutralisé, puis silence', async () => {
  const rec = [];
  const llm = pushyLlm();
  let out = await say('22602', 'Combien coûte la formation ?', pushyLlm('La formation est à 8000 FCFA.'), rec);
  assert.equal(out.sent, true);
  out = await say('22602', 'Non, je ne suis pas intéressé.', llm, rec);
  assert.ok(['REFUSAL', 'DISINTEREST'].includes(out.intent));
  assert.equal(rec.length, 2);
  assert.doesNotMatch(rec[1].text, /inscrire|8000|payer/i, 'aucune relance ni prix après un refus');
  out = await say('22602', 'J\'ai dit non.', llm, rec);
  assert.equal(out.skipped, 'NO_ACTION');
  out = await say('22602', 'Merci', llm, rec);
  assert.equal(out.skipped, 'NO_ACTION');
  assert.equal(rec.length, 2, 'plus aucun envoi');
  assert.equal(await contactCrm.isOptedOut(T, 'WHATSAPP', '22602'), true);
  const st = await conversationState.get(T, 'WHATSAPP', '22602');
  assert.equal(st.state, 'REFUSED');
  assert.equal(st.refusal.active, true);
});

test('le client refusant revient de lui-même : la conversation se rouvre', async () => {
  const rec = [];
  await say('22603', 'Non merci', pushyLlm(), rec);
  const out = await say('22603', 'Finalement, combien coûte la formation ?', pushyLlm('Elle est à 8000 FCFA.'), rec);
  assert.equal(out.sent, true);
  const st = await conversationState.get(T, 'WHATSAPP', '22603');
  assert.equal(st.refusal.active, false);
  assert.equal(await contactCrm.isOptedOut(T, 'WHATSAPP', '22603'), false);
});

test('STOP : opt-out définitif, aucune réponse ensuite', async () => {
  const rec = [];
  await say('22604', 'Ne m\'écrivez plus svp', pushyLlm(), rec);
  assert.match(rec[0].text, /ne vous contacterai plus/);
  const out = await say('22604', 'stop', pushyLlm(), rec);
  assert.equal(out.skipped, 'NO_ACTION');
  assert.equal(await contactCrm.isOptedOut(T, 'WHATSAPP', '22604'), true);
});

test('hésitation : jamais de relance de paiement', async () => {
  const rec = [];
  const out = await say('22605', 'Je vais réfléchir.', pushyLlm(), rec);
  assert.equal(out.kind, 'WAIT');
  assert.doesNotMatch(rec[0].text, /inscrire|payer|8000/i);
  const st = await conversationState.get(T, 'WHATSAPP', '22605');
  assert.equal(st.state, 'WAITING');
});

test('achat reporté : mémorisé, non redemandé', async () => {
  const rec = [];
  await say('22606', 'Je veux m\'inscrire mais demain.', async () => 'Parfait, je vous attends demain 😊', rec);
  const st = await conversationState.get(T, 'WHATSAPP', '22606');
  assert.equal(st.state, 'WAITING');
  assert.equal(st.memory.waiting.when, 'demain');
  assert.ok(st.memory.accepted.includes('achat'));
});

test('anti-répétition : la même réponse n\'est pas renvoyée deux fois', async () => {
  const rec = [];
  const llm = pushyLlm('La formation est à 8000 FCFA, elle dure deux semaines.');
  await say('22607', 'C\'est combien ?', llm, rec);
  const out = await say('22607', 'Et la durée ?', llm, rec);
  assert.equal(rec.length, 2);
  assert.notEqual(rec[1].text, rec[0].text);
  assert.match(rec[1].text, /déjà donné/);
  assert.ok(out.guard || out.sent);
});

test('anti-hallucination : montant absent des données -> jamais envoyé', async () => {
  const rec = [];
  const out = await say('22608', 'Quel est le prix ?', pushyLlm('La formation coûte 15000 FCFA.'), rec);
  assert.equal(out.sent, true);
  assert.doesNotMatch(rec[0].text, /15000/);
  assert.match(rec[0].text, /vérifier/);
});

test('isolation : le refus de A n\'affecte pas B', async () => {
  const recA = []; const recB = [];
  await say('22610', 'Non merci', pushyLlm(), recA);
  const outB = await say('22611', 'Combien ça coûte ?', pushyLlm('8000 FCFA.'), recB);
  assert.equal(outB.sent, true);
  const a = await conversationState.get(T, 'WHATSAPP', '22610');
  const b = await conversationState.get(T, 'WHATSAPP', '22611');
  assert.equal(a.refusal.active, true);
  assert.equal(b.refusal.active, false);
  assert.notEqual(a.conversationId, b.conversationId);
});

test('messages rapides : regroupés en UNE seule réponse', async () => {
  const rec = [];
  const llmSeen = [];
  const llm = async (p) => { llmSeen.push(p); return 'La formation est à 8000 FCFA.'; };
  const send = (t) => autoResponder.handleIncoming(
    { tenantId: T, channel: 'WHATSAPP', from: '22612', text: t, messageId: 'q' + (++mid) },
    { runtime: runtime(rec), llm, debounceMs: 80, notify: async () => {} },
  );
  const res = await Promise.all([send('Bonjour'), send('Je voudrais'), send('connaître le prix')]);
  assert.equal(rec.length, 1, 'une seule réponse');
  assert.equal(res.filter((r) => r.skipped === 'AGGREGATED').length, 2);
  assert.ok(llmSeen.some((p) => p.includes('Bonjour\nJe voudrais\nconnaître le prix')));
});

test('concurrence : plusieurs clients simultanés, sans mélange ni double réponse', async () => {
  const rec = [];
  const clients = ['22620', '22621', '22622', '22623', '22624', '22625'];
  const texts = ['C\'est combien ?', 'Je veux m\'inscrire', 'Non merci', 'Vous faites la formation en ligne ?', 'Je vais réfléchir', 'Merci'];
  const llm = pushyLlm('Réponse ok.');
  await Promise.all(clients.map((c, i) => say(c, texts[i], llm, rec, { debounceMs: 20 })));
  const perClient = {};
  rec.forEach((r) => { perClient[r.to] = (perClient[r.to] || 0) + 1; });
  assert.ok(Object.values(perClient).every((n) => n === 1), JSON.stringify(perClient));
  const st = await conversationState.get(T, 'WHATSAPP', '22622');
  assert.equal(st.state, 'REFUSED');
});

test('file : traitement en série par conversation', async () => {
  const q = new ConversationQueue();
  const order = [];
  const proc = (tag) => async (items) => { order.push('start-' + items.join('')); await new Promise((r) => setTimeout(r, 40)); order.push('end-' + items.join('')); return tag; };
  const a = q.submit('k', 'A', proc('A'), { debounceMs: 0 });
  await new Promise((r) => setTimeout(r, 10));
  const b = q.submit('k', 'B', proc('B'), { debounceMs: 0 });
  await Promise.all([a, b]);
  assert.deepEqual(order, ['start-A', 'end-A', 'start-B', 'end-B']);
});

test('mémoire d\'état : purge exacte 7×24 h', async () => {
  const NOW = Date.now();
  const mk = async (from, updatedAt) => {
    const doc = conversationState.blank(T, 'WHATSAPP', from);
    storageAdapter.set(conversationState.NAMESPACE, doc.conversationId, Object.assign(doc, { updatedAt }));
    return doc.conversationId;
  };
  const W = 7 * 24 * 3600 * 1000;
  const old = await mk('p-old', NOW - W - 1000);
  const edge = await mk('p-edge', NOW - W);
  const recent = await mk('p-recent', NOW - W + 1000);
  const future = await mk('p-future', NOW + 1000);
  await conversationState.purgeExpired(NOW);
  const ids = storageAdapter.listIds(conversationState.NAMESPACE);
  assert.ok(!ids.includes(old), 'cutoff - 1 s -> supprimé');
  assert.ok(ids.includes(edge), 'cutoff exactement -> conservé');
  assert.ok(ids.includes(recent), 'now - 1 semaine + 1 s -> conservé');
  assert.ok(!ids.includes(future), 'now + 1 s -> exclu');
});

test('local-first : les namespaces de conversation ne sont pas mirrorés', () => {
  for (const ns of ['message_history', 'conversation_state', 'crm_contacts', 'closer_sessions']) assert.equal(storageAdapter.isMirrored(ns), false, ns);
  assert.equal(storageAdapter.isMirrored('business_services'), true);
});

test('emotionalCloser (chemin AUTO_CLOSE) : même moteur, refus respecté et pas de cache répétitif', async () => {
  const llmFallbackEngine = require('../lib/ai/llmFallbackEngine');
  const emotionalCloser = require('../ai-engine/emotionalCloser');
  const orig = llmFallbackEngine.generateAIResponse;
  let calls = 0;
  llmFallbackEngine.generateAIResponse = async () => { calls += 1; return { text: `Réponse numéro ${calls}. Souhaitez-vous vous inscrire ?` }; };
  try {
    const a = await emotionalCloser.handleCustomerMessage({ tenantId: 'tCloser', channel: 'WHATSAPP', from: '22630001', text: 'Non merci, pas intéressé.' });
    assert.ok(a && !/inscrire/i.test(a), 'refus : pas de relance');
    const b = await emotionalCloser.handleCustomerMessage({ tenantId: 'tCloser', channel: 'WHATSAPP', from: '22630001', text: 'J\'ai dit non' });
    assert.equal(b, null, 'refus déjà pris en compte : silence');
    const c = await emotionalCloser.handleCustomerMessage({ tenantId: 'tCloser', channel: 'WHATSAPP', from: '22630002', text: 'Vous faites la formation en ligne ?' });
    const d = await emotionalCloser.handleCustomerMessage({ tenantId: 'tCloser', channel: 'WHATSAPP', from: '22630002', text: 'Vous faites la formation en ligne ?' });
    assert.ok(c);
    assert.notEqual(d, c, 'pas la même réponse mot pour mot');
  } finally { llmFallbackEngine.generateAIResponse = orig; }
});

test('local-first mesuré : une conversation complète = 0 écriture GitHub, la config métier reste mirrorée', async () => {
  const githubStore = require('../githubStore');
  const origCreate = githubStore.createStore;
  const pushed = [];
  githubStore.createStore = (p) => ({ enabled: true, pushRemote: async () => { pushed.push(p); }, fetchRemote: async () => null });
  try {
    const rec = [];
    await say('22699', 'Bonjour, combien coûte la formation ?', pushyLlm('La formation est à 8000 FCFA.'), rec);
    await say('22699', 'Non merci', pushyLlm(), rec);
    const convoWrites = pushed.filter((p) => /message_history|conversation_state|conversation_index|closer_sessions|crm_contacts|activity/.test(p));
    assert.equal(convoWrites.length, 0, `écritures GitHub de conversation: ${convoWrites.join(', ')}`);
    storageAdapter.set('business_services', 'tLocalFirst', { ok: true });
    assert.ok(pushed.some((p) => /business_services/.test(p)), 'la configuration métier reste sauvegardée');
  } finally { githubStore.createStore = origCreate; }
});

test('charge : 40 clients × 3 messages rapides -> exactement 1 réponse par client, aucun mélange', async () => {
  const rec = [];
  const N = 40;
  const jobs = [];
  for (let c = 0; c < N; c += 1) {
    const from = '2270' + String(1000 + c);
    const llm = async (p) => `Réponse pour ${from} ${p.includes(from) ? '' : ''}`.trim() + ` #${c}`;
    for (const t of ['Bonjour', 'je voudrais', 'connaître le prix']) {
      jobs.push(autoResponder.handleIncoming(
        { tenantId: T, channel: 'WHATSAPP', from, text: t + ' ' + c, messageId: `load-${c}-${t}` },
        { runtime: runtime(rec), llm, debounceMs: 30, notify: async () => {} },
      ));
    }
  }
  const res = await Promise.all(jobs);
  const per = {};
  rec.forEach((r) => { per[r.to] = (per[r.to] || 0) + 1; });
  assert.equal(Object.keys(per).length, N, 'tous les clients servis');
  assert.ok(Object.values(per).every((n) => n === 1), 'une seule réponse chacun');
  rec.forEach((r) => { const c = r.to.slice(4); assert.ok(r.text.endsWith('#' + (Number(c) - 1000)), `contexte isolé pour ${r.to}: ${r.text}`); });
  assert.equal(res.filter((r) => r.skipped === 'AGGREGATED').length, N * 2);
});

test('défaut réel corrigé : un message d\'erreur fournisseur n\'est jamais une réponse client', async () => {
  const llmFallbackEngine = require('../lib/ai/llmFallbackEngine');
  assert.equal(llmFallbackEngine.looksLikeProviderError('The account behind this API key doesn\'t have enough credits. Please top up'), true);
  assert.equal(llmFallbackEngine.looksLikeProviderError('Bonjour, la formation est à 8000 FCFA. Une question ?'), false);
  // cascade totalement en échec -> message d'attente honnête, jamais de texte technique
  const rec = [];
  const out = await say('22640', 'Vous faites la formation en ligne ?', async () => { throw new Error('Tous les fournisseurs LLM ont échoué'); }, rec);
  assert.equal(out.sent, true);
  assert.match(rec[0].text, /reviens vers vous/);
});
