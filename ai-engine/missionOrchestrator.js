'use strict';

// Orchestration par objectif : l'IA planifie, le registre exécute les outils,
// les moteurs existants réalisent les opérations et le journal persiste les résultats.
const crypto = require('crypto');
const storage = require('./storageAdapter');
const authz = require('./authz');
const activityStore = require('./activityStore');
const businessServices = require('./businessServices');
const registry = () => require('./toolRegistry');

const NS = 'objective_missions';
const MAX_STEPS = 10;
const MAX_MISSIONS = 100;
const monitorTimers = new Map();
const uid = () => 'mis_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
const safeTenant = (v) => String(v || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';

async function readDoc(tenant) {
  return storage.get(NS, safeTenant(tenant), { tenant: safeTenant(tenant), missions: {} });
}
async function saveMission(tenant, mission) {
  const doc = await readDoc(tenant);
  doc.missions[mission.id] = mission;
  const ordered = Object.values(doc.missions).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  doc.missions = Object.fromEntries(ordered.slice(0, MAX_MISSIONS).map((m) => [m.id, m]));
  storage.set(NS, safeTenant(tenant), doc);
  return mission;
}
async function get(tenant, id) {
  const doc = await readDoc(tenant);
  return doc.missions[String(id || '')] || null;
}
async function list(tenant, limit) {
  const doc = await readDoc(tenant);
  return Object.values(doc.missions).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, Math.max(1, Math.min(50, Number(limit) || 20)));
}
function compact(v, max) {
  let s;
  try { s = JSON.stringify(v == null ? null : v); } catch (e) { s = String(v); }
  return s.length > (max || 3000) ? s.slice(0, max || 3000) + '…' : s;
}
function summarizeResult(value) {
  if (!value || typeof value !== 'object') return 'résultat reçu';
  const parts = [];
  for (const k of ['count', 'total', 'sent', 'success', 'failed', 'skipped', 'duplicates', 'invalid', 'valid', 'added', 'alreadyPresent', 'notAdded']) {
    if (value[k] != null && typeof value[k] !== 'object') parts.push(k + '=' + value[k]);
  }
  if (value.status) parts.push('statut=' + String(value.status));
  if (value.state) parts.push('état=' + String(value.state));
  return parts.length ? parts.join(', ') : 'résultat vérifié';
}
function parseJson(raw) {
  const s = String(raw || '');
  const first = s.indexOf('{'); const last = s.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try { return JSON.parse(s.slice(first, last + 1)); } catch (e) { return null; }
}
function resolveRefs(value, prior) {
  if (Array.isArray(value)) return value.map((v) => resolveRefs(v, prior));
  if (!value || typeof value !== 'object') return value;
  if (typeof value.$ref === 'string') {
    const parts = value.$ref.split('.');
    const id = parts.shift();
    const step = prior[id];
    if (!step || step.state !== 'SUCCESS') throw new Error('REFERENCE_UNAVAILABLE:' + value.$ref);
    let found = step.result;
    for (const key of parts) found = found == null ? undefined : found[key];
    if (found === undefined) throw new Error('REFERENCE_FIELD_MISSING:' + value.$ref);
    return found;
  }
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = resolveRefs(v, prior);
  return out;
}
function availableTools(ctx) {
  return registry().list(ctx).filter((t) => t.feature !== 'facebook_marketing' && !/^facebook/i.test(t.name));
}
function plannerPrompt({ objective, tools, completed, previousPlan, businessContext }) {
  return [
    'Tu es le planificateur d’objectifs de Cyrus. Tu comprends et choisis; les outils et moteurs exécutent. Réponds en JSON strict uniquement.',
    'Construis un plan court de 1 à 10 étapes. Utilise uniquement les noms exacts ci-dessous. Fais les lectures nécessaires (Service métier, groupes, contacts, campagnes) avant les actions. N’invente ni groupe, ni contact, ni prix, ni identifiant, ni réussite.',
    'Les opérations déterministes restent dans les outils. N’ajoute pas de comptage/normalisation si un outil de préparation le fait déjà. Utilise {"$ref":"ID.result.champ"} dans les arguments pour reprendre la sortie réelle d’une étape précédente.',
    'Si une information réellement indispensable manque et n’existe pas dans les résultats, renvoie {"needsInput":true,"question":"...","steps":[]} et ne planifie aucune action externe. Sinon renvoie {"needsInput":false,"steps":[{"id":"s1","tool":"nomExact","args":{},"label":"description courte"}]}.',
    'Pour un objectif de vente, recherche l’offre et les cibles avant de préparer le message. Si le texte, le prix ou un canal indispensable manque des données disponibles, demande uniquement cette information. Ne prétends pas confirmer des conversions sans source de conversion.',
    businessContext ? 'Contexte des Services métier réellement configurés :\n' + businessContext.slice(0, 12000) : 'Aucun contexte Service métier configuré n’est disponible.',
    'Objectif utilisateur : ' + JSON.stringify(objective).slice(0, 3000),
    previousPlan ? 'Plan précédent arrêté : ' + compact(previousPlan, 2000) : '',
    completed.length ? 'Étapes déjà réellement vérifiées (ne pas répéter) : ' + compact(completed, 5000) : '',
    'Outils réellement autorisés :\n' + tools.map((t) => t.name + ' [' + t.risk + '] ' + t.description + ' paramètres=' + compact(t.inputSchema, 500)).join('\n'),
  ].filter(Boolean).join('\n\n');
}

