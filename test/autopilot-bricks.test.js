// TEST — 3 briques autopilote : loopGuard (§29), modelRouter (§6),
// activityStore (§16/§27). 100 % déterministe, aucun appel IA.
//   node --test test/autopilot-bricks.test.js

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-autopilot-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.MAX_AI_CALLS_PER_TASK = '4';

const loopGuard = require('../ai-engine/loopGuard');
const modelRouter = require('../ai-engine/modelRouter');
const activityStore = require('../ai-engine/activityStore');

test('loopGuard : plafonne les appels IA par tâche', () => {
  const task = 'task-A';
  for (let i = 0; i < 4; i += 1) loopGuard.countAiCall(task); // 4 ok (plafond=4)
  assert.throws(() => loopGuard.countAiCall(task), (e) => e.code === 'AI_LOOP_LIMIT');
  // une autre tâche n'est pas affectée
  assert.doesNotThrow(() => loopGuard.countAiCall('task-B'));
});

test('loopGuard : sans taskId -> jamais de plafond (no-op)', () => {
  for (let i = 0; i < 20; i += 1) assert.doesNotThrow(() => loopGuard.countAiCall(null));
});

test('loopGuard : idempotence (seen)', () => {
  assert.equal(loopGuard.seen('msg-1'), false); // première fois
  assert.equal(loopGuard.seen('msg-1'), true); // déjà vue
  assert.equal(loopGuard.seen('msg-2'), false);
});

test('modelRouter : classe simple / normal / complexe', () => {
  assert.equal(modelRouter.classify('bonjour').tier, 'simple');
  assert.equal(modelRouter.classify('merci beaucoup 🙏').tier, 'simple');
  const complex = modelRouter.classify('Pouvez-vous expliquer la différence entre les deux formules et comparer les prix ? Et pour le paiement ?');
  assert.equal(complex.tier, 'complex');
  assert.ok(complex.maxTokens >= modelRouter.classify('bonjour').maxTokens, 'complexe alloue plus de tokens');
  assert.equal(modelRouter.classify('Est-ce que la formation est dispo ?').tier, 'normal');
});

test('modelRouter : simple envoie moins de contexte et de tokens', () => {
  const s = modelRouter.classify('salut');
  const c = modelRouter.classify('Explique-moi en détail ta stratégie commerciale, compare plusieurs options et donne les étapes.');
  assert.ok(s.maxContextMessages <= c.maxContextMessages);
  assert.ok(s.maxTokens < c.maxTokens);
});

test('activityStore : enregistre et agrège (déterministe)', async () => {
  await activityStore.record({ type: 'message_in', action: 'reçu', status: 'ok', channel: 'WHATSAPP', tenant: 'KEY-A', target: '2260000' });
  await activityStore.record({ type: 'auto_reply', action: 'réponse', status: 'ok', channel: 'WHATSAPP', tenant: 'KEY-A' });
  await activityStore.record({ type: 'tool_call', action: 'getProductPrice', status: 'error', tenant: 'KEY-A' });
  const s = await activityStore.summary();
  assert.ok(s.events.length >= 3);
  assert.equal(s.counts.byStatus.ok, 2);
  assert.equal(s.counts.byStatus.error, 1);
  assert.equal(s.counts.byType.tool_call, 1);
  // le plus récent en premier
  assert.equal(s.events[0].type, 'tool_call');
});

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (e) {} });
