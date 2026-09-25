// TEST — Répondeur permanent : politique « toujours actif », gardien de sessions, outils du chat.
//   node --test test/responder-keeper.test.js
'use strict';

require('./helpers/auth').actAsAdmin(); // identité authentifiée de test (deny-by-default : voir ai-engine/authz.js)
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-keep-'));
process.env.AI_ENGINE_STORAGE_DIR = TMP;
process.env.SECRET_VAULT_KEY = 'test-vault-key-keep';
process.env.AUTO_REPLY_ALWAYS_ON_TENANTS = 'tPerm, tPerm2';

const autoResponder = require('../ai-engine/autoResponder');
const alwaysOn = require('../ai-engine/alwaysOn');
const keeper = require('../ai-engine/responderKeeper');
const toolRegistry = require('../ai-engine/toolRegistry');
const storageAdapter = require('../ai-engine/storageAdapter');
const businessServices = require('../ai-engine/businessServices');

const runtime = (rec) => ({ sendMessageVerified: async (p) => { rec.push(p); return { status: 'SUCCESS', confirmationId: 'W' + rec.length }; } });

test('compte toujours actif : répond sur WhatsApp ET Telegram même si un ancien réglage disait non', async () => {
  storageAdapter.set('auto_settings', 'tPerm', { tenant: 'tPerm', whatsapp: false, telegram: false });
  const s = await autoResponder.getSettings('tPerm');
  assert.equal(s.whatsapp, true); assert.equal(s.telegram, true); assert.equal(s.alwaysOn, true);
  assert.equal(s.groupReplies, true, 'le mode permanent active aussi la voie des groupes');
  const rec = [];
  const out = await autoResponder.handleIncoming({ tenantId: 'tPerm', channel: 'TELEGRAM', from: '555', text: 'Combien coûte la formation ?', messageId: 'k1' }, { runtime: runtime(rec), llm: async () => 'Je vous renseigne.', debounceMs: 0, notify: async () => {} });
  assert.notEqual(out.skipped, 'DISABLED');
  assert.equal(rec.length, 1);
});

test('compte toujours actif : le répondeur de groupe reste contextuel et cite le prix configuré', async () => {
  const tenant = 'tPerm'; const group = '120363000000@g.us'; const rec = [];
  const service = await businessServices.create(tenant, {
    name: 'Formation Cuisine', aliases: ['cours cuisine'],
    products: [{ name: 'Formation Cuisine', price: 12500 }], commercial: { currency: 'FCFA' },
  });
  await businessServices.update(tenant, service.id, { groups: [{ channel: 'WHATSAPP', id: group, name: 'Cuisine', verified: { admin: true } }] });
  const settings = await autoResponder.getSettings(tenant);
  assert.equal(settings.conversationPolicy.group, 'topic');
  assert.equal(settings.conversationPolicy.openGroups, undefined, 'le mode permanent ne transforme pas tous les groupes en groupes commerciaux');
  const out = await autoResponder.handleIncoming({ tenantId: tenant, channel: 'WHATSAPP', from: group,
    senderId: '225070000000@s.whatsapp.net', text: 'Quel est le prix de la Formation Cuisine ?', messageId: 'group-always-on-1' },
  { runtime: runtime(rec), llm: async () => 'Réponse IA non nécessaire.', debounceMs: 0, notify: async () => {} });
  assert.notEqual(out.skipped, 'DISABLED');
  assert.equal(rec.length, 1);
  assert.match(rec[0].text, /12\s?500\s?FCFA/i);
});

test('compte ordinaire : inchangé (désactivé par défaut) ; pause explicite respectée pour un compte permanent', async () => {
  assert.equal((await autoResponder.getSettings('tOrdinaire')).whatsapp, false);
  await autoResponder.setSettings('tPerm2', { paused: true });
  const paused = await autoResponder.getSettings('tPerm2');
  assert.equal(paused.alwaysOn, true);
  assert.equal(paused.whatsapp, false, 'la pause désactive');
  assert.equal((await autoResponder.handleIncoming({ tenantId: 'tPerm2', channel: 'WHATSAPP', from: '1', text: 'salut', messageId: 'p1' }, { runtime: runtime([]) })).skipped, 'DISABLED');
  await autoResponder.setSettings('tPerm2', { paused: false });
  assert.equal((await autoResponder.getSettings('tPerm2')).whatsapp, true);
  assert.equal((await autoResponder.getSettings('tPerm2')).groupReplies, true);
});

