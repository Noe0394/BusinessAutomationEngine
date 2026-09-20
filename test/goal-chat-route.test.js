// TEST — Route /api/intelligence/goal-chat (fenêtre de dialogue objectif -> plan)
// -------------------------------------------------------------------------------
// Vérifie le câblage réel de la route, serveur HTTP réel sur port éphémère, VRAIS moteurs (task-parser, automation-engine,
// orchestrateur) — mais SANS réseau : l'IA est simulée « indisponible » (les modules retombent alors sur leur texte de repli
// déterministe), ce qui rend le test rapide et stable (avant : dépendait de fournisseurs IA en ligne, d'où timeouts/429).
//
// DEUX comportements réels, testés séparément :
//   A. Chat Intelligent (orchestrateur actif) — comportement du produit : « ordre compris = exécution DIRECTE » ; avec
//      CHAT_CONFIRM_PLANS=true : plan proposé, PAS d'exécution avant confirmation.
//   B. Moteur goal-chat brut (repli quand l'orchestrateur ne prend pas la main) — contrat historique : question sur l'info
//      manquante, plan structuré (ctx/plan), aucune exécution avant `action:'run-plan'`, exécution réelle idempotente, restart.

'use strict';

const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');
const express = require('express');

// IA simulée indisponible AVANT le chargement du pont : aucun appel réseau, repli déterministe.
const llmFallbackEngine = require('../lib/ai/llmFallbackEngine');
llmFallbackEngine.generateAIResponse = async () => { throw new Error('IA indisponible (test hors-ligne)'); };
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

