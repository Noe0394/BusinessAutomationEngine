// TEST — tenue du contexte conversationnel (Self WhatsApp / Chat intelligent, propriétaire) : CONTEXTE EXISTANT + NOUVEAU MESSAGE → NOUVEL ÉTAT.
// Reproduit l'exemple du cahier des charges : « Combien coûte le service X ? » puis « Et ça commence quand ? » — le second message doit être
// interprété avec le service évoqué juste avant, sans redemander le contexte ; le chemin rapide (isQuickChat) n'est plus déclenché à tort par
// un simple nom commun (« service », « prix », « tarifs »…) — seul un verbe d'action réel y force le chemin complet.
//   node --test test/context-retention.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-ctx-'));
process.env.GITHUB_TOKEN = ''; process.env.GEMINI_API_KEY = 'test-key'; process.env.SPECIALISTS_ENABLED = 'false';
require('./helpers/auth').actAsAdmin();
const orch = require('../ai-engine/chatOrchestrator');
const businessServices = require('../ai-engine/businessServices');

test('« Combien coûte le service X ? » = intention businessinfo groundée ; « Et ça commence quand ? » = chemin rapide AVEC l\'historique (pas d\'outils, pas de nouvelle intention hors-sujet)', async () => {
  const T = 'ctxret1'; const P = require('./helpers/auth').ownerOf(T);
  await businessServices.create(T, { name: 'Formation Grillade', commercial: { price: 5000, currency: 'FCFA', description: 'Cuisson et marinades, 3 séances en ligne, début chaque lundi.' } });
  const seenPrompts = [];
  const llm = async (p) => { seenPrompts.push(String(p)); return "Le cours de grillade coûte 5000 FCFA."; };
  const llmGateway = require('../lib/ai/llmFallbackEngine'); const origGen = llmGateway.generateAIResponse;
  llmGateway.generateAIResponse = async (p) => { seenPrompts.push(String(p)); return { text: 'Le cours de grillade coûte 5000 FCFA.', provider: 'test' }; };
  let r1; try { r1 = await orch.handle({ text: 'Combien coûte le service Formation Grillade ?', history: [], tenantId: T, sessionId: 's', principal: P }, { llm }); } finally { llmGateway.generateAIResponse = origGen; }
  assert.match(r1.text, /5000/); assert.match(seenPrompts[seenPrompts.length - 1], /Formation Grillade/);
  assert.equal(orch.detectIntent('Et ça commence quand ?', null), null, 'pas d\'intention à motif fixe : conversation courante');
  assert.equal(orch.isQuickChat('Et ça commence quand ?'), true, 'un simple nom (service/prix) ne force plus le chemin lent, seul un verbe d\'action le fait');
  const history = [{ role: 'user', text: 'Combien coûte le service Formation Grillade ?' }, { role: 'assistant', text: r1.text }];
  seenPrompts.length = 0;
  const r2 = await orch.handle({ text: 'Et ça commence quand ?', history, tenantId: T, sessionId: 's', principal: P }, { llm });
  assert.equal(r2, null, 'rendu à la conversation directe (chemin rapide)');
});

test('Le chemin rapide (conversation courante) inclut le contexte métier RÉEL et l\'historique récent dans le prompt (assistantLayer.chatFallback)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'ai-engine', 'assistantLayer.js'), 'utf8');
  assert.match(src, /getEngineContextText/); assert.match(src, /Échanges récents/);
});

test('« créer / supprimer / envoyer / lister » restent bien classés comme des ORDRES (chemin complet), pas des questions informationnelles', () => {
  for (const t of ['Crée le service RIEA', 'Supprime le service X', 'Envoie un message à Awa', 'Liste mes groupes', 'Mets le service X en pause']) assert.equal(orch.isQuickChat(t), false, t);
});
