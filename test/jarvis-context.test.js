// TEST — Pertinence avant conversion : pas de promotion non sollicitée, contextes sensibles, groupes,
// activité humaine, protection anti-boucle, sujet courant, données privées, IA indisponible.
//   node --test test/jarvis-context.test.js
'use strict';

require('./helpers/auth').actAsAdmin(); // identité authentifiée de test (deny-by-default : voir ai-engine/authz.js)
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-ctx-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.SECRET_VAULT_KEY = 'test-vault-key-ctx';

const businessServices = require('../ai-engine/businessServices');
const autoResponder = require('../ai-engine/autoResponder');
const conversationState = require('../ai-engine/jarvis/conversationState');
const { classify } = require('../ai-engine/jarvis/intentClassifier');

const T = 'tCtx';
let mid = 0;
const PROMO = /formation|8\s?000|fcfa|prix|offre|inscri/i;
const pushy = (prompts) => async (p) => { if (prompts) prompts.push(p); return 'Bien sûr ! Nous avons aussi une formation à 8000 FCFA, souhaitez-vous vous inscrire ?'; };
function runtime(rec) { return { sendMessageVerified: async (p) => { rec.push(p); return { status: 'SUCCESS', confirmationId: 'W-' + rec.length }; } }; }
async function say(from, text, llm, rec, extra) {
  return autoResponder.handleIncoming(
    { tenantId: T, channel: 'WHATSAPP', from, name: 'C', text, messageId: 'c' + (++mid) },
    Object.assign({ runtime: runtime(rec), llm, debounceMs: 0, notify: async () => {} }, extra || {}),
  );
}

test('setup', async () => {
  await businessServices.create(T, { name: 'Formation Épicerie', type: 'formation', products: [{ name: 'Formation Épicerie', price: 8000 }], commercial: { currency: 'FCFA' } });
  await autoResponder.setSettings(T, { whatsapp: true, telegram: true });
});

test('classification : contextes sensibles et bavardage', () => {
  assert.equal(classify('Mon père est décédé hier').flags.sensitive, 'GRIEF');
  assert.equal(classify('Que Dieu nous accompagne dans cette épreuve.').flags.sensitive, 'PRAYER');
  assert.equal(classify('Il est à l\'hôpital, très malade').flags.sensitive, 'HEALTH');
  assert.equal(classify('Au secours, il y a eu un accident').flags.sensitive, 'URGENT');
  assert.equal(classify('Ça va bien et toi ?').flags.smalltalk, true);
  assert.equal(classify('Combien coûte la formation ?').flags.sensitive, null);
  assert.equal(classify('Je veux une opération promo sur la formation').flags.sensitive, null, 'pas de faux positif « opération »');
});

test('Cas 1 : « Bonjour » -> réponse naturelle SANS appel IA et sans promotion', async () => {
  const rec = []; let calls = 0;
  await say('9001', 'Bonjour', async () => { calls += 1; return pushy()(); }, rec);
  assert.equal(calls, 0, 'aucune IA nécessaire pour une salutation');
  assert.doesNotMatch(rec[0].text, PROMO);
});

test('Cas 2 : « Ça va bien et toi ? » -> aucune offre, même si le modèle en glisse une', async () => {
  const rec = [];
  await say('9002', 'Ça va bien et toi ?', pushy(), rec);
  assert.ok(rec[0]);
  assert.doesNotMatch(rec[0].text, PROMO);
});

test('Deuil / prière : jamais de promotion, réponse respectueuse', async () => {
  const rec = [];
  await say('9003', 'Mon père est décédé hier.', pushy(), rec);
  await say('9004', 'Que Dieu nous accompagne dans cette épreuve.', pushy(), rec);
  assert.equal(rec.length, 2);
  for (const r of rec) assert.doesNotMatch(r.text, PROMO);
});

test('Cas 3-4 : intérêt explicite -> l\'IA peut informer ; le prix est autorisé', async () => {
  const rec = [];
  await say('9005', 'Je voulais avoir des informations sur vos formations.', async () => 'Nous proposons la Formation Épicerie à 8000 FCFA.', rec);
  assert.match(rec[0].text, /8000/);
});

test('Cas 6 : « je vais réfléchir » -> aucune offre additionnelle', async () => {
  const rec = [];
  await say('9006', 'Combien coûte la formation ?', async () => 'La Formation Épicerie est à 8000 FCFA.', rec);
  await say('9006', 'D\'accord merci, je vais réfléchir.', pushy(), rec);
  assert.doesNotMatch(rec[1].text, /autre formation|8\s?000|inscri/i);
});

