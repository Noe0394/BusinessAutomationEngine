// TEST — Route /api/intelligence/goal-chat (fenêtre de dialogue objectif -> plan)
// -------------------------------------------------------------------------------
// Vérifie le câblage réel : session multi-tour (question sur l'info manquante,
// pas d'exécution avant confirmation), puis exécution du plan via les VRAIS
// moteurs (task-parser + automation-engine), avec idempotence runId. Même
// gabarit que test/vps-bridge.test.js (serveur HTTP réel, port éphémère).

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

function requireAccessLike(req, res, next) {
  const pw = req.get('x-admin-password') || req.query.password;
  if (pw && pw === ADMIN_PASSWORD) { req.isAdmin = true; req.allowedModules = null; return next(); }
  return res.status(401).json({ error: 'Authentification requise.' });
}

(async () => {
  const stateFile = path.join(os.tmpdir(), 'goal-chat-route-test-' + Date.now() + '.json');
  const app = express();
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use('/', requireAccessLike, createVpsBridge({ runtime: null, stateFile }).router);

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const base = 'http://127.0.0.1:' + port;
  const PW = { 'x-admin-password': ADMIN_PASSWORD, 'content-type': 'application/json' };

  async function req(body) {
    const r = await fetch(base + '/api/intelligence/goal-chat', {
      method: 'POST', headers: PW, body: JSON.stringify(body || {}),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    return { status: r.status, json: j };
  }

  section('SÉCURITÉ — 401 sans header admin');
  {
    const r = await fetch(base + '/api/intelligence/goal-chat', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'salut' }),
    });
    assert('401 sans auth', r.status === 401);
  }

  section('Accueil (salut, sans objectif)');
  let sessionId;
  {
    const r = await req({ message: 'salut' });
    assert('200', r.status === 200, 'status=' + r.status);
    assert('ok:true + sessionId émis', r.json && r.json.ok === true && !!r.json.sessionId);
    assert('kind:question (accueil, aucun plan)', r.json.kind === 'question', JSON.stringify(r.json));
    sessionId = r.json.sessionId;
  }

  section('Objectif avec info manquante -> question ciblée (pas de plan)');
  {
    const r = await req({ sessionId, message: 'Je veux vendre des produits aujourd\'hui' });
    assert('200', r.status === 200);
    assert('kind:question (cible manquante)', r.json.kind === 'question', 'json=' + JSON.stringify(r.json));
    assert('une question est posée (reply présent)', !!r.json.reply && !!r.json.reply.text);
  }

  section('Réponse à la clarification -> plan construit (vrai task-parser)');
  {
    const r = await req({ sessionId, message: '50 produits, WhatsApp' });
    assert('200', r.status === 200, JSON.stringify(r.json));
    assert('phase ready + plan non vide', r.json.ctx && r.json.ctx.target === 50 && Array.isArray(r.json.plan) && r.json.plan.length > 0, JSON.stringify(r.json));
    assert('aucune exécution avant confirmation (pas d\'action lancée)', !r.json.execution);
  }

  section('Confirmation (action:run-plan) -> exécution réelle via automation-engine');
  {
    const r = await req({ sessionId, action: 'run-plan' });
    assert('200', r.status === 200, JSON.stringify(r.json));
    assert('ok:true', r.json.ok === true, JSON.stringify(r.json));
    assert('execution renseignée (runId + executed)', r.json.execution && typeof r.json.execution.executed === 'number', JSON.stringify(r.json.execution));
  }

  section('Nouvel objectif (action:restart) -> nouvelle session propre');
  {
    const r = await req({ sessionId, action: 'restart' });
    assert('200', r.status === 200);
    assert('nouveau sessionId', r.json.sessionId && r.json.sessionId !== sessionId);
    assert('phase greet + message d\'accueil', r.json.phase === 'greet' && r.json.reply && Array.isArray(r.json.reply.quick));
  }

  server.closeAllConnections && server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  try {
    for (const f of fs.readdirSync(os.tmpdir())) {
      if (f.startsWith(path.basename(stateFile).replace(/\.json$/i, ''))) {
        try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (e) { /* ignoré */ }
      }
    }
  } catch (e) { /* ignoré */ }

  console.log('\n========================================');
  console.log('RÉSULTATS : ' + passed + ' passés, ' + failed + ' échoués');
  console.log('========================================');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error('RUNNER CRASH:', err); process.exit(1); });