async function makePlan(mission, deps, priorPlan) {
  const principal = authz.currentPrincipal();
  if (!authz.isPrincipal(principal) || principal.tenant !== mission.tenant || !['OWNER', 'ADMIN'].includes(principal.role)) throw new Error('MISSION_PRINCIPAL_INVALID');
  const ctx = Object.assign({}, deps.toolContext || {}, { tenant: mission.tenant, principal,
    runtime: deps.runtime || null, permissions: deps.permissions || ['messages:send'],
    generateImage: deps.generateImage || null, autonomous: true });
  const tools = availableTools(ctx);
  let businessContext = '';
  try { businessContext = await businessServices.getEngineContextText(mission.tenant); } catch (e) { businessContext = ''; }
  const prompt = plannerPrompt({ objective: mission.objective, tools, completed: mission.steps.filter((s) => s.state === 'SUCCESS'), previousPlan: priorPlan, businessContext });
  const llm = deps.planLlm || deps.llm;
  let raw;
  if (typeof llm === 'function') raw = await llm(prompt, []);
  else {
    const engine = require('../lib/ai/llmFallbackEngine');
    const r = await engine.generateAIResponse(prompt, [], null, undefined, null, { purpose: 'objective_plan', tier: 'reasoning', maxTokens: 1500, tenant: mission.tenant });
    raw = r && r.text;
  }
  const plan = parseJson(raw);
  if (!plan || (!Array.isArray(plan.steps) && plan.needsInput !== true)) throw new Error('INVALID_OBJECTIVE_PLAN');
  if (plan.needsInput) return { needsInput: true, question: String(plan.question || 'Quelle information indispensable dois-je utiliser ?').slice(0, 500), steps: [] };
  if (!plan.steps.length || plan.steps.length > MAX_STEPS) throw new Error('OBJECTIVE_PLAN_STEP_LIMIT');
  const allowed = new Set(tools.map((t) => t.name));
  const normalized = plan.steps.map((s, i) => {
    if (!s || !allowed.has(s.tool) || !s.args || typeof s.args !== 'object' || Array.isArray(s.args)) throw new Error('OBJECTIVE_PLAN_INVALID_TOOL');
    return { id: /^[A-Za-z0-9_-]{1,40}$/.test(String(s.id || '')) ? String(s.id) : 's' + (i + 1),
      tool: s.tool, args: s.args, label: String(s.label || s.tool).slice(0, 160),
      state: 'PENDING', result: null, error: null };
  });
  const ids = new Set();
  for (const s of normalized) { if (ids.has(s.id)) throw new Error('OBJECTIVE_PLAN_DUPLICATE_ID'); ids.add(s.id); }
  return { needsInput: false, steps: normalized };
}

