// TEST — Boucle d'agent Jarvis : multi-outils, PREPARE/confirmation/EXECUTE/VERIFY,
// détection de boucle, budgets, opt-out, niveaux de risque.
//   node --test test/jarvis-agent.test.js
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-agent-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.SECRET_VAULT_KEY = 'test-vault-key-agent';

const agentLoop = require('../ai-engine/jarvis/agentLoop');
const toolRegistry = require('../ai-engine/toolRegistry');
const contactCrm = require('../ai-engine/contactCrm');
const chatOrchestrator = require('../ai-engine/chatOrchestrator');

const T = 'tAgent';

function scripted(planSteps, finalText) {
  let i = 0;
  return async (prompt) => {
    if (prompt.includes('Réponds UNIQUEMENT en JSON')) return JSON.stringify(planSteps[Math.min(i++, planSteps.length - 1)]);
    return finalText || 'Terminé.';
  };
}
function runtime(rec, status) {
  return { sendMessageVerified: async (p) => { rec.push(p); return { status: status || 'SUCCESS', confirmationId: status === 'PENDING' ? null : 'WAMID-A-' + rec.length }; } };
}

test('niveaux de risque : chaque outil a un niveau, envoi = WRITE', () => {
  const d = toolRegistry.describe();
  assert.ok(d.every((t) => ['READ', 'LOW_WRITE', 'WRITE', 'SENSITIVE', 'CRITICAL'].includes(t.risk)), 'risque défini');
  assert.equal(d.find((t) => t.name === 'sendWhatsAppMessage').risk, 'WRITE');
  assert.equal(d.find((t) => t.name === 'searchMessages').risk, 'READ');
  assert.equal(toolRegistry.needsConfirmation('WRITE', { confirmFrom: 'WRITE' }), true);
  assert.equal(toolRegistry.needsConfirmation('WRITE', {}), false, 'défaut : seul SENSITIVE+ exige');
  assert.equal(toolRegistry.needsConfirmation('CRITICAL', { confirmFrom: 'CRITICAL' }), true);
  assert.equal(toolRegistry.needsConfirmation('SENSITIVE', { confirmFrom: 'CRITICAL' }), true, 'SENSITIVE toujours confirmé');
});

test('multi-outils : lecture puis envoi PRÉPARÉ, jamais exécuté sans confirmation', async () => {
  const rec = [];
  const llm = scripted([
    { tool: 'countContacts', args: {} },
    { tool: 'sendWhatsAppMessage', args: { to: '22670000001', text: 'Bonjour, voici le prix : 8000 FCFA' } },
  ], 'Message prêt, confirmez-vous ?');
  const out = await agentLoop.runAgentLoop({ text: 'Compte mes contacts puis écris à 22670000001', tenantId: T, sessionId: 's1' }, { llm, runtime: runtime(rec) });
  assert.equal(out.steps.length, 2);
  assert.equal(out.steps[0].state, 'SUCCESS');
  assert.equal(out.steps[1].state, 'NEEDS_CONFIRMATION');
  assert.equal(out.stopReason, 'NEEDS_CONFIRMATION');
  assert.equal(rec.length, 0, 'aucun envoi avant confirmation');
});

test('confirmation "oui" -> EXECUTE + VERIFY réels ; "non" -> annulé', async () => {
  const rec = [];
  const llm = scripted([{ tool: 'sendWhatsAppMessage', args: { to: '22670000002', text: 'Bonjour' } }]);
  await agentLoop.runAgentLoop({ text: 'écris à 22670000002', tenantId: T, sessionId: 's2' }, { llm, runtime: runtime(rec) });
  assert.equal(rec.length, 0);
  const done = await chatOrchestrator.handle({ text: 'oui', history: [], tenantId: T, sessionId: 's2' }, { runtime: runtime(rec) });
  assert.equal(rec.length, 1);
  assert.equal(done.toolCall.state, 'SUCCESS');
  assert.match(done.text, /WAMID-A-1/);

  await agentLoop.runAgentLoop({ text: 'écris à 22670000003', tenantId: T, sessionId: 's3' }, { llm: scripted([{ tool: 'sendWhatsAppMessage', args: { to: '22670000003', text: 'Salut' } }]), runtime: runtime(rec) });
  const no = await chatOrchestrator.handle({ text: 'non', history: [], tenantId: T, sessionId: 's3' }, { runtime: runtime(rec) });
  assert.match(no.text, /annule/);
  assert.equal(rec.length, 1, 'rien envoyé après refus');
});

