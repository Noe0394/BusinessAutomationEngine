// Boucle d'agent multi-outils : plan -> outil -> résultat -> vérification -> suite.
// Bornée (étapes, budget IA, timeouts, détection de boucle). Un outil sensible
// s'arrête à PREPARE et attend la confirmation de l'utilisateur.
const llmFallbackEngine = require('../../lib/ai/llmFallbackEngine');
const personaManager = require('../personaManager');
const toolRegistry = require('../toolRegistry');
const loopGuard = require('../loopGuard');
const authz = require('../authz');
const { describeTools } = require('../toolAgent');
const capabilityGap = require('../capabilityGap');
const claimGuard = require('../claimGuard');

const LIMITS = { maxSteps: 5, totalTimeoutMs: 60000, toolTimeoutMs: 25000, maxAiCalls: 8 };
const PENDING_TTL_MS = 10 * 60 * 1000;
const pending = new Map(); // tenant:session -> { call, ctx, expires }

function extractJson(raw) {
  const s = String(raw || '');
  const a = s.indexOf('{'); const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`TIMEOUT ${label}`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function sig(name, args) { return `${name}:${JSON.stringify(args || {})}`; }
function brief(v) { const s = JSON.stringify(v == null ? {} : v); return s.length > 1500 ? s.slice(0, 1500) + '…' : s; }

async function defaultLlm(prompt, history) {
  const r = await llmFallbackEngine.generateAIResponse(prompt, history || [], null, undefined, null, { purpose: 'jarvis_agent', tier: 'reasoning' });
  return r.text;
}

function icon(state) { return state === 'SUCCESS' ? '✅' : (state === 'UNCONFIRMED' || state === 'NEEDS_CONFIRMATION' ? '⚠️' : '❌'); }
function status(state) { return state === 'SUCCESS' ? 'done' : (state === 'UNCONFIRMED' || state === 'NEEDS_CONFIRMATION' ? 'warning' : 'error'); }

async function runAgentLoop({ text, history, tenantId, sessionId }, deps) {
  const d = deps || {};
  const limits = Object.assign({}, LIMITS, d.limits || {});
  const llm = typeof d.llm === 'function' ? d.llm : defaultLlm;
  const ctx = { runtime: d.runtime || null, permissions: d.permissions || ['messages:send'], generateImage: d.generateImage || null, confirmFrom: d.confirmFrom || process.env.JARVIS_CONFIRM_FROM || null, autonomous: d.autonomous === true };
  const tools = toolRegistry.list(ctx);
  const taskId = `agent:${tenantId}:${sessionId || 'x'}:${Date.now()}`;
  const started = Date.now();
  let aiCalls = 0;
  const ai = async (prompt) => {
    aiCalls += 1;
    if (aiCalls > limits.maxAiCalls) throw new Error('AI_BUDGET');
    loopGuard.countAiCall(taskId);
    return llm(prompt, history || []);
  };

  const steps = [];
  const seen = new Set();
  let stopReason = 'DONE';

  for (let i = 0; i < limits.maxSteps; i += 1) {
    if (Date.now() - started > limits.totalTimeoutMs) { stopReason = 'TIMEOUT'; break; }
    const prior = steps.map((s, k) => `Étape ${k + 1} — ${s.name}(${JSON.stringify(s.args)}) => ${s.state} ${brief(s.result || s.error)}`).join('\n');
    const planPrompt = [
      personaManager.personaSystemPrompt('default'),
      'Tu peux enchaîner plusieurs outils RÉELS pour accomplir la demande. Outils disponibles :',
      describeTools(tools),
      `Demande du vendeur : "${text}"`,
      prior ? `Déjà exécuté (résultats RÉELS) :\n${prior}` : 'Rien n\'a encore été exécuté.',
      'Réponds UNIQUEMENT en JSON : {"tool":"nom_exact","args":{...}} pour l\'étape suivante, {"done":true} si la demande est accomplie, {"tool":null,"impossible":true} si la demande exige une ACTION (créer, modifier, supprimer, envoyer, activer…) qu\'AUCUN outil de la liste ne permet, ou {"tool":null} pour une simple conversation.',
      'Une demande d\'ACTION n\'est accomplie que si l\'outil correspondant a été exécuté avec succès : pour supprimer, utilise un outil de suppression ; pour modifier, un outil de modification. Ne considère JAMAIS une lecture (liste, statut) comme la réalisation d\'une écriture.',
      'N\'invente jamais un outil. Ne répète jamais un appel identique. Exécute la demande telle que formulée, sans la contredire ni ajouter d\'étape qu\'elle ne demande pas.',
    ].join('\n');
    let plan;
    try { plan = extractJson(await ai(planPrompt)); } catch (e) { stopReason = e.message === 'AI_BUDGET' ? 'AI_BUDGET' : 'PLAN_ERROR'; break; }
    if (!plan || plan.done || !plan.tool) { stopReason = (plan && plan.impossible) ? 'IMPOSSIBLE' : 'DONE'; break; }
    if (!tools.some((t) => t.name === plan.tool)) { stopReason = 'UNKNOWN_TOOL'; break; }
    const key = sig(plan.tool, plan.args);
    if (seen.has(key)) { stopReason = 'LOOP_DETECTED'; break; }
    seen.add(key);

    let call;
    try {
      call = await withTimeout(toolRegistry.execute(tenantId, plan.tool, plan.args || {}, ctx), limits.toolTimeoutMs, plan.tool);
    } catch (e) {
      call = { name: plan.tool, args: plan.args || {}, state: 'FAILED', error: { code: 'TOOL_TIMEOUT', message: e.message } };
    }
    steps.push({ name: plan.tool, args: plan.args || {}, state: call.state, risk: call.risk || null, result: call.result || null, error: call.error || null, verification: call.verification || null });

    if (call.state === 'NEEDS_CONFIRMATION') {
      // L'action préparée reste liée à l'identité qui l'a demandée : seul le même principal peut la confirmer.
      pending.set(`${tenantId}:${sessionId || 'x'}`, { name: plan.tool, args: plan.args || {}, ctx, principal: authz.currentPrincipal(), expires: Date.now() + PENDING_TTL_MS });
      stopReason = 'NEEDS_CONFIRMATION';
      break;
    }
    if (call.state !== 'SUCCESS') { stopReason = call.state; break; }
    if (i === limits.maxSteps - 1) stopReason = 'MAX_STEPS';
  }

  const requestText = d.rawText || text;
  if (!steps.length) {
    if (d.returnGap === false) return null;
    // Une demande d'ACTION qu'aucun outil ne permet ne retombe JAMAIS sur la conversation libre (qui pourrait prétendre l'avoir faite) : réponse claire sur ce qui est / n'est pas possible.
    if (stopReason === 'IMPOSSIBLE' || capabilityGap.isActionRequest(requestText)) {
      return { text: capabilityGap.explain(requestText, tools), steps: [], stopReason: 'NO_TOOL', toolCalls: [], impossible: true, actionLog: [{ icon: '🚫', label: 'Aucune fonction ne correspond : rien exécuté', status: 'warning' }] };
    }
    return null; // simple conversation : la conversation générique reprend la main
  }

  const results = steps.map((s, k) => `Étape ${k + 1} ${s.name} : ${s.state} — ${brief(s.result || s.error)}`).join('\n');
  const ansPrompt = [
    personaManager.personaSystemPrompt('default'),
    `Demande du vendeur : "${text}"`,
    `Résultats RÉELS des outils (n'invente rien au-delà) :\n${results}`,
    `Fin de la boucle : ${stopReason}.`,
    stopReason === 'NEEDS_CONFIRMATION'
      ? 'Une confirmation a été configurée pour cette action : présente l\'aperçu (destinataire, contenu) et attends un oui/non.'
      : (steps.every((s) => s.state === 'SUCCESS') ? 'Réponds naturellement en citant les faits réels.' : 'Explique honnêtement ce qui a réussi, échoué ou n\'est pas confirmé — ne prétends JAMAIS qu\'une action est faite si elle ne l\'est pas.'),
  ].join('\n');
  let answer = '';
  try { answer = String(await ai(ansPrompt) || '').trim(); } catch (e) { answer = ''; }
  if (!answer) {
    answer = stopReason === 'NEEDS_CONFIRMATION' ? 'Action préparée, en attente de votre confirmation (oui/non).' : (steps.every((s) => s.state === 'SUCCESS') ? 'C\'est fait.' : `Je n'ai pas pu tout finaliser (${stopReason}).`);
  }
  const last = steps[steps.length - 1];
  const toolCalls = steps.map((s) => ({ name: s.name, state: s.state, risk: s.risk }));
  // Preuve affichée à l'utilisateur : ce qui a RÉELLEMENT été exécuté / vérifié dans ce tour (jamais une simple parole du modèle).
  const proof = steps.filter((s) => s.risk && s.risk !== 'READ').map((s) => `${s.state === 'SUCCESS' ? '✔ Vérifié' : (s.state === 'UNCONFIRMED' ? '⚠ Exécuté mais non confirmé' : (s.state === 'NEEDS_CONFIRMATION' ? '⏸ En attente de votre confirmation' : '✖ Échec'))} : ${s.name}`);
  answer = claimGuard.guard(answer, { toolCalls, actionLog: steps.map((s) => ({ status: status(s.state) })) }, { request: requestText }).text;
  if (proof.length) answer += `\n\n${proof.join('\n')}`;
  return {
    text: answer,
    steps,
    toolCalls,
    stopReason,
    toolCall: { name: last.name, state: last.state, result: last.result, error: last.error, confirmationId: (last.verification && last.verification.confirmationId) || null },
    actionLog: steps.map((s) => ({ icon: icon(s.state), label: `${s.name} → ${s.state}`, status: status(s.state) })),
  };
}

// Réponse de l'utilisateur à une confirmation en attente ("oui" -> EXECUTE + VERIFY).
async function resolvePending({ tenantId, sessionId, text }, deps) {
  const key = `${tenantId}:${sessionId || 'x'}`;
  const p = pending.get(key);
  if (!p) return null;
  if (Date.now() > p.expires) { pending.delete(key); return null; }
  const who = authz.currentPrincipal();
  if (p.principal && (!who || who.tenant !== p.principal.tenant || who.role !== p.principal.role)) return null; // pas le même appelant : jamais de confirmation par un autre
  if (personaManager.detectDecline(text)) {
    pending.delete(key);
    return { text: 'D\'accord, j\'annule : rien n\'a été exécuté.', actionLog: [{ icon: '🚫', label: `${p.name} annulé`, status: 'warning' }] };
  }
  if (!personaManager.detectAffirmative(text)) return null;
  pending.delete(key);
  const call = await toolRegistry.execute(tenantId, p.name, p.args, Object.assign({}, p.ctx, (deps && deps.ctx) || {}, { confirmed: true }));
  const ok = call.state === 'SUCCESS';
  const txt = ok
    ? `C'est fait et vérifié (${p.name}${call.verification && call.verification.confirmationId ? ', réf. ' + call.verification.confirmationId : ''}).`
    : `Je n'ai pas pu finaliser : ${call.state}${call.error && call.error.code ? ' — ' + call.error.code : ''}.`;
  return { text: txt, toolCall: { name: p.name, state: call.state, result: call.result || null, error: call.error || null }, actionLog: [{ icon: icon(call.state), label: `${p.name} → ${call.state}`, status: status(call.state) }] };
}

module.exports = { runAgentLoop, resolvePending, LIMITS };