async function event(mission, type, status, detail, deps) {
  mission.updatedAt = Date.now();
  await saveMission(mission.tenant, mission);
  await activityStore.record({ type: 'objective_mission', action: type, status, tenant: mission.tenant, target: mission.id, detail: detail || mission.objective.slice(0, 250) });
  if (deps && typeof deps.notifyMission === 'function') {
    const message = 'Mission ' + mission.id + ' — ' + type + '\nObjectif : ' + mission.objective.slice(0, 300) + (detail ? '\n' + detail : '');
    await deps.notifyMission({ tenantId: mission.tenant, missionId: mission.id, text: message, status }).catch(() => {});
  }
}
function missingFields(tool, args) {
  return Object.entries(tool.inputSchema || {}).filter(([key, spec]) => spec.required && (args[key] == null || args[key] === '')).map(([key, spec]) => key + (spec.description ? ' (' + spec.description + ')' : ''));
}

function missionCampaigns(mission) {
  const drafts = new Map(mission.steps.filter((s) => s.state === 'SUCCESS' && s.tool === 'createCampaignDraft' && s.result && s.result.draftId).map((s) => [s.result.draftId, s.result]));
  return mission.steps.filter((s) => s.state === 'SUCCESS' && s.tool === 'launchCampaign' && s.result && s.result.campaignId).map((s) => {
    const draftId = s.executedArgs && s.executedArgs.draftId;
    const draft = drafts.get(draftId) || {};
    return { channel: draft.channel || s.result.channel || 'WHATSAPP', campaignId: s.result.campaignId };
  });
}
function campaignIsTerminal(status) { return /complete|finished|cancel|stop|failed|interrupted|terminated/i.test(String(status || '')); }
function objectiveRequiresExternalAction(text) {
  return /vend|prospect|campagn|promot|diffus|envoi|envoy|lanc|ajout(?:e|er|ez|ons)?|inscri|convert/i.test(String(text || ''));
}
function hasVerifiedExternalAction(mission, ctx) {
  const risks = new Map(availableTools(ctx).map((t) => [t.name, t.risk]));
  return mission.steps.some((s) => s.state === 'SUCCESS' && ['WRITE', 'SENSITIVE', 'CRITICAL'].includes(risks.get(s.tool)));
}
async function monitorMission(tenantId, id, deps) {
  const mission = await get(tenantId, id);
  if (!mission || mission.state !== 'monitoring') return;
  const principal = authz.currentPrincipal();
  if (!authz.isPrincipal(principal) || principal.tenant !== mission.tenant) return;
  const ctx = Object.assign({}, deps.toolContext || {}, { tenant: mission.tenant, principal,
    runtime: deps.runtime || null, permissions: deps.permissions || ['messages:send'] });
  const campaigns = missionCampaigns(mission);
  if (!campaigns.length) { mission.state = 'completed'; await event(mission, 'mission terminée', 'ok', 'Aucune campagne active à suivre.', deps); return; }
  let allTerminal = true; let changed = false;
  mission.progress = mission.progress || [];
  for (let i = 0; i < campaigns.length; i += 1) {
    const campaign = campaigns[i];
    const call = await registry().execute(tenantId, 'getCampaignStatus', campaign, ctx);
    if (call.state !== 'SUCCESS') { allTerminal = false; continue; }
    const r = call.result || {};
    const status = String(r.status || r.engineStatus || r.state || 'unknown');
    const progress = { channel: campaign.channel, campaignId: campaign.campaignId, status,
      total: Number(r.total || 0), sent: Number(r.success != null ? r.success : r.sent || 0),
      failed: Number(r.failed || 0), pending: Number(r.pendingCount || r.pending || 0), observedAt: Date.now() };
    const old = mission.progress[i];
    if (!old || old.status !== progress.status || old.sent !== progress.sent || old.failed !== progress.failed || old.pending !== progress.pending) changed = true;
    if (!campaignIsTerminal(status)) allTerminal = false;
    mission.progress[i] = progress;
  }
  if (allTerminal) {
    const salesObjective = /vend|vente|conversion|inscri|acc[eè]s.{0,15}(formation|cours)/i.test(mission.objective);
    mission.state = salesObjective ? 'awaiting_outcome' : 'completed';
    mission.outcomeNote = salesObjective ? 'Les campagnes sont terminées. Les envois sont mesurés; aucune conversion ne sera déclarée sans preuve dans les dossiers de vente.' : null;
    await event(mission, salesObjective ? 'envois terminés — vérification commerciale requise' : 'campagnes terminées', salesObjective ? 'warning' : 'ok',
      mission.progress.map((p) => p.channel + ': ' + p.sent + '/' + p.total + ', échecs ' + p.failed).join(' | ') + (mission.outcomeNote ? '\n' + mission.outcomeNote : ''), deps);
    monitorTimers.delete(id); return;
  }
  if (changed) await event(mission, 'progression réelle mise à jour', 'pending',
    mission.progress.map((p) => p.channel + ': ' + p.sent + '/' + p.total + ', échecs ' + p.failed + ', en attente ' + p.pending).join(' | '), deps);
  else await saveMission(tenantId, mission);
  const timer = setTimeout(() => monitorMission(tenantId, id, deps).catch(() => {}), 45000);
  if (timer.unref) timer.unref();
  monitorTimers.set(id, timer);
}
function scheduleMonitor(mission, deps) {
  if (monitorTimers.has(mission.id)) return;
  const timer = setTimeout(() => monitorMission(mission.tenant, mission.id, deps).catch(() => {}), 2000);
  if (timer.unref) timer.unref();
  monitorTimers.set(mission.id, timer);
}
async function recoverMonitoring(tenantId, id, deps) {
  const mission = await get(tenantId, id);
  if (!mission || mission.state !== 'monitoring') return mission;
  // Un statut "paused" du moteur est conservé. Il peut refléter une pause
  // demandée dans l'interface ou par une limitation de débit; le redémarrage
  // ne doit jamais relancer silencieusement des envois.
  return monitorMission(tenantId, id, deps);
}

