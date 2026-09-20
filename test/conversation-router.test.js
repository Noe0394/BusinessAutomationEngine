// TEST RUNNER — routeur de conversations (privé / métier / urgent) + handoff.
//   node --test test/conversation-router.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-router-'));
const router = require('../ai-engine/conversationRouter');
const alertCenter = require('../ai-engine/alertCenter');
const contactIdentity = require('../ai-engine/contactIdentity');
const storage = require('../ai-engine/storageAdapter');
const conversationState = require('../ai-engine/jarvis/conversationState');

function harness() {
  const notes = []; const sent = [];
  alertCenter.setDeliverers([async (tenant, text) => { notes.push(text); return { ok: true, channel: 'test', messageId: 'N' + notes.length }; }]);
  const send = async (text) => { sent.push(text); return { status: 'SUCCESS' }; };
  return { notes, sent, send };
}
let seq = 0;
async function incoming(tenant, from, text, h, extra) {
  const identity = await contactIdentity.resolveContact(tenant, Object.assign({ jid: from, pushName: 'Jean Dupont' }, extra || {}));
  return router.processBatch({ tenantId: tenant, channel: 'WHATSAPP', from, identity, items: [{ text, messageId: `M${++seq}` }] }, { send: h.send });
}

test('classification : exemples du cahier des charges', () => {
  const cat = (t, ctx) => router.classify(t, ctx).category;
  assert.equal(cat('Est-ce que ta maman est à la maison ?'), 'PRIVATE_SENSITIVE');
  assert.equal(cat('Tu es où ?'), 'PRIVATE_PERSONAL');
  assert.equal(cat('Dis-moi quand tu es disponible.'), 'PRIVATE_PERSONAL');
  assert.equal(cat("J'ai quelque chose d'important à te dire."), 'PRIVATE_SENSITIVE');
  assert.equal(cat('Est-ce que tu peux me rappeler ?'), 'CALLBACK_REQUEST');
  assert.equal(cat('Tu peux me confirmer ce que tu avais dit hier ?'), 'PRIVATE_PERSONAL');
  assert.equal(cat("J'ai un problème avec ta famille"), 'PRIVATE_SENSITIVE');
  assert.equal(cat('Est-ce que tu peux me rendre ce service ?'), 'PRIVATE_PERSONAL');
  assert.equal(cat("Tu es disponible aujourd'hui ?"), 'PRIVATE_PERSONAL');
  assert.equal(cat("Il faut qu'on parle d'une affaire personnelle."), 'PRIVATE_SENSITIVE');
  assert.equal(cat('Au secours il y a eu un accident'), 'URGENT');
  assert.equal(cat('Salut, tu vas bien ?'), 'PRIVATE_CASUAL');
  assert.equal(cat('Merci beaucoup !'), 'PRIVATE_CASUAL');
  assert.equal(cat("Je t'ai envoyé le document."), 'PRIVATE_CASUAL');
  assert.equal(cat('Bonjour, combien coûte la formation ?'), 'BUSINESS_LEAD');
  assert.equal(cat("Je veux m'inscrire à la formation"), 'BUSINESS_LEAD');
});

test('le contexte compte : contact client connu vs question sans contexte', () => {
  const clientCtx = { crmContact: { tags: ['client'], stage: 'client' } };
  assert.equal(router.classify("Je n'arrive pas à me connecter à ma formation", clientCtx).category, 'CUSTOMER_SUPPORT');
  assert.notEqual(router.classify("Tu peux m'envoyer ça ?", {}).category, 'PRIVATE_CASUAL');
});

test('TEST 1 : message banal -> réponse automatique, aucune fausse alerte', async () => {
  const h = harness();
  const r = await incoming('r1', '22670123456@s.whatsapp.net', 'Salut, tu vas bien ?', h);
  assert.equal(r.mode, 'AUTO_REPLY');
  assert.equal(r.replied, true);
  assert.match(h.sent[0], /ça va|Ça va/i);
  assert.equal(h.notes.length, 0, 'aucune notification pour un message banal');
});

