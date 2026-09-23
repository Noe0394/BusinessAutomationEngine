// TEST RUNNER — règles du prompt global : contact enregistré, refus, notification administrateur, et garde-fou du build dashboard.
//   node --test test/assistant-prompt-rules.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const path = require('path');
const fs = require('fs');

process.env.AI_ENGINE_STORAGE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cyrus-rules-'));
const platformOrchestrator = require('../ai-engine/platformOrchestrator');
platformOrchestrator.notifyTenantChat = async () => {};
const contactIdentity = require('../ai-engine/contactIdentity');
const alertCenter = require('../ai-engine/alertCenter');
const autoResponder = require('../ai-engine/autoResponder');
const businessServices = require('../ai-engine/businessServices');
const conversationState = require('../ai-engine/jarvis/conversationState');
const storage = require('../ai-engine/storageAdapter');

test('isSavedContact : nom du répertoire (enregistré) vs simple nom public WhatsApp', async () => {
  const saved = await contactIdentity.resolveContact('r1', { jid: '22670111111@s.whatsapp.net', contactName: 'Papa Ibrahim', pushName: 'ibra' });
  assert.equal(saved.isSavedContact, true);
  assert.equal(saved.contactName, 'Papa Ibrahim');
  const pub = await contactIdentity.resolveContact('r1', { jid: '22670222222@s.whatsapp.net', pushName: 'Marie' });
  assert.equal(pub.isSavedContact, false);
  assert.equal(pub.contactName, null);
  // le statut « enregistré » persiste quand le nom du répertoire n'est plus fourni au message suivant
  const again = await contactIdentity.resolveContact('r1', { jid: '22670111111@s.whatsapp.net' });
  assert.equal(again.isSavedContact, true);
  assert.equal(again.contactName, 'Papa Ibrahim');
});

test('accueil personnalisé : enregistré -> par son nom ; inconnu -> demander poliment le nom/l\'objet', async () => {
  const prompts = [];
  const llm = async (p) => { prompts.push(p); return 'ok'; };
  const settings = { whatsapp: true, debounceMs: 0 };
  const runtime = { sendMessageVerified: async () => ({ status: 'SUCCESS', confirmationId: 'C1' }) };
  const savedId = await contactIdentity.resolveContact('r2', { jid: '22670333333@s.whatsapp.net', contactName: 'Tante Awa' });
  await autoResponder.handleIncoming({ tenantId: 'r2', channel: 'WHATSAPP', from: '22670333333@s.whatsapp.net', name: null, text: 'Bonjour, je voudrais des informations', messageId: 'S1' }, { runtime, llm, settings, identity: savedId });
  const unknownId = await contactIdentity.resolveContact('r2', { jid: '999111222333444@lid' });
  await autoResponder.handleIncoming({ tenantId: 'r2', channel: 'WHATSAPP', from: '999111222333444@lid', name: null, text: 'Bonjour, je voudrais des informations', messageId: 'U1' }, { runtime, llm, settings, identity: unknownId });
  const joined = prompts.join('\n=====\n');
  assert.match(joined, /enregistré dans le répertoire du propriétaire sous le nom « Tante Awa »/);
  assert.match(joined, /demande-lui poliment, une seule fois, son nom/);
  assert.ok(!/999111222333444/.test(joined), 'aucun identifiant technique dans le prompt');
});

test('refus : user_refused_action=true et plus aucune insistance', async () => {
  const runtime = { sent: [], sendMessageVerified: async function (p) { this.sent.push(p.text); return { status: 'SUCCESS', confirmationId: 'C' + this.sent.length }; } };
  const settings = { whatsapp: true, debounceMs: 0 };
  const llm = async () => 'Très bien, merci pour votre retour.';
  const from = '22670444444@s.whatsapp.net';
  await autoResponder.handleIncoming({ tenantId: 'r3', channel: 'WHATSAPP', from, name: 'Kofi', text: 'Non merci, pas intéressé', messageId: 'R1' }, { runtime, llm, settings });
  const st = await conversationState.get('r3', 'WHATSAPP', from);
  assert.equal(st.user_refused_action, true);
  assert.equal(st.refusal.active, true);
  const before = runtime.sent.length;
  const out = await autoResponder.handleIncoming({ tenantId: 'r3', channel: 'WHATSAPP', from, name: 'Kofi', text: 'J\'ai dit non', messageId: 'R2' }, { runtime, llm, settings });
  assert.equal(out.skipped, 'NO_ACTION');
  assert.equal(runtime.sent.length, before, 'aucun message supplémentaire après un refus');
});