async function executePlan(mission, deps) {
  const principal = authz.currentPrincipal();
  const ctx = Object.assign({}, deps.toolContext || {}, { tenant: mission.tenant, principal,
    runtime: deps.runtime || null, permissions: deps.permissions || ['messages:send'],
    generateImage: deps.generateImage || null, autonomous: true });
  const tools = new Map(availableTools(ctx).map((t) => [t.name, t]));
  const completedById = Object.fromEntries(mission.steps.filter((s) => s.state === 'SUCCESS').map((s) => [s.id, s]));
  for (const step of mission.steps) {
    if (mission.state === 'paused' || mission.state === 'stopped') break;
    if (step.state === 'SUCCESS') continue;
    if (step.state === 'RUNNING') {
      step.state = 'UNCONFIRMED'; step.error = { code: 'INTERRUPTED_DURING_EXECUTION' };
      mission.state = 'needs_review';
      await event(mission, 'étape interrompue — vérification requise', 'warning', step.label, deps);
      return mission;
    }
    const tool = tools.get(step.tool);
    if (!tool) {
      step.state = 'BLOCKED'; step.error = { code: 'TOOL_NOT_AVAILABLE' }; mission.state = 'failed';
      await event(mission, 'outil indisponible', 'error', step.tool, deps); return mission;
    }
    let args;
    try { args = resolveRefs(step.args, completedById); }
    catch (err) {
      step.state = 'BLOCKED'; step.error = { code: err.message.split(':')[0] }; mission.state = 'waiting_input';
      mission.question = 'Je n’ai pas retrouvé une donnée réelle nécessaire à « ' + step.label + ' ». Quelle valeur dois-je utiliser ?';
      await event(mission, 'information manquante', 'warning', mission.question, deps); return mission;
    }
    const missing = missingFields(tool, args);
    if (missing.length) {
      mission.state = 'waiting_input'; mission.question = 'Il me manque ' + missing.join(', ') + ' pour ' + step.label + '.';
      await event(mission, 'information requise', 'warning', mission.question, deps); return mission;
    }
    step.state = 'RUNNING'; step.executedArgs = args; mission.state = 'running';
    await event(mission, 'étape démarrée', 'pending', step.label, deps);
    let call;
    try { call = await registry().execute(mission.tenant, step.tool, args, ctx); }
    catch (err) { call = { state: 'FAILED', error: { code: 'EXECUTION_ERROR', message: String(err.message || err) } }; }
    step.state = call.state; step.result = call.result || null; step.error = call.error || null;
    step.verification = call.verification || null; step.finishedAt = Date.now();
    if (call.state === 'SUCCESS') {
      completedById[step.id] = step;
      await event(mission, 'étape vérifiée', 'ok', step.label + ' — ' + summarizeResult(call.result), deps);
      continue;
    }
    mission.state = call.state === 'NEEDS_CONFIRMATION' ? 'needs_confirmation' : (call.state === 'UNCONFIRMED' ? 'needs_review' : 'failed');
    mission.question = call.state === 'NEEDS_CONFIRMATION' ? 'L’action « ' + step.label + ' » attend une confirmation explicite.' : null;
    await event(mission, 'étape ' + String(call.state || 'FAILED').toLowerCase(), call.state === 'NEEDS_CONFIRMATION' || call.state === 'UNCONFIRMED' ? 'warning' : 'error', step.label + (call.error && call.error.code ? ' — ' + call.error.code : ''), deps);
    return mission;
  }
  if (mission.state === 'paused' || mission.state === 'stopped' || mission.state === 'needs_review') return mission;
  const launched = missionCampaigns(mission);
  if (!launched.length && objectiveRequiresExternalAction(mission.objective) && !hasVerifiedExternalAction(mission, ctx)) {
    if ((mission.replanCount || 0) < 1) {
      mission.replanCount = (mission.replanCount || 0) + 1;
      await event(mission, 'les lectures sont prêtes — décision d’action', 'pending', 'L’IA reprend les résultats réels une seule fois pour déterminer les prochaines étapes.', deps);
      let plan;
      try {
        plan = await makePlan(mission, deps, mission.steps.map((s) => ({ id: s.id, tool: s.tool, args: s.args, state: s.state, result: s.result, error: s.error })));
      } catch (err) {
        mission.state = 'failed'; mission.error = String(err.message || err);
        await event(mission, 'replanification échouée', 'error', mission.error, deps); return mission;
      }
      if (plan.needsInput) {
        mission.state = 'waiting_input'; mission.question = plan.question;
        await event(mission, 'information nécessaire après analyse', 'warning', plan.question, deps); return mission;
      }
      const successful = mission.steps.filter((s) => s.state === 'SUCCESS');
      const next = plan.steps.filter((s) => !successful.some((done) => done.tool === s.tool && JSON.stringify(done.args) === JSON.stringify(s.args)));
      if (next.length) {
        const used = new Set(successful.map((s) => s.id));
        for (const step of next) if (used.has(step.id)) step.id += '_next';
        mission.steps = successful.concat(next);
        mission.state = 'running'; await saveMission(mission.tenant, mission);
        return executePlan(mission, deps);
      }
    }
    mission.state = 'waiting_input';
    mission.question = 'J’ai consulté les données disponibles, mais aucun tool n’a fourni les éléments nécessaires pour lancer l’action demandée. Indique la cible ou la source de contacts à utiliser.';
    await event(mission, 'action non déterminée — précision requise', 'warning', mission.question, deps);
    return mission;
  }
  mission.state = launched.length ? 'monitoring' : (mission.steps.every((s) => s.state === 'SUCCESS') ? 'completed' : 'failed');
  await event(mission, mission.state === 'monitoring' ? 'campagne(s) lancée(s) — suivi réel en cours' : (mission.state === 'completed' ? 'plan exécuté et vérifié' : 'mission incomplète'), mission.state === 'failed' ? 'error' : 'ok', mission.steps.filter((s) => s.state === 'SUCCESS').length + '/' + mission.steps.length + ' étapes vérifiées', deps);
  if (mission.state === 'monitoring') scheduleMonitor(mission, deps);
  return mission;
}