async function startBridge(extraDeps) {
  const stateFile = path.join(os.tmpdir(), 'goal-chat-route-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7) + '.json');
  const app = express();
  app.use(express.json({ verify: (req, res, buf) => { req.rawBody = buf; } }));
  app.use('/', requireAccessLike, createVpsBridge(Object.assign({ runtime: null, stateFile }, extraDeps || {})).router);
  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const PW = { 'x-admin-password': ADMIN_PASSWORD, 'content-type': 'application/json' };
  async function req(body) {
    const r = await fetch(base + '/api/intelligence/goal-chat', { method: 'POST', headers: PW, body: JSON.stringify(body || {}) });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    return { status: r.status, json: j };
  }
  const close = async () => {
    server.closeAllConnections && server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    try {
      for (const f of fs.readdirSync(os.tmpdir())) {
        if (f.startsWith(path.basename(stateFile).replace(/\.json$/i, ''))) { try { fs.unlinkSync(path.join(os.tmpdir(), f)); } catch (e) { /* ignoré */ } }
      }
    } catch (e) { /* ignoré */ }
  };
  return { base, req, close };
}

(async () => {
  // ============================ A. Chat Intelligent (orchestrateur actif) ============================
  const A = await startBridge();
  section('A — SÉCURITÉ : 401 sans header admin');
  {
    const r = await fetch(A.base + '/api/intelligence/goal-chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: 'salut' }) });
    assert('401 sans auth', r.status === 401);
  }

  section('A — Accueil (salut, sans objectif)');
  let sessionA;
  {
    const r = await A.req({ message: 'salut' });
    assert('200', r.status === 200, 'status=' + r.status);
    assert('ok:true + sessionId émis', r.json && r.json.ok === true && !!r.json.sessionId);
    assert('kind:question (accueil, aucun plan)', r.json.kind === 'question', JSON.stringify(r.json));
    sessionA = r.json.sessionId;
  }

  section('A — Objectif avec info manquante -> question ciblée (pas de plan)');
  {
    const r = await A.req({ sessionId: sessionA, message: 'Je veux vendre des produits aujourd\'hui' });
    assert('200', r.status === 200);
    assert('kind:question (cible manquante)', r.json.kind === 'question', JSON.stringify(r.json));
    assert('une question est posée (reply présent)', !!(r.json.reply && r.json.reply.text));
  }

  section('A — Réponse à la clarification -> plan construit ET exécution directe (comportement produit)');
  {
    const r = await A.req({ sessionId: sessionA, message: '50 produits, WhatsApp' });
    assert('200', r.status === 200, JSON.stringify(r.json));
    assert('ok:true', r.json.ok === true);
    assert('kind:plan (plan généré)', r.json.kind === 'plan', JSON.stringify(r.json));
    assert('plan structuré affiché (étapes réelles du task-parser)', /Plan généré \(\d+ étapes?\)/.test(r.json.reply.text) && /Extraire les contacts/.test(r.json.reply.text), r.json.reply.text);
    assert('cible 50 reconnue', /cible 50/.test(r.json.reply.text), r.json.reply.text);
    assert('exécution démarrée en arrière-plan (actionLog)', Array.isArray(r.json.actionLog) && /Exécution démarrée/.test(r.json.actionLog[0].label), JSON.stringify(r.json.actionLog));
  }

  section('A — CHAT_CONFIRM_PLANS=true : plan proposé, AUCUNE exécution avant confirmation');
  {
    const prev = process.env.CHAT_CONFIRM_PLANS;
    process.env.CHAT_CONFIRM_PLANS = 'true';
    try {
      const first = await A.req({ message: 'Je veux vendre des produits aujourd\'hui' });
      const r = await A.req({ sessionId: first.json.sessionId, message: '50 produits, WhatsApp' });
      assert('200', r.status === 200, JSON.stringify(r.json));
      assert('plan présenté dans la réponse', /Plan généré/.test(r.json.reply.text), r.json.reply.text);
      assert('aucune exécution lancée (pas d\'actionLog d\'exécution)', !r.json.actionLog, JSON.stringify(r.json.actionLog));
    } finally {
      if (prev === undefined) delete process.env.CHAT_CONFIRM_PLANS; else process.env.CHAT_CONFIRM_PLANS = prev;
    }
  }

  section('A — Nouvel objectif (action:restart) -> nouvelle session propre');
  {
    const r = await A.req({ sessionId: sessionA, action: 'restart' });
    assert('200', r.status === 200);
    assert('nouveau sessionId', r.json.sessionId && r.json.sessionId !== sessionA);
    assert('phase greet + message d\'accueil', r.json.phase === 'greet' && r.json.reply && Array.isArray(r.json.reply.quick));
  }
  await A.close();

  // ============================ B. Moteur goal-chat brut (repli) ============================
  // L'orchestrateur ne prend pas la main (retourne null) : la route retombe sur goal-chat.js, contrat historique.
  const B = await startBridge({ chatOrchestrator: { handle: async () => null } });
  let sessionB;
  section('B — Moteur brut : question sur l\'information manquante (aucun plan)');
  {
    const r = await B.req({ message: 'Je veux vendre des produits aujourd\'hui' });
    assert('200', r.status === 200, JSON.stringify(r.json));
    assert('ok:true + sessionId', r.json.ok === true && !!r.json.sessionId);
    assert('une question est posée (reply présent)', !!(r.json.reply && r.json.reply.text));
    sessionB = r.json.sessionId;
  }

  section('B — Réponse à la clarification -> plan construit (vrai task-parser), aucune exécution avant confirmation');
  {
    const r = await B.req({ sessionId: sessionB, message: '50 produits, WhatsApp' });
    assert('200', r.status === 200, JSON.stringify(r.json));
    assert('phase ready + plan non vide', r.json.ctx && r.json.ctx.target === 50 && Array.isArray(r.json.plan) && r.json.plan.length > 0, JSON.stringify(r.json).slice(0, 300));
    assert('aucune exécution avant confirmation (pas d\'action lancée)', !r.json.execution);
  }

  section('B — Confirmation (action:run-plan) -> exécution réelle via automation-engine');
  {
    const r = await B.req({ sessionId: sessionB, action: 'run-plan' });
    assert('200', r.status === 200, JSON.stringify(r.json));
    assert('ok:true', r.json.ok === true, JSON.stringify(r.json).slice(0, 300));
    assert('execution renseignée (runId + executed)', r.json.execution && typeof r.json.execution.executed === 'number', JSON.stringify(r.json.execution));
  }

  section('B — Nouvel objectif (action:restart) -> nouvelle session propre');
  {
    const r = await B.req({ sessionId: sessionB, action: 'restart' });
    assert('200', r.status === 200);
    assert('nouveau sessionId', r.json.sessionId && r.json.sessionId !== sessionB);
    assert('phase greet + message d\'accueil', r.json.phase === 'greet' && r.json.reply && Array.isArray(r.json.reply.quick));
  }
  await B.close();

  console.log('\n========================================');
  console.log('RÉSULTATS : ' + passed + ' passés, ' + failed + ' échoués');
  console.log('========================================');
  process.exitCode = failed ? 1 : 0;
})().catch((err) => { console.error('RUNNER CRASH:', err); process.exit(1); });