test('triggerAdminNotification : alerte persistante, idempotente, sans identifiant technique', async () => {
  const notes = [];
  alertCenter.setDeliverers([async (t, text) => { notes.push(text); return { ok: true, channel: 't' }; }]);
  const contact = contactIdentity.resolveIdentity({ jid: '888777666555444@lid' });
  const a = await alertCenter.triggerAdminNotification('r4', { reason: 'Demande de remboursement hors périmètre', contact, text: 'Je veux être remboursé', key: 'k1' });
  const b = await alertCenter.triggerAdminNotification('r4', { reason: 'Demande de remboursement hors périmètre', contact, text: 'Je veux être remboursé', key: 'k1' });
  assert.equal(a.delivered, true);
  assert.equal(b.duplicate, true);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Contact WhatsApp non identifié : demande hors de mon périmètre/);
  assert.match(notes[0], /Prise en charge par l'administrateur/);
  assert.ok(!/888777666555444|@lid/.test(notes[0]));
});

test('l\'escalade du moteur passe par triggerAdminNotification (propriétaire prévenu)', async () => {
  const notes = [];
  alertCenter.setDeliverers([async (t, text) => { notes.push(text); return { ok: true, channel: 't' }; }]);
  const runtime = { sendMessageVerified: async () => ({ status: 'SUCCESS', confirmationId: 'C' }) };
  await autoResponder.handleIncoming({ tenantId: 'r5', channel: 'WHATSAPP', from: '22670555555@s.whatsapp.net', name: 'Awa', text: 'Je veux annuler et être remboursée', messageId: 'E1' }, { runtime, llm: async () => 'Je transmets ta demande au vendeur.', settings: { whatsapp: true, debounceMs: 0 } });
  assert.equal(notes.length, 1);
  assert.match(notes[0], /hors de mon périmètre/);
});

test('GARDE-FOU BUILD : un seul bloc <script> inline (le build obscurcit chaque bloc séparément avec renameGlobals)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
  const blocks = (html.match(/<script(?![^>]*\bsrc=)[^>]*>[\s\S]*?<\/script>/gi) || []).filter((b) => b.replace(/<[^>]+>/g, '').trim());
  assert.equal(blocks.length, 1, `${blocks.length} blocs inline : les globales partagées (cmpJson, state…) seraient renommées différemment par bloc en production`);
});