async function start({ text, tenantId, sessionId, channel }, deps) {
  const principal = authz.currentPrincipal();
  if (!authz.isPrincipal(principal) || principal.tenant !== String(tenantId) || !['OWNER', 'ADMIN'].includes(principal.role)) return { text: 'La mission ne peut pas démarrer sans une identité propriétaire vérifiée.', blocked: true };
  const mission = { id: uid(), tenant: safeTenant(tenantId), sessionId: String(sessionId || ''),
    channel: String(channel || principal.channel || 'CHAT').toUpperCase(), objective: String(text || '').slice(0, 4000),
    state: 'planning', question: null, steps: [], createdAt: Date.now(), updatedAt: Date.now() };
  await event(mission, 'mission créée', 'pending', mission.objective.slice(0, 250), deps);
  let plan;
  try { plan = await makePlan(mission, deps); }
  catch (err) {
    mission.state = 'failed'; mission.error = String(err.message || err).slice(0, 300);
    await event(mission, 'planification échouée', 'error', mission.error, deps);
    return { text: 'Je n’ai pas pu établir un plan d’actions vérifiable (' + mission.error + ').', missionId: mission.id, stopReason: 'PLAN_FAILED' };
  }
  if (plan.needsInput) {
    mission.state = 'waiting_input'; mission.question = plan.question;
    await event(mission, 'information nécessaire', 'warning', plan.question, deps);
    return { text: plan.question + '\nMission ' + mission.id + ' enregistrée : répondez ici pour reprendre.', missionId: mission.id, state: mission.state, isPlanningQuestion: true, intent: 'goal' };
  }
  mission.steps = plan.steps;
  await saveMission(mission.tenant, mission);
  await executePlan(mission, deps);
  return render(mission);
}

