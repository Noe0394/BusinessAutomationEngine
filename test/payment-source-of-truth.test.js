// TEST — le paiement n'est JAMAIS un « lien à configurer » (Cyrus n'a pas cette fonction) : source de vérité UNIQUE = le(s) moyen(s) réellement
// configuré(s) dans le Service métier (commercial.paymentTerms), pour n'importe quel métier. Sans moyen configuré, le dit clairement, n'invente rien.
//   node --test test/payment-source-of-truth.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-pay-'));
process.env.GITHUB_TOKEN = ''; process.env.GEMINI_API_KEY = 'test-key';
require('./helpers/auth').actAsAdmin();
const businessServices = require('../ai-engine/businessServices');
const emotionalCloser = require('../ai-engine/emotionalCloser');
const chatOrchestrator = require('../ai-engine/chatOrchestrator');

test("les prompts système n'affirment plus « générer des liens de paiement / créer des comptes élèves » comme des capacités réelles", () => {
  const root = path.join(__dirname, '..');
  for (const f of ['lib/ai/llmFallbackEngine.js', 'ai-engine/personaManager.js']) {
    // Seul le CODE RUNTIME compte (le texte réellement envoyé au modèle) : les commentaires expliquant le correctif citent
    // volontairement l'ancienne phrase, donc exclus de la vérification.
    const code = fs.readFileSync(path.join(root, f), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert.doesNotMatch(code, /g[ée]n[ée]rer des liens de paiement/i, f);
    assert.match(code, /ne sais PAS g[ée]n[ée]rer de lien de paiement/i, f);
  }
});

test('emotionalCloser (prospects) : lit le VRAI Service métier, pas une variable d\'environnement globale ; générique pour n\'importe quel métier', async () => {
  const T = 'payA'; await businessServices.create(T, { name: 'Boutique', commercial: { paymentTerms: 'Wave : 07 00 00 00 00' } });
  const profile = { offers: [{ name: 'Robe', price: '15000 FCFA' }] };
  const withPayment = await emotionalCloser.buildBusinessFacts(profile, T);
  assert.match(withPayment.facts, /Wave : 07 00 00 00 00/); assert.match(withPayment.facts, /communique-les tels quels, jamais un lien/);
  const T2 = 'payB'; await businessServices.create(T2, { name: 'Traiteur' }); // aucun paymentTerms
  const noPayment = await emotionalCloser.buildBusinessFacts(profile, T2);
  assert.match(noPayment.facts, /Aucun moyen de paiement n'est configuré/); assert.match(noPayment.facts, /ne promets jamais de lien de paiement/);
  const noTenant = await emotionalCloser.buildBusinessFacts(profile);
  assert.match(noTenant.facts, /Aucun moyen de paiement/);
});

test('buildPersonaFacts (Chat intelligent / Self, objectifs) : lit aussi le VRAI Service métier, pas MOBILE_MONEY_* global', async () => {
  const T = 'payC'; await businessServices.create(T, { name: 'Restaurant', lifecycle: 'active', commercial: { paymentTerms: 'Orange Money : 05 11 22 33 44' } });
  const orig = process.env.MOBILE_MONEY_ORANGE; delete process.env.MOBILE_MONEY_ORANGE; // même sans variable globale, doit détecter le vrai moyen configuré
  try {
    const idx = fs.readFileSync(path.join(__dirname, '..', 'ai-engine', 'chatOrchestrator.js'), 'utf8');
    assert.doesNotMatch(idx, /MOBILE_MONEY_ORANGE/, 'plus de dépendance à une variable globale pour savoir si un paiement est configuré');
  } finally { if (orig !== undefined) process.env.MOBILE_MONEY_ORANGE = orig; }
});

test("GENERATE_PAYMENT_LINK (action réellement exécutée par l'Orchestrateur) : lit le Service métier via getPaymentMethods, jamais une variable d'environnement globale partagée entre comptes", async () => {
  const actionExecutorMod = require('../lib/intelligence/action-executor');
  const T = 'payE'; await businessServices.create(T, { name: 'Épicerie', commercial: { paymentTerms: 'Orange Money 05000000' } });
  const T2 = 'payF'; await businessServices.create(T2, { name: 'Autre boutique' }); // aucun moyen configuré
  const getPaymentMethods = async (t) => (await businessServices.list(t)).filter((s) => s.commercial && s.commercial.paymentTerms).map((s) => ({ label: s.name, value: s.commercial.paymentTerms }));
  const exec = actionExecutorMod.createActionExecutor({ env: {}, getPaymentMethods });
  const ok = await exec.execute('GENERATE_PAYMENT_LINK', { amount: 5000, tenantId: T });
  assert.equal(ok.ok, true); assert.match(ok.result.message, /Orange Money 05000000/);
  const none = await exec.execute('GENERATE_PAYMENT_LINK', { amount: 5000, tenantId: T2 });
  assert.equal(none.ok, false); assert.equal(none.error, 'NO_PAYMENT_METHOD_CONFIGURED');
  // Compte B ne voit jamais le moyen de paiement du compte A (isolation stricte, corrige un vrai bug : l'ancienne version lisait un env global partagé).
  const cross = await exec.execute('GENERATE_PAYMENT_LINK', { amount: 5000, tenantId: T2 });
  assert.doesNotMatch(JSON.stringify(cross), /05000000/);
});

test('sans getPaymentMethods injecté (compatibilité), et sans variable d\'environnement : aucun moyen inventé', async () => {
  const actionExecutorMod = require('../lib/intelligence/action-executor');
  const exec = actionExecutorMod.createActionExecutor({ env: {} });
  const r = await exec.execute('GENERATE_PAYMENT_LINK', { amount: 5000, tenantId: 'payG' });
  assert.equal(r.ok, false); assert.equal(r.error, 'NO_PAYMENT_METHOD_CONFIGURED');
});

test('Service SANS moyen configuré : la réponse client ne cite ni numéro ni lien inventé (chemin autoResponder, déjà en place)', async () => {
  const businessServicesCtx = await require('../ai-engine/businessServices').getEngineContextText('payD_' + Date.now());
  assert.equal(businessServicesCtx, '', 'aucun service = aucun contexte, jamais un moyen de paiement fabriqué');
});
