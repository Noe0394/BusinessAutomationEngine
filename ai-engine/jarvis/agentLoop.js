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
const pendingToolActions = require('../pendingToolActions');
const verbatimPayload = require('../verbatimPayload');

// Une boucle de chat reste courte et interactive. Les missions longues passent
// par missionOrchestrator, qui persiste le plan et exécute les étapes en fond.
const LIMITS = { maxSteps: 12, totalTimeoutMs: 90000, toolTimeoutMs: 25000, maxAiCalls: 26 };
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

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
  // Les modules de fonctionnalités reçoivent les moteurs déjà instanciés par
  // le serveur; ils restent ainsi communs au Chat et aux deux canaux self.
  // Les champs d'identité, de runtime et de confirmation sont réécrits après
  // toolContext et ne peuvent donc pas être remplacés par un module.
  const principal = authz.currentPrincipal();
  const ctx = Object.assign({}, d.toolContext || {}, { principal, runtime: d.runtime || null, permissions: d.permissions || ['messages:send'], generateImage: d.generateImage || null, confirmFrom: d.confirmFrom || process.env.JARVIS_CONFIRM_FROM || null, autonomous: d.autonomous === true });
  // Le registre sélectionne les outils pertinents à partir de leurs
  // métadonnées. La limite borne le contexte du modèle sans plafonner le
  // catalogue ni le nombre d'outils disponibles.
  const tools = await toolRegistry.discover(text, ctx, { limit: Number.MAX_SAFE_INTEGER });
  const taskId = `agent:${tenantId}:${sessionId || 'x'}:${Date.now()}`;
  const started = Date.now();
  let aiCalls = 0;
  const ai = async (prompt) => {
    aiCalls += 1;
    if (aiCalls > limits.maxAiCalls) throw new Error('AI_BUDGET');
    loopGuard.countAiCall(taskId);
    return llm(prompt, history || []);
  };

  const steps = Array.isArray(d.resumeSteps) ? d.resumeSteps.map((s) => Object.assign({}, s)) : [];
  const seen = new Set(steps.map((s) => sig(s.name, s.args)));
  let stopReason = steps.length >= limits.maxSteps ? 'MAX_STEPS' : 'DONE';
  let pendingActionId = null;

  for (let i = steps.length; i < limits.maxSteps; i += 1) {
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
    const exactArgs = verbatimPayload.applyVerbatimText(plan.tool, plan.args || {}, text);
    const key = sig(plan.tool, exactArgs);
    if (seen.has(key)) { stopReason = 'LOOP_DETECTED'; break; }
    seen.add(key);

    let call;
    try {
      call = await withTimeout(toolRegistry.execute(tenantId, plan.tool, exactArgs, ctx), limits.toolTimeoutMs, plan.tool);
    } catch (e) {
      const timedOut = /^TIMEOUT\b/.test(String(e && e.message || ''));
      call = { name: plan.tool, args: exactArgs, state: timedOut ? 'UNCONFIRMED' : 'FAILED',
        error: { code: timedOut ? 'TOOL_TIMEOUT' : 'EXECUTION_ERROR', message: e.message },
        verification: timedOut ? { verified: false, source: 'agent_timeout' } : undefined };
    }
    steps.push({ name: plan.tool, args: exactArgs, state: call.state, risk: call.risk || null, result: call.result || null, error: call.error || null, verification: call.verification || null });

    if (call.state === 'NEEDS_CONFIRMATION') {
      // La décision humaine est durable et porte les arguments exacts préparés.
      // Le runtime et les permissions seront reconstruits puis revérifiés à la confirmation.
      try {
        const action = await pendingToolActions.create(tenantId, {
          userId: principal && principal.userId,
          role: principal && principal.role,
          sessionId,
          conversationId: sessionId,
          serviceId: (d.toolContext && d.toolContext.serviceId) || (d.toolContext && d.toolContext.activeService && d.toolContext.activeService.id) || null,
          tool: plan.tool,
          riskLevel: call.risk || 'WRITE',
          ttlMs: PENDING_TTL_MS,
          payload: { request: text, history: (history || []).slice(-12), steps, pendingArgs: exactArgs },
        });
        pendingActionId = action.pendingActionId;
      } catch (err) {
        const lastStep = steps[steps.length - 1];
        if (lastStep) {
          lastStep.state = 'BLOCKED';
          lastStep.error = { code: 'PENDING_ACTION_PERSIST_FAILED', message: String(err.message || err) };
        }
        stopReason = 'PENDING_ACTION_PERSIST_FAILED';
        break;
      }
      stopReason = 'NEEDS_CONFIRMATION';
      break;
    }
    if (call.state !== 'SUCCESS') {
      stopReason = call.state === 'FAILED' && call.error && call.error.code === 'MISSING_INPUT' ? 'NEEDS_INPUT' : call.state;
      break;
    }
    if (i === limits.maxSteps - 1) stopReason = 'MAX_STEPS';
  }

  // Une demande plus longue que le tour interactif est transférée au moteur
  // de missions persistant avec ses résultats déjà vérifiés. Le planificateur
  // reprend ensuite les étapes restantes après chaque lot, sans limite globale.
  if (['MAX_STEPS', 'TIMEOUT', 'AI_BUDGET'].includes(stopReason) && steps.length
    && steps.every((step) => step.state === 'SUCCESS')) {
    const handoffText = d.rawText || text;
    try {
      const mission = await require('../missionOrchestrator').start({
        text: handoffText, tenantId, sessionId, channel: principal && principal.channel,
        history: history || [], completedSteps: steps,
      }, {
        runtime: d.runtime || null, permissions: d.permissions || ['messages:send'],
        toolContext: d.toolContext || undefined, generateImage: d.generateImage || null,
        llm: typeof d.llm === 'function' ? d.llm : undefined, background: true,
      });
      if (mission && mission.missionId) {
        return {
          text: `${steps.length} étape(s) ont été exécutées et vérifiées. Je poursuis la mission ${mission.missionId} en arrière-plan avec leurs résultats, sans les rejouer.`,
          missionId: mission.missionId, taskId: mission.taskId, state: mission.state || 'planning',
          stopReason: 'HANDED_OFF_TO_PERSISTENT_MISSION',
          toolCalls: steps.map((step) => ({ name: step.name, state: step.state, risk: step.risk })),
          actionLog: [{ icon: '⏳', label: `${steps.length} étape(s) vérifiée(s), suite persistée`, status: 'pending' }],
        };
      }
      return {
        text: `${steps.length} étape(s) ont été vérifiées, mais je n’ai pas pu enregistrer la suite de la mission. Elle reste incomplète.`,
        stopReason: 'MISSION_HANDOFF_FAILED',
        toolCalls: steps.map((step) => ({ name: step.name, state: step.state, risk: step.risk })),
        actionLog: [{ icon: '⚠️', label: 'Suite non persistée — mission incomplète', status: 'warning' }],
      };
    } catch (err) {
      console.error('agentLoop mission handoff failed:', err.message);
      return {
        text: `${steps.length} étape(s) ont été vérifiées, mais je n’ai pas pu enregistrer la suite de la mission. Elle reste incomplète.`,
        stopReason: 'MISSION_HANDOFF_FAILED',
        toolCalls: steps.map((step) => ({ name: step.name, state: step.state, risk: step.risk })),
        actionLog: [{ icon: '⚠️', label: 'Suite non persistée — mission incomplète', status: 'warning' }],
      };
    }
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
  const last = steps[steps.length - 1];
  const ansPrompt = [
    personaManager.personaSystemPrompt('default'),
    `Demande du vendeur : "${text}"`,
    `Résultats RÉELS des outils (n'invente rien au-delà) :\n${results}`,
    `Fin de la boucle : ${stopReason}.`,
    stopReason === 'NEEDS_CONFIRMATION'
      ? `Une confirmation est requise pour l'action préparée ${pendingActionId || ''} : présente l'aperçu (destinataire, contenu) et attends un oui/non. N'affirme pas que l'action a été exécutée.`
      : (steps.every((s) => s.state === 'SUCCESS') ? 'Réponds naturellement en citant les faits réels.' : 'Explique honnêtement ce qui a réussi, échoué ou n\'est pas confirmé — ne prétends JAMAIS qu\'une action est faite si elle ne l\'est pas.'),
  ].join('\n');
  let answer = '';
  if (stopReason === 'NEEDS_INPUT') {
    const missing = Array.isArray(last.error && last.error.fields) ? last.error.fields : [];
    const descriptor = tools.find((t) => t.name === last.name);
    const labels = missing.map((field) => {
      const spec = descriptor && descriptor.inputSchema && descriptor.inputSchema[field];
      return spec && spec.description ? `${field} (${spec.description})` : String(field);
    });
    answer = `Il me manque ${labels.length ? labels.join(', ') : 'une information obligatoire'} pour ${last.name}. Rien n’a été exécuté.`;
  } else {
    try { answer = String(await ai(ansPrompt) || '').trim(); } catch (e) { answer = ''; }
  }
  if (!answer) {
    answer = stopReason === 'NEEDS_CONFIRMATION' ? `Action préparée, en attente de votre confirmation (oui/non) — référence ${pendingActionId}.` : (steps.every((s) => s.state === 'SUCCESS') ? 'C\'est fait.' : `Je n'ai pas pu tout finaliser (${stopReason}).`);
  }
  if (steps.length && steps.every((s) => s.state === 'SUCCESS') && last.result && typeof last.result === 'object') {
    const reference = ['confirmationId', 'messageId', 'campaignId', 'invoiceNumber', 'reference', 'id']
      .map((key) => last.result[key]).find((value) => value != null && String(value).trim());
    if (reference && !answer.includes(String(reference))) answer += `\nRéférence confirmée : ${String(reference)}`;
  }
  if (stopReason === 'NEEDS_CONFIRMATION' && pendingActionId) answer += `\nRéférence de confirmation : ${pendingActionId}.`;
  if (stopReason === 'PENDING_ACTION_PERSIST_FAILED') answer = 'Je ne peux pas enregistrer cette confirmation de façon fiable. Rien n’a été exécuté. Réessayez plus tard.';
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
    pendingActionId,
    actionLog: steps.map((s) => ({ icon: icon(s.state), label: `${s.name} → ${s.state}`, status: status(s.state) })),
  };
}