test('sujet courant : « combien ça coûte ? » est rattaché à la formation citée avant', async () => {
  const rec = []; const prompts = [];
  await say('9007', 'Je suis intéressé par la Formation Épicerie', async () => 'Très bien, je vous explique.', rec);
  await say('9007', 'Combien ça coûte ?', async (p) => { prompts.push(p); return 'La Formation Épicerie coûte 8000 FCFA.'; }, rec);
  const st = await conversationState.get(T, 'WHATSAPP', '9007');
  assert.equal(st.memory.subject, 'Formation Épicerie');
  assert.ok(prompts.some((p) => p.includes('Sujet courant de la conversation : Formation Épicerie')));
});

test('groupes : silence par défaut, réponse seulement si configuré ET demande commerciale explicite', async () => {
  const rec = [];
  const g = '2250101@g.us';
  const a = await say(g, 'Bonjour tout le monde', pushy(), rec);
  assert.equal(a.skipped, 'NO_ACTION'); assert.equal(a.reason, 'GROUP_NOT_ADDRESSED');
  assert.equal((await say(g, 'Combien coûte la formation ?', async () => 'C\'est 8000 FCFA.', rec)).skipped, 'NO_ACTION', 'groupReplies désactivé par défaut');
  await autoResponder.setSettings(T, { groupReplies: true });
  assert.equal((await say(g, 'Combien coûte la formation ?', async () => 'C\'est 8000 FCFA.', rec)).sent, true);
  assert.equal((await say(g, 'Que Dieu nous accompagne dans cette épreuve.', pushy(), rec)).skipped, 'NO_ACTION', 'jamais de promotion dans un contexte sensible de groupe');
  await autoResponder.setSettings(T, { groupReplies: false });
});

test('activité humaine : Cyrus se tait après un message écrit par l\'utilisateur (sauf STOP)', async () => {
  const rec = [];
  await autoResponder.handleHumanActivity({ tenantId: T, channel: 'WHATSAPP', from: '9010' });
  const out = await say('9010', 'Combien coûte la formation ?', pushy(), rec);
  assert.equal(out.skipped, 'NO_ACTION'); assert.equal(out.reason, 'HUMAN_ACTIVE');
  assert.equal(rec.length, 0);
  const stop = await say('9010', 'Ne m\'écrivez plus', pushy(), rec);
  assert.equal(stop.intent, 'STOP', 'une demande d\'arrêt passe toujours');
  await autoResponder.setSettings(T, { humanPauseMinutes: 0 });
  assert.equal(await autoResponder.handleHumanActivity({ tenantId: T, channel: 'WHATSAPP', from: '9011' }), null, 'désactivable');
  await autoResponder.setSettings(T, { humanPauseMinutes: 30 });
});

test('boucle entre deux automatisations : au-delà de 8 messages en 2 min, silence', async () => {
  const rec = [];
  let last;
  for (let i = 0; i < 11; i += 1) last = await say('9020', 'ok merci ' + i + ' ping', async () => 'Avec plaisir', rec);
  assert.equal(last.skipped, 'NO_ACTION');
  assert.equal(last.reason, 'LOOP_PROTECTION');
  assert.ok(rec.length <= 9);
});

test('fuite de coordonnées : un numéro inventé par le modèle n\'est jamais envoyé', async () => {
  const rec = [];
  await say('9030', 'Combien coûte la formation ?', async () => 'La Formation Épicerie est à 8000 FCFA. Appelez le 22670999888 pour payer.', rec);
  assert.doesNotMatch(rec[0].text, /22670999888/);
});

test('IA indisponible : salutation, remerciement et bavardage restent servis sans publicité', async () => {
  const rec = [];
  const down = async () => { throw new Error('Tous les fournisseurs LLM ont échoué'); };
  await say('9040', 'Bonsoir', down, rec);
  await say('9041', 'Ça va ? Et toi ?', down, rec);
  await say('9042', 'Vous faites la formation en ligne ?', down, rec);
  assert.equal(rec.length, 3);
  for (const r of rec.slice(0, 2)) assert.doesNotMatch(r.text, PROMO);
  assert.match(rec[2].text, /reviens vers vous/);
});