async function resume({ tenantId, id, answer }, deps) {
  const mission = await get(tenantId, id);
  if (!mission) return { text: 'Mission introuvable pour ce compte.' };
  if (mission.state === 'needs_confirmation' && answer) {
    if (authz.isPrincipal(authz.currentPrincipal()) && require('./personaManager').detectDecline(answer)) {
      mission.state = 'stopped';
      await event(mission, 'action en attente annulée', 'warning', '', deps);
      return render(mission);
    }
    if (!require('./personaManager').detectAffirmative(answer)) return { text: 'Répondez oui pour exécuter l’action préparée, ou non pour l’annuler.', missionId: id, state: mission.state };
    if (mission.pendingControl) {
      const p = mission.pendingControl;
      const principal = authz.currentPrincipal();
      const ctx = Object.assign({}, deps.toolContext || {}, { tenant: mission.tenant, principal,
        runtime: deps.runtime || null, permissions: deps.permissions || ['messages:send'], confirmed: true });
      const controlCall = await registry().execute(mission.tenant, p.tool, p.args, ctx);
      if (controlCall.state !== 'SUCCESS') {
        mission.state = controlCall.state === 'UNCONFIRMED' ? 'needs_review' : 'failed';
        await event(mission, 'contrôle confirmé mais non vérifié', 'warning', p.tool, deps);
        return render(mission);
      }
      const statusCall = await registry().execute(mission.tenant, 'getCampaignStatus', p.args, ctx);
      const actual = statusCall.state === 'SUCCESS' ? String((statusCall.result && (statusCall.result.status || statusCall.result.engineStatus || statusCall.result.state)) || '') : '';
      const confirmedStatus = p.action === 'stop' ? campaignIsTerminal(actual) : p.action === 'pause' ? /paused/i.test(actual) : /running/i.test(actual);
      if (!confirmedStatus) {
        mission.state = 'needs_review';
        await event(mission, 'contrôle accepté mais statut non confirmé', 'warning', actual || 'statut indisponible', deps);
        return render(mission);
      }
      mission.pendingControl = null;
      mission.state = p.action === 'stop' ? 'stopped' : p.action === 'pause' ? 'paused' : 'monitoring';
      await event(mission, 'contrôle confirmé et vérifié', 'ok', p.action, deps);
      if (mission.state === 'monitoring') scheduleMonitor(mission, deps);
      return render(mission);
    }
    const step = mission.steps.find((s) => s.state === 'NEEDS_CONFIRMATION');
    if (!step) return { text: 'Aucune action préparée à confirmer.', missionId: id, state: mission.state };
    const principal = authz.currentPrincipal();
    const ctx = Object.assign({}, deps.toolContext || {}, { tenant: mission.tenant, principal,
      runtime: deps.runtime || null, permissions: deps.permissions || ['messages:send'],
      generateImage: deps.generateImage || null, autonomous: true, confirmed: true });
    const call = await registry().execute(mission.tenant, step.tool, step.executedArgs || step.args, ctx);
    step.state = call.state; step.result = call.result || null; step.error = call.error || null;
    step.verification = call.verification || null; step.finishedAt = Date.now();
    if (call.state !== 'SUCCESS') {
      mission.state = call.state === 'UNCONFIRMED' ? 'needs_review' : 'failed';
      await event(mission, 'action confirmée mais non vérifiée', 'warning', step.label, deps);
      return render(mission);
    }
    mission.state = 'running';
    await event(mission, 'action confirmée et vérifiée', 'ok', step.label, deps);
    await executePlan(mission, deps);
    return render(mission);
  }
  if (mission.state === 'waiting_input' && answer) {
    mission.objective += '\nPrécision utilisateur : ' + String(answer).slice(0, 1500);
    mission.state = 'planning'; mission.question = null;
    await event(mission, 'information reçue — reprise de planification', 'pending', String(answer).slice(0, 200), deps);
    let plan;
    try {
      plan = await makePlan(mission, deps, mission.steps.map((s) => ({ id: s.id, tool: s.tool, args: s.args, state: s.state, result: s.result, error: s.error })));
    } catch (err) {
      mission.state = 'failed'; mission.error = String(err.message || err);
      await event(mission, 'replanification échouée', 'error', mission.error, deps); return render(mission);
    }
    if (plan.needsInput) {
      mission.state = 'waiting_input'; mission.question = plan.question;
      await event(mission, 'information nécessaire', 'warning', plan.question, deps); return render(mission);
    }
    const successful = mission.steps.filter((s) => s.state === 'SUCCESS');
    mission.steps = successful.concat(plan.steps.filter((s) => !successful.some((done) => done.tool === s.tool && JSON.stringify(done.args) === JSON.stringify(s.args))));
    mission.state = 'running'; await saveMission(mission.tenant, mission);
    await executePlan(mission, deps); return render(mission);
  }
  if (mission.state === 'needs_review') return { text: 'La mission ' + mission.id + ' contient une étape interrompue dont l’effet doit être vérifié avant toute reprise.', missionId: id, state: mission.state };
  if (mission.state !== 'paused') return render(mission);
  mission.state = 'running'; await event(mission, 'mission reprise', 'pending', '', deps);
  await executePlan(mission, deps); return render(mission);
}