test("TEST 2 : question personnelle -> alerte avec le nom, aucune invention, réponse d'attente", async () => {
  const h = harness();
  const r = await incoming('r2', '218374650128374@lid', 'Est-ce que ta maman est à la maison ?', h);
  assert.equal(r.mode, 'HUMAN_REQUIRED');
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /Jean Dupont vient de t'écrire/);
  assert.match(h.notes[0], /Est-ce que ta maman est à la maison/);
  assert.match(h.notes[0], /n'a pas répondu automatiquement/);
  assert.ok(!/@lid|218374650128374/.test(h.notes[0]), 'aucun identifiant technique');
  assert.equal(h.sent.length, 1);
  assert.ok(!/maman|maison|oui|non|elle est/i.test(h.sent[0]), 'la réponse au contact n\'invente rien');
});

test('TEST 3 : 5 messages rapides -> 1 notification immédiate puis récapitulatif, contexte conservé', async () => {
  const h = harness();
  await storage.set('auto_settings', 'r3', { tenant: 'r3', alertPolicy: { aggregateWindowMs: 1500 } });
  const from = '22670555111@s.whatsapp.net';
  const texts = ['Salut', "j'ai besoin de te parler", "c'est important", 'réponds-moi vite', "j'ai un problème avec ta famille"];
  for (const t of texts) await incoming('r3', from, t, h);
  assert.equal(h.notes.length, 1, 'une seule notification immédiate');
  await new Promise((res) => setTimeout(res, 1900));
  assert.equal(h.notes.length, 2);
  assert.match(h.notes[1], /vient d'envoyer \d+ messages/);
  const st = await conversationState.get('r3', 'WHATSAPP', from);
  assert.equal(st.handoff.state, 'HUMAN_REQUIRED');
  assert.ok(st.handoff.contactLabel);
  assert.ok(h.sent.length <= 2, `réponses d'attente: ${h.sent.length}`);
});

test('TEST 4/5/6 : nom, vrai numéro seul, identifiant technique seul', async () => {
  const h = harness();
  await incoming('r4', '22670000001@s.whatsapp.net', 'Tu es où ?', h, { pushName: 'Marie Kaboré' });
  assert.match(h.notes[0], /^🔔 Marie Kaboré vient de t'écrire/);
  const h2 = harness();
  await incoming('r5', '22670000002@s.whatsapp.net', 'Tu es où ?', h2, { pushName: null });
  assert.match(h2.notes[0], /\+226 70 00 00 02 vient de t'écrire/);
  const h3 = harness();
  await incoming('r6', '999888777666555@lid', 'Tu es où ?', h3, { pushName: null });
  assert.match(h3.notes[0], /Contact WhatsApp non identifié vient de t'écrire/);
  assert.ok(!/\d{9,}/.test(h3.notes[0]), 'aucune longue série de chiffres');
  assert.ok(!/\+999|\+2\d/.test(h3.notes[0]), 'aucun faux numéro fabriqué');
});

test("handoff : pas de réponse d'attente en boucle, HUMAN_ACTIVE silencieux, reprise AI_RESUMED", async () => {
  const h = harness();
  const from = '22670777000@s.whatsapp.net';
  await incoming('r7', from, 'Tu es où ?', h);
  const waiting1 = h.sent.length;
  assert.equal(waiting1, 1);
  await incoming('r7', from, 'Réponds-moi stp ?', h);
  assert.equal(h.sent.length, waiting1, "pas de seconde réponse d'attente dans la fenêtre");
  await router.noteOwnerTookOver('r7', 'WHATSAPP', from, 60);
  const r = await incoming('r7', from, 'Salut, tu vas bien ?', h);
  assert.equal(r.mode, 'SILENT');
  assert.equal(h.sent.length, waiting1, 'aucune réponse automatique pendant HUMAN_ACTIVE');
  await router.resumeAutomation('r7', 'WHATSAPP', from);
  const r2 = await incoming('r7', from, 'Merci beaucoup !', h);
  assert.equal(r2.mode, 'AUTO_REPLY');
  assert.equal((await router.getHandoff('r7', 'WHATSAPP', from)).state, 'AI_RESUMED');
});

test('listAwaitingOwner : états réels', async () => {
  const h = harness();
  await incoming('r8', '22670888000@s.whatsapp.net', 'Est-ce que tu peux me rappeler ?', h, { pushName: 'Awa' });
  await incoming('r8', '22670888001@s.whatsapp.net', 'Salut, tu vas bien ?', h, { pushName: 'Ben' });
  const list = await router.listAwaitingOwner('r8');
  assert.equal(list.length, 1);
  assert.equal(list[0].contactLabel, 'Awa');
  assert.equal(list[0].category, 'CALLBACK_REQUEST');
});

test('groupes : silence total ; doublon ignoré ; « ok » seul : pas de réponse', async () => {
  const h = harness();
  const gid = '120363041234567890@g.us';
  const identity = await contactIdentity.resolveContact('r9', { jid: gid });
  const g = await router.processBatch({ tenantId: 'r9', channel: 'WHATSAPP', from: gid, identity, isGroup: true, items: [{ text: 'Tu es où ?', messageId: 'G1' }] }, { send: h.send });
  assert.equal(g.mode, 'SILENT');
  assert.equal(h.sent.length + h.notes.length, 0);
  const from = '22670999000@s.whatsapp.net';
  const id2 = await contactIdentity.resolveContact('r9', { jid: from, pushName: 'Paul' });
  const item = { text: 'Merci beaucoup !', messageId: 'DUP1' };
  await router.processBatch({ tenantId: 'r9', channel: 'WHATSAPP', from, identity: id2, items: [item] }, { send: h.send });
  const again = await router.processBatch({ tenantId: 'r9', channel: 'WHATSAPP', from, identity: id2, items: [item] }, { send: h.send });
  assert.equal(again.reason, 'DUPLICATE');
  assert.equal(h.sent.length, 1);
  const before = h.sent.length;
  await incoming('r9', from, 'ok', h);
  assert.equal(h.sent.length, before, '« ok » seul ne déclenche aucune réponse');
});

test('arbitrage IA : ne peut que renforcer la prudence', async () => {
  const base = { category: 'OTHER', confidence: 0.4, reason: 'x', sensitivity: 'low', signals: [] };
  const msg = 'message assez long et ambigu ici';
  const toOwner = await router.arbitrate(base, msg, async () => '{"category":"PRIVATE_PERSONAL","needsOwner":true}');
  assert.equal(toOwner.category, 'PRIVATE_PERSONAL');
  const tryCasual = await router.arbitrate(base, msg, async () => '{"category":"PRIVATE_CASUAL","needsOwner":false}');
  assert.equal(tryCasual.category, 'OTHER', 'jamais de déblocage automatique sur avis IA');
  const broken = await router.arbitrate(base, msg, async () => 'pas du json');
  assert.equal(broken.category, 'OTHER');
});

test('politique notifyCasual : réponse automatique + alerte', async () => {
  const h = harness();
  await storage.set('auto_settings', 'r10', { tenant: 'r10', alertPolicy: { notifyCasual: true } });
  const r = await incoming('r10', '22670121212@s.whatsapp.net', 'Salut, tu vas bien ?', h);
  assert.equal(r.mode, 'AUTO_REPLY_NOTIFY');
  assert.equal(h.sent.length, 1);
  assert.equal(h.notes.length, 1);
  assert.match(h.notes[0], /Réponse automatique envoyée/);
});

test('RÉGRESSION (messages réellement reçus sur le compte de test) : intérêt commercial, message automatique, long texte collé', async () => {
  const cat = (t) => router.classify(t, {}).category;
  // ces messages étaient partis en « intervention humaine » avec une réponse d'attente
  assert.equal(cat('Je suis intéressée'), 'BUSINESS_LEAD');
  assert.equal(cat('Bonjour je suis intéressée'), 'BUSINESS_LEAD');
  assert.equal(cat('Bonjour ! Puis-je en savoir plus à ce sujet ?'), 'BUSINESS_LEAD');
  // accueil automatique d'un autre assistant : aucune réponse, aucune alerte (anti-boucle bot <-> bot)
  assert.equal(cat('Bonjour 👋 Merci de nous avoir écrit ! Dites-moi ce qui vous intéresse, je vous réponds tout de suite.'), 'AUTOMATED_MESSAGE');
  const h = harness();
  const auto = await incoming('rg1', '22670444555@s.whatsapp.net', 'Bonjour 👋 Merci de nous avoir écrit ! Dites-moi ce qui vous intéresse, je vous réponds tout de suite.', h);
  assert.equal(auto.mode, 'SILENT');
  assert.equal(h.sent.length + h.notes.length, 0);
  // un long texte collé ne devient pas « urgent/critique » à cause d'un mot isolé
  const longText = 'Nouvelle implémentation : ' + 'blabla technique '.repeat(40) + ' il faut agir vite, tout de suite, sans accident.';
  assert.notEqual(cat(longText), 'URGENT');
  // une simple appréciation n'est pas une demande d'offre
  assert.equal(cat('parfait merci'), 'PRIVATE_CASUAL');
  assert.equal(require('../ai-engine/groupCampaigns').isInterest('Super promo !'), false);
  assert.equal(require('../ai-engine/groupCampaigns').isInterest("Je suis intéressée, c'est combien ?"), true);
});

test('IA : les réponses privées sont COMPOSÉES par l\'IA (gabarit seulement en secours) et gardent leurs garde-fous', async () => {
  const from = '22670123000@s.whatsapp.net';
  const identity = await contactIdentity.resolveContact('ai1', { jid: from, pushName: 'Awa' });
  const sent = []; const send = async (t) => { sent.push(t); return { status: 'SUCCESS' }; };
  const prompts = [];
  const llm = async (p) => { prompts.push(p); return /transmets le message/.test(p) ? 'Je lui transmets ton message, il te répond directement 🙂' : 'Salut Awa ! Très bien merci, et toi ? 😊'; };
  // conversation banale -> réponse rédigée par l'IA
  await router.processBatch({ tenantId: 'ai1', channel: 'WHATSAPP', from, identity, items: [{ text: 'Salut, tu vas bien ?', messageId: 'AI1' }] }, { send, llm });
  assert.equal(sent[0], 'Salut Awa ! Très bien merci, et toi ? 😊');
  assert.match(prompts[0], /N'invente JAMAIS/);
  // sujet personnel -> réponse d'attente rédigée par l'IA, sans répondre à la question
  await router.processBatch({ tenantId: 'ai1', channel: 'WHATSAPP', from, identity, items: [{ text: 'Est-ce que ta maman est à la maison ?', messageId: 'AI2' }] }, { send, llm });
  assert.equal(sent[1], 'Je lui transmets ton message, il te répond directement 🙂');
  assert.match(prompts[1], /NE réponds PAS à la question/);
  // sortie IA invalide (chiffres, lien, trop longue) -> rejetée, gabarit de secours ; jamais d'invention transmise
  for (const bad of ['Il est à la maison depuis 18h30', 'Voici le lien https://x.example', 'x'.repeat(400)]) {
    assert.equal(await router.aiCompose('casual', { text: 'Salut', name: 'Awa', recent: [], llm: async () => bad }), null, bad.slice(0, 30));
  }
  const fallback = await router.processBatch({ tenantId: 'ai1', channel: 'WHATSAPP', from: '22670123001@s.whatsapp.net', identity: await contactIdentity.resolveContact('ai1', { jid: '22670123001@s.whatsapp.net', pushName: 'Ben' }), items: [{ text: 'Merci beaucoup !', messageId: 'AI3' }] }, { send, llm: async () => { throw new Error('IA indisponible'); } });
  assert.equal(fallback.replied, true, 'IA en panne : réponse de secours, jamais de silence');
});

test('questions ouvertes : traitées par l\'IA conversationnelle (moteur commercial), plus renvoyées systématiquement au propriétaire', () => {
  assert.equal(router.classify('Tu peux m\'envoyer ça ?', {}).category, 'GENERAL_INFORMATION');
  assert.equal(router.decide(router.classify('Vous livrez le samedi ?', {}), {}).mode, 'BUSINESS');
  // les sujets réellement privés/sensibles restent au propriétaire (jamais d'invention)
  assert.equal(router.decide(router.classify('Est-ce que ta maman est à la maison ?', {}), {}).mode, 'HUMAN_REQUIRED');
});
