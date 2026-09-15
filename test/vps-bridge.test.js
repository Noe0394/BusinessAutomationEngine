// TEST 1 — Validation du branchement VPS (bridge Express /api/intelligence/*)
// -------------------------------------------------------------------------------
// Reproduit EXACTEMENT le câblage réel de index.js :
//   app.use(express.json({ verify: rawBody }))   (index.js l.231)
//   app.use('/', requireAccess, createVpsBridge(...))  (index.js l.4721)
// Ce test lance un vRÉEL serveur HTTP (port éphémère), envoie de véritables
// requêtes POST/GET et vérifie les réponses — zéro simulation.
//
// Seules différences assumées vs production :
//   - ADMIN_PASSWORD est injecté (pas lu du .env) pour rester reproductible ;
//   - runtime d'exécution = défaut (zéro-effet-de-bord : aucun moteur d'envoi
//     WhatsApp/Telegram n'est sollicité — garantie du bridge, inchangée).
//
// Couvre le contrôle d'accès (401 sans header), analyze (Test 2), intuition
// (Test 6), objective+chat (Test 3), execute + idempotence runId (Test 5/7),
// actions (Test 8) et health.

'use strict';

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const express = require('express');
const { createVpsBridge } = require('../lib/intelligence/vps-bridge');

const ADMIN_PASSWORD = 'test-admin-pw-2026';
let passed = 0;
let failed = 0;
function assert(name, cond, detail) {
  if (cond) { passed += 1; console.log('  ✓ ' + name); }
  else { failed += 1; console.error('  ✗ ' + name + (detail ? ' — ' + detail : '')); }
}
function section(title) { console.log('\n■ ' + title); }

// --- Câblage identique à index.js (l.231 + l.4721) ---------------------------
function requireAccessLike(req, res, next) {
  // Mirroir minimal du middleware réel (index.js l.250) : mêmes en-têtes et
  // mêmes statuts. En production c'est la vraie fonction, ici on la remplace
  // par ADMIN_PASSWORD injecté pour rester hors du .env.
  const pw = req.get('x-admin-password') || req.query.password;
  if (pw && pw === ADMIN_PASSWORD) { req.isAdmin = true; req.allowedModules = null; return next(); }
  return res.status(401).json({ error: 'Authentification requise (mot de passe administrateur ou clé de licence valide).' });
}