// Réponse de l'utilisateur à une confirmation en attente ("oui" -> EXECUTE + VERIFY).
async function resolvePending({ tenantId, sessionId, conversationId, text, history }, deps) {
  const principal = authz.currentPrincipal();
  if (!authz.isPrincipal(principal)
    || (principal.tenant !== String(tenantId) && principal.role !== 'ADMIN')) return null;
  const idMatch = String(text || '').match(/\bACT-[A-F0-9]{12}\b/i);
  const decline = personaManager.detectDecline(text);
  const affirmative = personaManager.detectAffirmative(text);
  if (!idMatch && !decline && !affirmative) return null;
  const identity = { tenant: tenantId, userId: principal.userId, role: principal.role, sessionId, conversationId: conversationId || sessionId };
  const actions = await pendingToolActions.listForIdentity(tenantId, identity);
  const active = actions.filter((a) => ['PENDING', 'EXECUTING'].includes(a.status));
  const selected = idMatch
    ? actions.find((a) => a.pendingActionId === idMatch[0].toUpperCase())
    : active.length === 1 ? active[0] : null;
  if (!selected) return null;
  if (active.length > 1 && !idMatch) {
    return { text: 'Plusieurs actions attendent une confirmation ou une vérification. Répondez avec la référence affichée pour l’action voulue.', pendingActions: active.map((a) => ({ pendingActionId: a.pendingActionId, tool: a.tool, status: a.status })) };
  }
  if (selected.status === 'EXECUTING') {
    return { text: `L’action ${selected.pendingActionId} avait commencé avant l’interruption. Son résultat doit être vérifié avant toute nouvelle tentative.`, pendingActionId: selected.pendingActionId, stopReason: 'NEEDS_REVIEW' };
  }
  if (selected.status === 'DONE') {
    const payload = await pendingToolActions.readPayload(selected);
    const call = payload.completedCall || {};
    return { text: `Cette action a déjà été exécutée et vérifiée (${selected.tool}, référence ${selected.pendingActionId}).`, pendingActionId: selected.pendingActionId,
      toolCall: { name: selected.tool, state: call.state || 'SUCCESS', result: call.result || null, error: call.error || null } };
  }
  if (selected.status !== 'PENDING') return null;
  if (decline) {
    const rejected = await pendingToolActions.transition(tenantId, selected.pendingActionId, 'PENDING', 'REJECTED');
    if (!rejected.ok) return { text: 'Cette action a déjà été traitée ; rien n’a été relancé.' };
    return { text: 'D’accord, j’annule l’action préparée. Rien n’a été exécuté.', pendingActionId: selected.pendingActionId,
      actionLog: [{ icon: '🚫', label: `${selected.tool} annulé`, status: 'warning' }] };
  }
  if (!affirmative) return null;

  let payload;
  try { payload = await pendingToolActions.readPayload(selected); }
  catch (err) { return { text: 'Je ne peux pas relire en sécurité les arguments préparés. Rien n’a été exécuté.', pendingActionId: selected.pendingActionId, stopReason: 'PENDING_PAYLOAD_UNAVAILABLE' }; }
  const claimed = await pendingToolActions.transition(tenantId, selected.pendingActionId, 'PENDING', 'EXECUTING');
  if (!claimed.ok) return { text: 'Cette action a déjà été prise en charge ou a expiré ; rien n’a été relancé.', pendingActionId: selected.pendingActionId };

  const ctx = Object.assign({}, (deps && deps.ctx) || {}, { principal, confirmed: true,
    runtime: (deps && deps.ctx && deps.ctx.runtime) || null,
    permissions: (deps && deps.ctx && deps.ctx.permissions) || ['messages:send'],
    generateImage: (deps && deps.ctx && deps.ctx.generateImage) || null });
  let call;
  try { call = await toolRegistry.execute(tenantId, selected.tool, payload.pendingArgs || {}, ctx); }
  catch (err) { call = { name: selected.tool, state: 'FAILED', error: { code: 'EXECUTION_ERROR', message: String(err.message || err) } }; }
  const completedSteps = Array.isArray(payload.steps) ? payload.steps.map((s) => Object.assign({}, s)) : [];
  const pendingStep = completedSteps.findLast ? completedSteps.findLast((s) => s.name === selected.tool && s.state === 'NEEDS_CONFIRMATION') : completedSteps.slice().reverse().find((s) => s.name === selected.tool && s.state === 'NEEDS_CONFIRMATION');
  if (pendingStep) {
    pendingStep.state = call.state; pendingStep.result = call.result || null; pendingStep.error = call.error || null;
    pendingStep.verification = call.verification || null;
  } else completedSteps.push({ name: selected.tool, args: payload.pendingArgs || {}, state: call.state, risk: call.risk || selected.riskLevel, result: call.result || null, error: call.error || null, verification: call.verification || null });

  if (call.state !== 'SUCCESS') {
    const failedStatus = call.state === 'UNCONFIRMED' ? 'NEEDS_REVIEW' : 'FAILED';
    await pendingToolActions.transition(tenantId, selected.pendingActionId, 'EXECUTING', failedStatus,
      { payload: Object.assign({}, payload, { completedCall: call, steps: completedSteps }) });
    const txt = call.state === 'UNCONFIRMED'
      ? `L’action ${selected.tool} a été tentée, mais son résultat n’est pas confirmé. Je ne la relance pas automatiquement.`
      : `Je n’ai pas pu exécuter l’action préparée : ${call.state}${call.error && call.error.code ? ' — ' + call.error.code : ''}.`;
    return { text: txt, pendingActionId: selected.pendingActionId,
      toolCall: { name: selected.tool, state: call.state, result: call.result || null, error: call.error || null },
      actionLog: [{ icon: icon(call.state), label: `${selected.tool} → ${call.state}`, status: status(call.state) }] };
  }

  const finished = await pendingToolActions.transition(tenantId, selected.pendingActionId, 'EXECUTING', 'DONE',
    { payload: Object.assign({}, payload, { completedCall: call, steps: completedSteps }) });
  if (!finished.ok) return { text: 'L’action a été exécutée, mais son état persistant n’a pas pu être confirmé. Je ne la relance pas.', pendingActionId: selected.pendingActionId, stopReason: 'NEEDS_REVIEW' };

  // Continue an explicit composition from its next step. The confirmed call
  // and previous results are carried forward, so none are planned twice.
  const confirmedStepIndex = completedSteps.findIndex((step) => step.name === selected.tool
    && JSON.stringify(step.args || {}) === JSON.stringify(payload.pendingArgs || {}) && step.state === 'SUCCESS');
  const hasPriorResult = completedSteps.slice(0, Math.max(0, confirmedStepIndex)).some((step) => step.state === 'SUCCESS');
  const requestIsComposite = /\b(?:puis|ensuite|apr[eè]s|d'abord)\b|\bet\s+(?:envoi|envoy|extrait|ajout|inscri|relanc|cr[eé]e|cherche|list|r[eé]cup[eè]re|pr[eé]pare|fais)\w*/i.test(payload.request || '');
  if (hasPriorResult || requestIsComposite) {
    const continuationCtx = Object.assign({}, (deps && deps.ctx) || {});
    const continuation = await runAgentLoop({ text: payload.request, history: history || payload.history || [], tenantId, sessionId }, {
      toolContext: continuationCtx, runtime: continuationCtx.runtime || null,
      permissions: continuationCtx.permissions || ['messages:send'],
      generateImage: continuationCtx.generateImage || null,
      confirmFrom: continuationCtx.confirmFrom || null,
      llm: deps && typeof deps.llm === 'function' ? deps.llm : undefined,
      resumeSteps: completedSteps, rawText: payload.request,
    });
    if (continuation) {
      continuation.pendingActionId = null;
      continuation.confirmedActionId = selected.pendingActionId;
      return continuation;
    }
  }
  const resultReference = call.result && typeof call.result === 'object'
    ? ['confirmationId', 'messageId', 'campaignId', 'invoiceNumber', 'reference', 'id'].map((key) => call.result[key]).find((value) => value != null && String(value).trim())
    : null;
  return { text: `Action exécutée et vérifiée (${selected.tool}, référence ${selected.pendingActionId}).${resultReference ? ` Référence plateforme : ${resultReference}.` : ''}`, pendingActionId: selected.pendingActionId, confirmedActionId: selected.pendingActionId,
    toolCall: { name: selected.tool, state: call.state, result: call.result || null, error: null },
    actionLog: [{ icon: icon(call.state), label: `${selected.tool} → ${call.state}`, status: status(call.state) }] };
}

module.exports = { runAgentLoop, resolvePending, LIMITS };