test('réglage alwaysOn persisté : le compte devient permanent et survit à un redémarrage (rechargement)', async () => {
  await autoResponder.setSettings('tDyn', { alwaysOn: true });
  assert.equal(alwaysOn.isAlwaysOn('tDyn'), true);
  assert.equal((await autoResponder.getSettings('tDyn')).telegram, true);
  await autoResponder.setSettings('tDyn', { alwaysOn: false, whatsapp: false, telegram: false });
  assert.equal(alwaysOn.isAlwaysOn('tDyn'), false);
  assert.equal((await autoResponder.getSettings('tDyn')).whatsapp, false);
  storageAdapter.set('auto_settings', 'tReload', { alwaysOn: true });
  assert.equal(alwaysOn.isAlwaysOn('tReload'), false);
  await alwaysOn.loadFromStorage(storageAdapter, 'auto_settings');
  assert.equal(alwaysOn.isAlwaysOn('tReload'), true);
});

function fakeManager(sessions) {
  const started = [];
  return {
    started,
    getOrCreate: (t) => { if (!sessions[t]) throw new Error('LIMIT'); return sessions[t]; },
    ensureConnected: (entry) => { if (!entry.initStarted) { entry.initStarted = true; started.push(entry.tag); } },
  };
}

test('gardien : reconnecte une session appairée mais coupée, jamais plus d\'une fois toutes les 5 min, ignore non appairée/connectée', () => {
  keeper._state.clear();
  const mk = (tag, paired, connected) => ({ tag, initStarted: true, session: { isPaired: () => paired, isConnected: () => connected } });
  const wa = fakeManager({ tPerm: mk('wa-tPerm', true, false), tPerm2: mk('wa-tPerm2', true, true), tDyn: mk('x', false, false) });
  const tg = fakeManager({ tPerm: mk('tg-tPerm', false, false), tPerm2: mk('tg-tPerm2', true, false) });
  const events = [];
  keeper.tick({ whatsapp: wa, telegram: tg }, { onChange: (e) => events.push(`${e.tenant}:${e.channel}:${e.to}`) });
  assert.deepEqual(wa.started.sort(), ['wa-tPerm']);
  assert.deepEqual(tg.started.sort(), ['tg-tPerm2']);
  assert.ok(events.includes('tPerm:WHATSAPP:RECONNECTING'));
  assert.ok(events.includes('tPerm2:WHATSAPP:CONNECTED'));
  assert.ok(events.includes('tPerm:TELEGRAM:NOT_PAIRED'), 'session non appairée : signalée, jamais relancée');

  // tick suivant immédiat : pas de nouvelle relance (intervalle minimal)
  const entryTPerm = wa.getOrCreate('tPerm'); entryTPerm.initStarted = true;
  keeper.tick({ whatsapp: wa, telegram: tg });
  assert.equal(wa.started.length, 1, 'aucune relance avant 5 minutes');
  // 5 minutes plus tard : nouvelle tentative
  keeper._state.get('tPerm:WHATSAPP').lastKickAt = Date.now() - keeper.KICK_MIN_INTERVAL_MS - 1;
  keeper.tick({ whatsapp: wa, telegram: tg });
  assert.equal(wa.started.length, 2);
  assert.equal(keeper.status('tPerm').whatsapp.kicks, 2);
});

test('gardien : limite de sessions atteinte -> état signalé, sans planter', () => {
  keeper._state.clear();
  const wa = fakeManager({});
  keeper.tick({ whatsapp: wa });
  assert.equal(keeper.status('tPerm').whatsapp.state, 'UNAVAILABLE');
});

test('outils du chat : régler et consulter le répondeur', async () => {
  const set = await toolRegistry.execute('tChat', 'setAutoReply', { alwaysOn: true });
  assert.equal(set.state, 'SUCCESS');
  assert.equal(set.result.alwaysOn, true);
  assert.equal((await toolRegistry.execute('tChat', 'setAutoReply', {})).error.code, 'NOTHING_TO_UPDATE');
  const st = await toolRegistry.execute('tChat', 'getAutoReplyStatus', {}, { runtime: { getConnectionStatus: async () => ({ ok: true, result: { whatsapp: { connected: true } } }) } });
  assert.equal(st.result.settings.whatsapp, true);
  assert.equal(st.result.sessions.whatsapp.connected, true);
  alwaysOn.mark('tChat', false);
});