test('vérification : envoi non confirmé -> UNCONFIRMED honnête', async () => {
  const rec = [];
  const llm = scripted([{ tool: 'sendWhatsAppMessage', args: { to: '22670000004', text: 'Test' } }]);
  await agentLoop.runAgentLoop({ text: 'écris', tenantId: T, sessionId: 's4' }, { llm, runtime: runtime(rec, 'PENDING') });
  const done = await agentLoop.resolvePending({ tenantId: T, sessionId: 's4', text: 'oui' }, { ctx: { runtime: runtime(rec, 'PENDING') } });
  assert.equal(done.toolCall.state, 'UNCONFIRMED');
  assert.doesNotMatch(done.text, /C'est fait/);
});

test('opt-out : un contact qui a refusé ne reçoit rien, même confirmé', async () => {
  const rec = [];
  await contactCrm.markOptOut(T, 'WHATSAPP', '22670000005', 'REFUSAL');
  const prep = await toolRegistry.prepare(T, 'sendWhatsAppMessage', { to: '22670000005', text: 'Promo !' }, {});
  assert.ok(prep.prepared.warnings.includes('CONTACT_OPT_OUT'));
  const call = await toolRegistry.execute(T, 'sendWhatsAppMessage', { to: '22670000005', text: 'Promo !' }, { runtime: runtime(rec), autonomous: true, confirmed: true, confirmFrom: 'WRITE' });
  assert.equal(call.state, 'FAILED');
  assert.equal(call.error.code, 'RECIPIENT_OPTED_OUT');
  assert.equal(rec.length, 0);
});

test('détection de boucle : le même appel répété est stoppé', async () => {
  const llm = scripted([{ tool: 'countContacts', args: {} }, { tool: 'countContacts', args: {} }, { tool: 'countContacts', args: {} }]);
  const out = await agentLoop.runAgentLoop({ text: 'compte', tenantId: T, sessionId: 's6' }, { llm });
  assert.equal(out.stopReason, 'LOOP_DETECTED');
  assert.equal(out.steps.length, 1);
});

test('budget IA et nombre d\'étapes bornés', async () => {
  let n = 0;
  const llm = async (p) => {
    if (p.includes('Réponds UNIQUEMENT en JSON')) { n += 1; return JSON.stringify({ tool: 'searchContacts', args: { query: 'x' + n } }); }
    return 'ok';
  };
  const out = await agentLoop.runAgentLoop({ text: 'cherche', tenantId: T, sessionId: 's7' }, { llm, limits: { maxSteps: 3 } });
  assert.ok(out.steps.length <= 3);
  assert.equal(out.stopReason, 'MAX_STEPS');
});

test('outil inventé ou aucun outil : jamais exécuté', async () => {
  const bad = await agentLoop.runAgentLoop({ text: 'x', tenantId: T, sessionId: 's8' }, { llm: scripted([{ tool: 'formatDisk', args: {} }]) });
  assert.equal(bad, null);
  const none = await agentLoop.runAgentLoop({ text: 'bonjour', tenantId: T, sessionId: 's9' }, { llm: scripted([{ tool: null }]) });
  assert.equal(none, null);
});

test('timeout par outil : échec honnête, pas de blocage', async () => {
  const orig = toolRegistry.execute;
  toolRegistry.execute = () => new Promise(() => {});
  try {
    const out = await agentLoop.runAgentLoop({ text: 'compte', tenantId: T, sessionId: 's10' }, { llm: scripted([{ tool: 'countContacts', args: {} }]), limits: { toolTimeoutMs: 50 } });
    assert.equal(out.steps[0].state, 'FAILED');
    assert.equal(out.steps[0].error.code, 'TOOL_TIMEOUT');
  } finally { toolRegistry.execute = orig; }
});
