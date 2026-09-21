// TEST — self WhatsApp/Telegram + Chat intelligent RAPIDES : une conversation courante ne passe ni par les spécialistes ni par la boucle d'outils (UN appel rapide),
// une tâche longue déclenche un seul accusé « je m'en occupe », l'avis des spécialistes est borné, la passerelle double aussi le niveau raisonnement.
//   node --test test/owner-speed.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os'); const path = require('path'); const fs = require('fs');
process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-speed-'));
process.env.GITHUB_TOKEN = ''; process.env.GEMINI_API_KEY = 'test-key'; process.env.SPECIALISTS_ENABLED = 'false';
require('./helpers/auth').actAsAdmin();
const orch = require('../ai-engine/chatOrchestrator');
const ownerChannel = require('../ai-engine/ownerChannel');
const { ownerOf } = require('./helpers/auth');

test('CONVERSATION COURANTE : reconnue sans IA (salutation, question simple) ; un ordre, un fichier ou un long texte prennent le chemin complet', () => {
  for (const t of ['Bonjour, comment vas-tu ?', 'Merci !', "Explique-moi ce qu'est le marketing de contenu", 'Quel temps fait-il ?']) assert.equal(orch.isQuickChat(t), true, t);
  for (const t of ['Envoie un message à Awa', 'Crée le service RIEA', 'Liste mes groupes', 'Importe ce fichier', 'x'.repeat(400), 'Voici\nPIÈCES JOINTES reçues\n[id: f_abc]']) assert.equal(orch.isQuickChat(t), false, t.slice(0, 30));
});

test("le chat ne lance NI spécialistes NI boucle d'outils pour une conversation courante (zéro appel IA côté orchestrateur) ; un ordre lance la boucle", async () => {
  const P = ownerOf('speed1'); let llmCalls = 0;
  const deps = { llm: async () => { llmCalls += 1; return '{"tool":null,"answer":"ok"}'; }, specialistLlm: async () => { llmCalls += 1; return '{}'; } };
  const t0 = Date.now();
  const r = await orch.handle({ text: 'Bonjour, comment vas-tu ?', history: [], tenantId: 'speed1', sessionId: 's', principal: P }, deps);
  assert.equal(r, null, 'rendu à la conversation directe'); assert.equal(llmCalls, 0); assert.ok(Date.now() - t0 < 200);
  await orch.handle({ text: 'Envoie un dossier à la mairie', history: [], tenantId: 'speed1', sessionId: 's', principal: P }, deps).catch(() => null);
  assert.ok(llmCalls >= 1, "un ordre passe par l'agent à outils");
});

function fakeOwner(chat, chatFallback, sent) {
  const adapter = ownerChannel.ADAPTERS.WHATSAPP; const orig = { reply: adapter.reply, isOwnerContext: adapter.isOwnerContext };
  adapter.reply = async (t, s, m, text) => { sent.push(text); }; adapter.isOwnerContext = () => true;
  const restore = () => { adapter.reply = orig.reply; adapter.isOwnerContext = orig.isOwnerContext; };
  let n = 0;
  const run = (text) => ownerChannel.handleOwnerMessage({ tenantId: 'speed2', session: { isConnected: () => true }, msg: { key: { id: 'X' + (++n) + Date.now(), remoteJid: '22670099999@s.whatsapp.net', fromMe: true }, message: { conversation: text } }, channel: 'WHATSAPP' }, { getSettings: async () => ({}), chat, chatFallback, history: { load: async () => [], append: async () => {} } });
  return { run, restore };
}

test("SELF-CHAT : réponse rapide = aucun accusé ; tâche longue = UN accusé « je m'en occupe » puis le résultat", async () => {
  process.env.OWNER_ACK_MS = '80'; const sent = [];
  const fast = fakeOwner(async () => null, async () => 'Salut ! Ça va bien.', sent);
  try {
    const t0 = Date.now(); await fast.run('Salut'); assert.deepEqual(sent, ['Salut ! Ça va bien.']); assert.ok(Date.now() - t0 < 400);
  } finally { fast.restore(); }
  sent.length = 0;
  const slow = fakeOwner(async () => { await new Promise((r) => setTimeout(r, 300)); return { text: '✅ Fait.', toolCall: { state: 'SUCCESS' } }; }, null, sent);
  try {
    await slow.run('Crée le service X'); assert.equal(sent.length, 2, JSON.stringify(sent)); assert.match(sent[0], /Je m'en occupe/); assert.equal(sent[1], '✅ Fait.');
  } finally { slow.restore(); delete process.env.OWNER_ACK_MS; }
});

test('PASSERELLE : le doublon parallèle existe aussi au niveau « raisonnement » (délai plus long) ; avis des spécialistes borné', () => {
  const root = path.join(__dirname, '..');
  const gw = fs.readFileSync(path.join(root, 'lib/ai/llmFallbackEngine.js'), 'utf8');
  assert.match(gw, /AI_HEDGE_REASONING_MS', 7000/); assert.match(gw, /tier === 'standard' \? envMs\('AI_HEDGE_MS', 3500\)/);
  const oc = fs.readFileSync(path.join(root, 'ai-engine/chatOrchestrator.js'), 'utf8');
  assert.match(oc, /withSpecialistBudget\(specialists\.advise\(/);
  const al = fs.readFileSync(path.join(root, 'ai-engine/assistantLayer.js'), 'utf8');
  assert.match(al, /purpose: 'owner_chat'[\s\S]{0,80}tier: 'standard'/);
});