(async () => {
  const stateFile = path.join(os.tmpdir(), 'intel-bridge-test-' + Date.now() + '.json');
  const app = express();
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use('/', requireAccessLike, createVpsBridge({ runtime: null, stateFile }).router);

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  const PW = { 'x-admin-password': ADMIN_PASSWORD, 'content-type': 'application/json' };
  console.log('Serveur de test sur ' + base + ' — état ' + stateFile);

  async function req(method, p, body, headers) {
    const r = await fetch(base + p, {
      method,
      headers: headers || PW,
      body: body ? JSON.stringify(body) : undefined,
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    return { status: r.status, json: j };
  }

  section('SÉCURITÉ — contrôle d’accès');
  {
    const r = await req('POST', '/api/intelligence/analyze', { message: 'test' }, { 'content-type': 'application/json' });
    assert('401 sans x-admin-password sur /analyze', r.status === 401, 'status=' + r.status);
    assert('andmessage objet erreur explicite', r.json && r.json.error, String(r.json));
  }

  section('TEST 2 — Analyse émotionnelle (Chat-to-Action + Human Context)');
  {
    const r = await req('POST', '/api/intelligence/analyze', { message: 'Je vais réfléchir' });
    assert('200', r.status === 200, 'status=' + r.status);
    assert('sentiment renvoyé', r.json && r.json.analysis && typeof r.json.analysis.sentiment === 'string');
    assert('intérêt High', r.json && r.json.analysis.interest === 'High', String(r.json && r.json.analysis && r.json.analysis.interest));
    assert('hésitation ≥ 0.6 (HESITATION=HIGH)', r.json && r.json.analysis.hesitation >= 0.6, String(r.json && r.json.analysis && r.json.analysis.hesitation));
    assert('confiance ≈ MEDIUM (0.3–0.7)', r.json && r.json.analysis.trust >= 0.3 && r.json.analysis.trust <= 0.7, String(r.json && r.json.analysis && r.json.analysis.trust));
    assert('objection PRICE détectée', r.json && r.json.analysis.likely_objections && r.json.analysis.likely_objections.includes('PRICE'), JSON.stringify(r.json && r.json.analysis && r.json.analysis.likely_objections));
    assert('stratégie choisie', r.json && r.json.strategy && r.json.strategy.id, String(r.json && r.json.strategy));
    assert('relance générée', typeof (r.json && r.json.followUp) === 'string' && r.json.followUp.length > 0);
  }

  section('TEST 6 — Intuition probabiliste');
  {
    const r = await req('POST', '/api/intelligence/intuition', {
      message: 'Je vais réfléchir',
      signals: { responseDelayMs: 13 * 3600 * 1000 },
      history: [
        { at: Date.now() - 3 * 3600 * 1000, sentiment: 'neutral', objection_primary: 'PRICE' },
        { at: Date.now() - 7 * 3600 * 1000, sentiment: 'neutral', objection_primary: 'PRICE' },
        { at: Date.now() - 13 * 3600 * 1000, sentiment: 'neutral', objection_primary: 'PRICE' },
      ],
    });
    assert('200', r.status === 200, 'status=' + r.status);
    assert('intuition CAUTION', r.json && r.json.intuition && r.json.intuition.intuition === 'CAUTION', String(r.json && r.json.intuition));
    assert('confiance élevée (≥0.9)', r.json && r.json.intuition && r.json.intuition.confidence >= 0.9, String(r.json && r.json.intuition && r.json.intuition.confidence));
    assert('raison textuelle', r.json && r.json.intuition && typeof r.json.intuition.reason === 'string' && r.json.intuition.reason.length > 3);
  }

  section('TEST 3 — Objectif langage naturel → plan de tâches');
  {
    const msg = 'Aujourd\'hui, je veux vendre 10 packs de formation et générer 100 000 FCFA';
    const runId = 'obj-' + Date.now();
    const r = await req('POST', '/api/intelligence/objective', { message: msg, engine: 'VPS_BAILEYS', tenantId: 'test-tenant-1', runId });
    assert('200', r.status === 200, 'status=' + r.status);
    assert('goal SALES extrait', r.json && r.json.doc && r.json.doc.goals && r.json.doc.goals.some((g) => g.type === 'SALES'));
    assert('cible 10 packs extraite', r.json && r.json.doc && r.json.doc.goals[0] && r.json.doc.goals[0].target === 10, JSON.stringify(r.json && r.json.doc && r.json.doc.goals));
    assert('revenu 100000 FCFA extrait', r.json && r.json.doc && r.json.doc.goals[0] && r.json.doc.goals[0].revenue === 100000, JSON.stringify(r.json && r.json.doc && r.json.doc.goals && r.json.doc.goals[0]));
    assert('plan multi-étapes (≥5)', r.json && Array.isArray(r.json.doc.plan) && r.json.doc.plan.length >= 5, 'len=' + (r.json && r.json.doc && r.json.doc.plan && r.json.doc.plan.length));
    const types = (r.json.tasks || []).map((t) => t.type);
    assert('tâches structurées (id, engine, channel, payload, attempts)', r.json.tasks && r.json.tasks.every((t) => t.id && t.engine && t.channel && t.type && t.payload && t.attempts === 0));
    assert('tenant isolé (test-tenant-1)', r.json.tasks && r.json.tasks.every((t) => t.tenantId === 'test-tenant-1'));
    assert('chaîne idempotence : runId propagé dans chaque tâche', r.json.tasks && r.json.tasks.every((t) => t.runId === runId && t.id.indexOf('t_' + runId + '_') === 0));
    assert('console plan : EXTRACT_MEMBERS + SEND_CAMPAIGN + FOLLOW_UP présents',
      ['EXTRACT_MEMBERS', 'SEND_CAMPAIGN', 'FOLLOW_UP'].every((a) => types.includes(a)),
      types.join(','));
  }

  section('TEST 3b — Chat-to-Action complet (+ exécution locale zéro-effet)');
  {
    const r = await req('POST', '/api/intelligence/chat', {
      message: 'Aujourd\'hui, je veux vendre 10 packs de formation et générer 100 000 FCFA',
      engine: 'VPS_BAILEYS',
      tenantId: 'test-tenant-1',
    });
    assert('200', r.status === 200, 'status=' + r.status);
    assert('résumé renvoyé', r.json && typeof r.json.summary === 'string' && r.json.summary.length > 0);
    assert('un runId exposé', r.json && typeof r.json.runId === 'string' && r.json.runId.startsWith('chat-'));
    assert('plan réduit multi-étapes', r.json && Array.isArray(r.json.plan) && r.json.plan.length >= 5);
    assert('la tâche immédiate EXTRACT_MEMBERS a été exécutée (runtime défaut = droite)',
      r.json && r.json.executed && r.json.executed.executed >= 1,
      JSON.stringify(r.json && r.json.executed));
  }

  section('TEST 7 — Idempotence stricte par runId sur exécution');
  {
    const runId = 'idem-test-' + Date.now();
    const body = { action: 'EXTRACT_MEMBERS', payload: { source: 'test' }, engine: 'VPS_BAILEYS', tenantId: 'idem-tenant', runId };
    const r1 = await req('POST', '/api/intelligence/execute', body);
    const r2 = await req('POST', '/api/intelligence/execute', body);
    assert('1er run : 1 exécutée', r1.json && r1.json.out && r1.json.out.executed === 1, JSON.stringify(r1.json && r1.json.out));
    assert('2e run (même runId) : 0 exécutée', r2.json && r2.json.out && r2.json.out.executed === 0, JSON.stringify(r2.json && r2.json.out));
    assert('2e run : tâche marquée idempotente', r2.json && r2.json.out && r2.json.out.results && r2.json.out.results[0].state === 'idempotent', JSON.stringify(r2.json && r2.json.out && r2.json.out.results));
  }

  section('TEST 5/8 — Registre d’actions');
  {
    const r = await req('GET', '/api/intelligence/actions');
    const expected = ['EXTRACT_MEMBERS', 'SEND_CAMPAIGN', 'FOLLOW_UP', 'ANALYZE_HUMAN_CONTEXT', 'ANALYZE_RESPONSES', 'REPLY_COMMENT', 'GENERATE_VIDEO', 'PAUSE_CAMPAIGN', 'RESUME_CAMPAIGN', 'GENERATE_REPORT', 'CREATE_USER_ACCOUNT', 'GENERATE_ACCESS_KEY'];
    assert('200', r.status === 200, 'status=' + r.status);
    const names = (r.json.actions || []).map((a) => (typeof a === 'string' ? a : a.name));
    assert('les 12 actions présentes', expected.every((a) => names.includes(a)), names.join(','));
  }

  section('Health');
  {
    const r = await req('GET', '/api/intelligence/health');
    assert('ok:true + modules chargés', r.json && r.json.ok === true && r.json.modules && r.json.modules.humanContextEngine === true);
  }

  // --- Reprise d'état après redémarrage (Test "state resume") -----------------
  section('Reprise d’état (hydrate) — tenant isolé');
  {
    const automation = require('../lib/intelligence/automation-engine');
    const eng = automation.createAutomationEngine({ tenantId: 'test-tenant-1', executor: null, storage: automation.createFileStorage(stateFile.replace(/\.json$/i, '') + '.test-tenant-1.json') });
    const h = await eng.hydrateFromStorage();
    const tasks = await eng.listTasks({ tenantId: 'test-tenant-1' });
    assert('hydrateFromStorage a rechargé le plan du tenant (8 tâches : 2 canaux)', Array.isArray(tasks) && tasks.length === 8, 'tasks=' + (tasks && tasks.length));
    assert('le canal secondaire Telegram est planifié (bonus pot)', tasks.some((t) => t.channel === 'TELEGRAM' && t.type === 'SEND_CAMPAIGN') && tasks.some((t) => t.channel === 'TELEGRAM' && t.type === 'REPLY_COMMENT'), JSON.stringify(tasks.map((t) => [t.type, t.channel])));
    assert('runId déjà exécutés marqués en mémoire (idempotence après restart)', typeof h.alreadyRun === 'number' && h.alreadyRun >= 1, JSON.stringify(h));
    assert('EXTRACT_MEMBERS immédiat conservé "done" après redémarrage', tasks.some((t) => t.type === 'EXTRACT_MEMBERS' && t.status === 'done'), JSON.stringify(tasks.map((t) => [t.type, t.status])));
  }

  // Fermeture propre (crash libuv connu sur Windows si process.exit() est
  // appelé pendant que des handles réseau ferment encore) : on clôt les
  // connexions, on attend la fin du serveur, puis on laisse la boucle se
  // terminer naturellement via process.exitCode (le pool keep-alive fetch
  // se vide en ~4 s, sans crash).
  server.closeAllConnections && server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  for (const f of [stateFile, stateFile.replace(/\.json$/i, '') + '.test-tenant-1.json', stateFile.replace(/\.json$/i, '') + '.idem-tenant.json']) {
    try { fs.unlinkSync(f); } catch (e) { /* état temporaire déjà net : ignoré */ }
  }

  console.log('\n========================================');
  console.log('RÉSULTATS : ' + passed + ' passés, ' + failed + ' échoués');
  console.log('========================================');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error('RUNNER CRASH:', err); process.exit(1); });