test('GARDE-FOU BUILD : le dashboard obscurci exécute « Analyser la liste » et met à jour le compteur « Liste importée »', async () => {
  const { execFileSync } = require('child_process');
  const build = path.join(__dirname, '..', 'scripts', 'build-dashboard.js');
  execFileSync(process.execPath, [build], { stdio: 'ignore' });
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dist', 'dashboard.html'), 'utf8');
  const vm = require('vm');
  const code = (html.match(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/i) || [])[1];
  const created = []; const byId = {};
  function mk(tag) {
    const store = { tag }; const handlers = {};
    return new Proxy(function () {}, {
      get(t, k) {
        if (k === 'addEventListener') return (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn); };
        if (k === '__h') return handlers; if (k === '__s') return store;
        if (k in store) return store[k];
        if (k === 'children' || k === 'childNodes' || k === 'files') return [];
        if (k === 'value') return ''; if (k === 'length') return 0; if (k === 'then') return undefined;
        if (k === Symbol.toPrimitive) return () => '';
        if (k === 'querySelectorAll') return () => [];
        return mk('x');
      },
      set(t, k, v) { store[k] = v; return true; }, apply() { return mk('x'); },
    });
  }
  const doc = new Proxy({}, { get(t, k) {
    if (k === 'getElementById') return (id) => (byId[id] = byId[id] || mk('div'));
    if (k === 'createElement') return (tag) => { const e = mk(tag); created.push(e); return e; };
    if (k === 'querySelector') return (sel) => { const r = mk('x'); if (/target-mode/.test(sel)) r.__s.value = 'import'; return r; };
    if (k === 'querySelectorAll') return () => [];
    if (k === 'addEventListener') return () => {};
    return mk('x');
  } });
  const analysis = { recipientsId: 'rcp1', counts: { total: 3, valid: 2, duplicate: 1, invalid: 0, uncertain: 0 }, rows: [
    { name: 'A', number: '22670123456', state: 'valid' }, { name: 'B', number: '22670123457', state: 'valid' }, { name: 'C', number: '22670123456', state: 'duplicate' }] };
  const calls = [];
  const ctx = { console, document: doc, fetch: async (u) => { calls.push(String(u)); return { ok: true, status: 200, json: async () => (/recipients/.test(u) ? analysis : {}), text: async () => '', headers: { get: () => '' } }; },
    setTimeout, clearTimeout, setInterval: () => 0, clearInterval() {}, Event: function () {}, FormData: function () { this.append = () => {}; }, URL, Blob: function () {},
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} }, sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    navigator: { userAgent: 'x' }, location: { href: 'http://x/', origin: 'http://x', hash: '', search: '' }, history: { replaceState() {} }, addEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }), requestAnimationFrame: () => 0, alert() {}, confirm: () => true, IntersectionObserver: function () { this.observe = () => {}; },
    MutationObserver: function () { this.observe = () => {}; }, Promise, Set, Map, JSON, Math, Date, Array, Object, String, Number, Boolean, RegExp, Error, encodeURIComponent, decodeURIComponent,
    parseInt, parseFloat, isNaN, Uint8Array, ArrayBuffer, atob: (s) => Buffer.from(s, 'base64').toString('binary'), btoa: (s) => Buffer.from(s, 'binary').toString('base64') };
  ctx.window = ctx; ctx.self = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(code, ctx, { timeout: 8000 });
  const btn = created.find((e) => e.__s.tag === 'button' && e.__s.textContent === 'Analyser la liste');
  const ta = created.find((e) => e.__s.tag === 'textarea');
  assert.ok(btn && ta, 'le module de chargement de numéros est construit');
  ta.__s.value = '22670123456\n22670123457\n22670123456';
  for (const h of btn.__h.click || []) await h();
  await new Promise((r) => setTimeout(r, 200));
  assert.deepEqual(calls, ['/api/campaigns/recipients']);
  assert.match(String(byId['campaign-import-count'] && byId['campaign-import-count'].__s.textContent), /^2 contact\(s\) prêt\(s\)/);
});

test('promesse tenue : si l\'IA dit « je transmets au vendeur », le propriétaire est réellement prévenu', async () => {
  const notes = [];
  alertCenter.setDeliverers([async (t, text) => { notes.push(text); return { ok: true, channel: 't' }; }]);
  const runtime = { sendMessageVerified: async () => ({ status: 'SUCCESS', confirmationId: 'C' }) };
  const phrases = [
    'Je n\'ai pas d\'info précise sur la livraison à Bobo. Je vais transmettre ta question au vendeur, et il te revient dès que possible.',
    'Je vérifie et je reviens vers toi rapidement.',
    'Le vendeur te confirmera la zone de livraison.',
  ];
  for (let i = 0; i < phrases.length; i++) {
    notes.length = 0;
    await autoResponder.handleIncoming({ tenantId: 'pr' + i, channel: 'WHATSAPP', from: '2267012340' + i + '@s.whatsapp.net', name: 'Awa', text: 'Vous livrez à Bobo ?', messageId: 'PR' + i }, { runtime, llm: async () => phrases[i], settings: { whatsapp: true, debounceMs: 0 } });
    assert.equal(notes.length, 1, 'alerte propriétaire pour : ' + phrases[i]);
    assert.match(notes[0], /Question sans réponse dans le Service métier/);
  }
  // une réponse qui n'annonce rien de tel ne déclenche aucune alerte — service RÉELLEMENT configuré (prix
  // 8000 FCFA) pour isoler ce cas du garde-fou séparé "question commerciale sans aucun Service métier configuré"
  // (voir jarvis/conversationEngine.js#businessRequestNoService), qui alerterait sinon légitimement pour un autre motif.
  await businessServices.create('pr9', { name: 'Service pr9', commercial: { price: 8000, currency: 'FCFA' } });
  notes.length = 0;
  await autoResponder.handleIncoming({ tenantId: 'pr9', channel: 'WHATSAPP', from: '22670123499@s.whatsapp.net', name: 'Awa', text: "C'est combien ?", messageId: 'PR9' }, { runtime, llm: async () => 'Le service coûte 8 000 FCFA.', settings: { whatsapp: true, debounceMs: 0 } });
  assert.equal(notes.length, 0);
});