async function control({ tenantId, id, action }, deps) {
  const mission = await get(tenantId, id);
  if (!mission) return null;
  const canPause = ['running', 'monitoring'].includes(mission.state);
  const canResume = ['paused', 'monitoring'].includes(mission.state);
  const canStop = !['completed', 'failed', 'stopped', 'awaiting_outcome'].includes(mission.state);
  if ((action === 'pause' && !canPause) || (action === 'resume' && !canResume) || (action === 'stop' && !canStop)) {
    return { text: 'Action ' + action + ' impossible pour une mission ' + mission.state + '.', missionId: id, state: mission.state };
  }
  const campaigns = missionCampaigns(mission);
  if (campaigns.length && ['pause', 'resume', 'stop'].includes(action)) {
    const toolName = action === 'pause' ? 'pauseCampaign' : action === 'resume' ? 'resumeCampaign' : 'cancelCampaign';
    const principal = authz.currentPrincipal();
    const ctx = Object.assign({}, deps.toolContext || {}, { tenant: mission.tenant, principal,
      runtime: deps.runtime || null, permissions: deps.permissions || ['messages:send'] });
    for (const campaign of campaigns) {
      const call = await registry().execute(tenantId, toolName, campaign, ctx);
      if (call.state !== 'SUCCESS') {
        if (call.state === 'NEEDS_CONFIRMATION') {
          mission.pendingControl = { tool: toolName, args: campaign, action };
          mission.state = 'needs_confirmation'; mission.question = 'Le contrôle de la campagne ' + campaign.campaignId + ' attend une confirmation.';
          await event(mission, 'contrôle de campagne en attente de confirmation', 'warning', action + ' ' + campaign.campaignId, deps);
          return render(mission);
        }
        return { text: 'Je n’ai pas pu ' + action + ' la campagne ' + campaign.campaignId + ' (' + call.state + ').', missionId: id, state: mission.state };
      }
      const verified = await registry().execute(tenantId, 'getCampaignStatus', campaign, ctx);
      const actual = verified.state === 'SUCCESS' ? String((verified.result && (verified.result.status || verified.result.engineStatus || verified.result.state)) || '') : '';
      const matches = action === 'pause' ? /paused/i.test(actual) : action === 'resume' ? /running/i.test(actual) : campaignIsTerminal(actual);
      if (!matches) return { text: 'Le moteur a accepté la demande, mais je ne peux pas confirmer que la campagne est ' + (action === 'stop' ? 'arrêtée' : action === 'pause' ? 'en pause' : 'repartie') + ' (statut réel : ' + (actual || 'indisponible') + ').', missionId: id, state: mission.state };
    }
  }
  if (action === 'pause' && ['running', 'monitoring'].includes(mission.state)) {
    mission.state = 'paused'; const timer = monitorTimers.get(id); if (timer) clearTimeout(timer); monitorTimers.delete(id);
  }
  else if (action === 'stop' && !['completed', 'failed', 'stopped'].includes(mission.state)) {
    mission.state = 'stopped'; const timer = monitorTimers.get(id); if (timer) clearTimeout(timer); monitorTimers.delete(id);
  }
  else if (action === 'resume' && ['paused', 'monitoring'].includes(mission.state)) mission.state = campaigns.length ? 'monitoring' : 'running';
  else return { text: 'Action ' + action + ' impossible pour une mission ' + mission.state + '.', missionId: id, state: mission.state };
  await event(mission, 'mission ' + (mission.state === 'paused' ? 'en pause' : mission.state === 'stopped' ? 'arrêtée' : 'reprise'), mission.state === 'stopped' ? 'warning' : 'pending', '', deps);
  if (action === 'resume') { if (campaigns.length) scheduleMonitor(mission, deps); else await executePlan(mission, deps); }
  return render(mission);
}

function render(mission) {
  const done = mission.steps.filter((s) => s.state === 'SUCCESS').length;
  const failed = mission.steps.filter((s) => !['SUCCESS', 'PENDING'].includes(s.state));
  let text;
  if (mission.state === 'completed') text = 'Mission ' + mission.id + ' terminée : ' + done + '/' + mission.steps.length + ' étapes exécutées et vérifiées.';
  else if (mission.state === 'waiting_input') text = mission.question + '\nMission ' + mission.id + ' en attente de votre réponse.';
  else if (mission.state === 'needs_confirmation') text = 'Mission ' + mission.id + ' en pause : une action attend votre confirmation explicite.';
  else if (mission.state === 'needs_review') text = 'Mission ' + mission.id + ' arrêtée pour contrôle : une étape n’a pas pu être confirmée après interruption.';
  else if (mission.state === 'monitoring') text = 'Mission ' + mission.id + ' — campagnes en cours, suivi réel : ' + (mission.progress || []).map((p) => p.channel + ' ' + p.sent + '/' + p.total + ' (' + p.status + ')').join('; ');
  else if (mission.state === 'awaiting_outcome') text = 'Mission ' + mission.id + ' : les envois sont terminés et mesurés. ' + (mission.outcomeNote || 'Les conversions demandent une preuve commerciale disponible.');
  else if (mission.state === 'paused') text = 'Mission ' + mission.id + ' mise en pause après ' + done + '/' + mission.steps.length + ' étapes vérifiées.';
  else if (mission.state === 'stopped') text = 'Mission ' + mission.id + ' arrêtée après ' + done + '/' + mission.steps.length + ' étapes vérifiées.';
  else if (mission.state === 'failed') text = 'Mission ' + mission.id + ' incomplète : ' + done + '/' + mission.steps.length + ' étapes vérifiées' + (failed[0] && failed[0].error ? ', erreur ' + (failed[0].error.code || failed[0].error.message || 'inconnue') : '') + '.';
  else text = 'Mission ' + mission.id + ' en cours : ' + done + '/' + mission.steps.length + ' étapes vérifiées.';
  return { text, missionId: mission.id, state: mission.state,
    progress: mission.progress || [], outcomeNote: mission.outcomeNote || null,
    steps: mission.steps.map((s) => ({ id: s.id, tool: s.tool, label: s.label, state: s.state })),
    actionLog: mission.steps.map((s) => ({ icon: s.state === 'SUCCESS' ? '✅' : s.state === 'FAILED' || s.state === 'BLOCKED' ? '⚠️' : '⏳', label: s.label + ' — ' + s.state, status: s.state === 'SUCCESS' ? 'done' : s.state === 'FAILED' || s.state === 'BLOCKED' ? 'error' : 'pending' })) };
}

module.exports = { start, resume, control, get, list, render, monitorMission, recoverMonitoring, NS };
