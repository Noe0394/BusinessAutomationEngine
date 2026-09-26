'use strict';

// Orchestration par objectif : l'IA planifie, le registre exécute les outils,
// les moteurs existants réalisent les opérations et le journal persiste les résultats.
const crypto = require('crypto');
const storage = require('./storageAdapter');
const authz = require('./authz');
const activityStore = require('./activityStore');
const businessServices = require('./businessServices');
const verbatimPayload = require('./verbatimPayload');
const registry = () => require('./toolRegistry');

const NS = 'objective_missions';
const monitorTimers = new Map();
const activeMissionIds = new Set();
const uid = () => 'mis_' + Date.now().toString(36) + '_' + crypto.randomBytes(4).toString('hex');
const safeTenant = (v) => String(v || '').trim().replace(/[^A-Za-z0-9_.-]/g, '_') || 'default';

function publicStatus(state) {
  return ({ planning: 'QUEUED', running: 'RUNNING', monitoring: 'VERIFYING', awaiting_outcome: 'WAITING_EXTERNAL',
    waiting_input: 'WAITING_EXTERNAL', needs_confirmation: 'WAITING_EXTERNAL', paused: 'PAUSED', stopped: 'CANCELLED',
    completed: 'COMPLETED', failed: 'FAILED', needs_review: 'VERIFYING' })[String(state || '')] || 'QUEUED';
}
function stampMission(mission) {
  mission.taskId = mission.taskId || mission.id;
  mission.ownerConversationId = mission.ownerConversationId || mission.sessionId || null;
  mission.startedAt = mission.startedAt || mission.createdAt || Date.now();
  mission.status = publicStatus(mission.state);
  const total = Array.isArray(mission.steps) ? mission.steps.length : 0;
  const done = total ? mission.steps.filter((step) => step.state === 'SUCCESS').length : 0;
  mission.progressPercent = total ? Math.round((done / total) * 100) : 0;
  if (mission.state === 'completed' && mission.result == null) mission.result = { verifiedSteps: done, totalSteps: total };
  return mission;
}

async function readDoc(tenant) {
  return storage.get(NS, safeTenant(tenant), { tenant: safeTenant(tenant), missions: {} });
}
async function saveMission(tenant, mission) {
  stampMission(mission);
  const doc = await readDoc(tenant);
  doc.missions[mission.id] = mission;
  await storage.setDurable(NS, safeTenant(tenant), doc);
  return mission;
}
async function get(tenant, id) {
  const doc = await readDoc(tenant);
  return doc.missions[String(id || '')] || null;
}
async function list(tenant, limit) {
  const doc = await readDoc(tenant);
  const ordered = Object.values(doc.missions).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
  const requested = Number(limit);
  return Number.isFinite(requested) && requested > 0 ? ordered.slice(0, Math.floor(requested)) : ordered;
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
async function availableTools(ctx, query) {
  if (query) return registry().discover(query, ctx, { limit: Number.MAX_SAFE_INTEGER });
  return registry().listForContext(ctx);
}
function plannerPrompt({ objective, tools, completed, previousPlan, businessContext, conversationContext }) {
  return [
    'Tu es le planificateur d’objectifs de Cyrus. Tu comprends et choisis; les outils et moteurs exécutent. Réponds en JSON strict uniquement.',
    'Construis le prochain lot d’étapes nécessaire, de taille adaptée au contexte. L’orchestrateur te redemandera la suite après vérification des résultats : il n’existe pas de limite au nombre total d’étapes. Utilise uniquement les noms exacts ci-dessous. Fais les lectures nécessaires avant les actions. N’invente ni groupe, ni contact, ni prix, ni identifiant, ni réussite.',
    'Les opérations déterministes restent dans les outils. N’ajoute pas de comptage/normalisation si un outil de préparation le fait déjà. Utilise {"$ref":"ID.result.champ"} dans les arguments pour reprendre la sortie réelle d’une étape précédente.',
    'Quand le vendeur fournit un message « exactement », « mot pour mot » ou « tel quel », copie son contenu à l’identique dans le champ text des outils d’envoi/brouillon. Ne paraphrase, ne corrige et ne tronque jamais ce contenu.',
    'Si une information réellement indispensable manque et n’existe pas dans les résultats, renvoie {"needsInput":true,"question":"...","steps":[]} et ne planifie aucune action externe. Si l’objectif est réellement accompli selon les étapes déjà vérifiées, renvoie {"complete":true,"steps":[]}. Sinon renvoie {"complete":false,"steps":[{"id":"nouvel_id_unique","tool":"nomExact","args":{},"label":"description courte"}]}. Les identifiants d’étape doivent rester uniques dans toute la mission.',
    'Pour un objectif de vente, recherche l’offre et les cibles avant de préparer le message. Si le texte, le prix ou un canal indispensable manque des données disponibles, demande uniquement cette information. Ne prétends pas confirmer des conversions sans source de conversion.',
    businessContext ? 'Contexte des Services métier réellement configurés :\n' + businessContext.slice(0, 12000) : 'Aucun contexte Service métier configuré n’est disponible.',
    conversationContext && conversationContext.length
      ? 'Contexte conversationnel utile (les réponses courtes peuvent préciser l’objectif précédent) :\n' + conversationContext.slice(-12).map((m) => `${m.who}: ${String(m.text || '').slice(0, 500)}`).join('\n')
      : '',
    'Objectif utilisateur : ' + JSON.stringify(objective).slice(0, 3000),
    previousPlan && previousPlan.length ? 'Étapes tentées auparavant, y compris échecs/non-confirmations (ne jamais répéter une action identique) : ' + compact(previousPlan, 12000) : '',
    completed.length ? 'Étapes déjà réellement vérifiées (ne pas répéter). Pour les sorties, référence un champ réel avec $ref au lieu de recopier de grandes listes : ' + compact(completed, 18000) : '',
    'Outils réellement autorisés :\n' + tools.map((t) => t.name + ' [' + t.risk + '] ' + t.description + ' paramètres=' + compact(t.inputSchema, 500)).join('\n'),
  ].filter(Boolean).join('\n\n');
}

async function makePlan(mission, deps, priorPlan) {
  const principal = authz.currentPrincipal();
  if (!authz.isPrincipal(principal) || principal.tenant !== mission.tenant || !['OWNER', 'ADMIN'].includes(principal.role)) throw new Error('MISSION_PRINCIPAL_INVALID');
  const ctx = Object.assign({}, deps.toolContext || {}, { tenant: mission.tenant, principal,
    runtime: deps.runtime || null, permissions: deps.permissions || ['messages:send'],
    generateImage: deps.generateImage || null, autonomous: true });
  const priorNames = mission.steps.filter((s) => s.state === 'SUCCESS').slice(-12).map((s) => s.tool).join(' ');
  let businessContext = '';
  try { businessContext = await businessServices.getEngineContextText(mission.tenant); } catch (e) { businessContext = ''; }
  // Include real catalog/context terms in discovery. Otherwise a clarification
  // such as "WhatsApp" can narrow the registry so much that the next planner
  // turn cannot select a tool already justified by the account's business data.
  const tools = await availableTools(ctx, [mission.objective, priorNames, businessContext].filter(Boolean).join('\n'));
  const prompt = plannerPrompt({ objective: mission.objective, tools, completed: mission.steps.filter((s) => s.state === 'SUCCESS'), previousPlan: priorPlan, businessContext,
    conversationContext: mission.context && mission.context.lastRelevantMessages });
  const llm = deps.planLlm || deps.llm;
  let raw;
  if (typeof llm === 'function') raw = await llm(prompt, []);
  else {
    const engine = require('../lib/ai/llmFallbackEngine');
    const r = await engine.generateAIResponse(prompt, [], null, undefined, null, { purpose: 'objective_plan', tier: 'reasoning', maxTokens: 6000, tenant: mission.tenant });
    raw = r && r.text;
  }
  const plan = parseJson(raw);
  if (!plan || (!Array.isArray(plan.steps) && plan.needsInput !== true)) throw new Error('INVALID_OBJECTIVE_PLAN');
  if (plan.needsInput) return { needsInput: true, question: String(plan.question || 'Quelle information indispensable dois-je utiliser ?').slice(0, 500), steps: [] };
  if (plan.complete === true && plan.steps.length === 0) return { needsInput: false, complete: true, steps: [] };
  if (!plan.steps.length) return { needsInput: false, complete: false, steps: [] };
  const allowed = new Set(tools.map((t) => t.name));
  const normalized = plan.steps.map((s, i) => {
    if (!s || !allowed.has(s.tool) || !s.args || typeof s.args !== 'object' || Array.isArray(s.args)) throw new Error('OBJECTIVE_PLAN_INVALID_TOOL');
    return { id: /^[A-Za-z0-9_-]{1,40}$/.test(String(s.id || '')) ? String(s.id) : 's' + (i + 1),
      tool: s.tool, args: s.args, label: String(s.label || s.tool).slice(0, 160),
      state: 'PENDING', result: null, error: null };
  });
  const ids = new Set();
  for (const s of normalized) { if (ids.has(s.id)) throw new Error('OBJECTIVE_PLAN_DUPLICATE_ID'); ids.add(s.id); }
  return { needsInput: false, complete: false, steps: normalized };
}

async function event(mission, type, status, detail, deps) {
  mission.updatedAt = Date.now();
  stampMission(mission);
  await saveMission(mission.tenant, mission);
  await activityStore.record({ type: 'objective_mission', action: type, status, tenant: mission.tenant, target: mission.id, detail: detail || mission.objective.slice(0, 250) });
  const milestone = /mission créée|campagne\(s\) lancée|progression réelle mise à jour|campagnes terminées/i.test(String(type || ''));
  const recent = Date.now() - Number(mission.lastNotificationAt || 0) < 30000;
  const notify = status !== 'pending' || milestone;
  if (notify && !(status === 'pending' && recent) && deps && typeof deps.notifyMission === 'function') {
    const message = 'Mission ' + mission.id + ' — ' + type + '\nObjectif : ' + mission.objective.slice(0, 300) + (detail ? '\n' + detail : '');
    try {
      const delivered = await deps.notifyMission({ tenantId: mission.tenant, missionId: mission.id, text: message, status });
      if (Array.isArray(delivered) ? delivered.length > 0 : delivered !== false) {
        mission.lastNotificationAt = Date.now();
        mission.updatedAt = Date.now();
        await saveMission(mission.tenant, mission);
      }
    } catch (_) { /* les notifications ne doivent pas arrêter une mission */ }
  }
}
function missingFields(tool, args) {
  return Object.entries(tool.inputSchema || {}).filter(([key, spec]) => spec.required && (args[key] == null || args[key] === '')).map(([key, spec]) => key + (spec.description ? ' (' + spec.description + ')' : ''));
}

function ensureUniqueStepIds(steps, existingSteps) {
  const used = new Set((existingSteps || []).map((step) => step.id));
  const remap = new Map();
  for (const [index, step] of (steps || []).entries()) {
    if (used.has(step.id)) {
      const old = step.id;
      step.id = 'step_' + (used.size + index + 1) + '_' + old;
      remap.set(old, step.id);
    }
    used.add(step.id);
  }
  const replaceRefs = (value) => {
    if (Array.isArray(value)) return value.map(replaceRefs);
    if (!value || typeof value !== 'object') return value;
    if (typeof value.$ref === 'string') {
      const parts = value.$ref.split('.');
      if (remap.has(parts[0])) parts[0] = remap.get(parts[0]);
      return Object.assign({}, value, { $ref: parts.join('.') });
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceRefs(item)]));
  };
  for (const step of steps || []) step.args = replaceRefs(step.args);
  return steps || [];
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
  return /vend|prospect|campagn|promot|diffus|envoi|envoy|lanc|ajout|inscri|convert|cr[eé]|configur|activ|d[eé]sactiv|supprim|programm|planifi|pause|reprend|modifi|publ|poste|connect/i.test(String(text || ''));
}
async function hasVerifiedExternalAction(mission, ctx) {
  const risks = new Map((await availableTools(ctx)).map((t) => [t.name, t.risk]));
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

async function askForMissionInput(mission, question, deps, eventName) {
  mission.state = 'waiting_input';
  mission.question = String(question || 'Quelle information indispensable dois-je utiliser ?').slice(0, 500);
  if (mission.context) mission.context.pendingTask = { missionId: mission.id, state: 'waiting_input', question: mission.question };
  await event(mission, eventName || 'information nécessaire', 'warning', mission.question, deps);
  return mission;
}

async function finalizeMission(mission, deps, ctx) {
  const launched = missionCampaigns(mission);
  if (launched.length) {
    mission.state = 'monitoring';
    mission.question = null;
    if (mission.context) mission.context.pendingTask = { missionId: mission.id, state: 'monitoring' };
    await event(mission, 'campagne(s) lancée(s) — suivi réel en cours', 'pending', launched.length + ' campagne(s) suivie(s) jusqu’à un état terminal.', deps);
    scheduleMonitor(mission, deps);
    return mission;
  }
  if (objectiveRequiresExternalAction(mission.objective) && !(await hasVerifiedExternalAction(mission, ctx))) {
    return askForMissionInput(mission,
      'Les étapes vérifiées ne confirment pas encore l’action demandée. Quelle cible ou quelle ressource dois-je utiliser pour continuer ?',
      deps, 'action non vérifiée — précision requise');
  }
  mission.state = 'completed';
  mission.result = { verifiedSteps: mission.steps.filter((s) => s.state === 'SUCCESS').length, totalSteps: mission.steps.length };
  mission.question = null;
  if (mission.context) {
    mission.context.pendingTask = { missionId: mission.id, state: 'completed' };
    mission.context.pendingAction = null;
  }
  await event(mission, 'plan exécuté et vérifié', 'ok', mission.result.verifiedSteps + '/' + mission.result.totalSteps + ' étapes vérifiées', deps);
  return mission;
}

async function recoverPending(tenantId, id, deps) {
  const key = String(id || '');
  if (activeMissionIds.has(key)) return get(tenantId, key);
  const mission = await get(tenantId, key);
  if (!mission || !['planning', 'running'].includes(mission.state)) return mission;
  activeMissionIds.add(key);
  try {
    if (mission.state === 'planning' && (!Array.isArray(mission.steps) || mission.steps.length === 0)) {
      let plan;
      try { plan = await makePlan(mission, deps); }
      catch (err) {
        mission.state = 'failed'; mission.error = String(err.message || err).slice(0, 300);
        await event(mission, 'reprise de planification échouée', 'error', mission.error, deps);
        return mission;
      }
      if (plan.needsInput) {
        mission.state = 'waiting_input'; mission.question = plan.question;
        await event(mission, 'information nécessaire après redémarrage', 'warning', plan.question, deps);
        return mission;
      }
      if (plan.complete && !plan.steps.length) return finalizeMission(mission, deps, Object.assign({}, deps.toolContext || {}, { tenant: mission.tenant, principal: authz.currentPrincipal(), runtime: deps.runtime || null, permissions: deps.permissions || ['messages:send'] }));
      if (!plan.steps.length) return askForMissionInput(mission, 'Je n’ai pas identifié d’étape exécutable avec les outils disponibles. Quelle information ou ressource dois-je utiliser ?', deps, 'reprise sans étape exécutable');
      const done = mission.steps.filter((step) => step.state === 'SUCCESS');
      mission.steps = done.concat(plan.steps);
    }
    const interrupted = (mission.steps || []).find((step) => step.state === 'RUNNING');
    if (interrupted) {
      interrupted.state = 'UNCONFIRMED';
      interrupted.error = { code: 'INTERRUPTED_DURING_EXECUTION' };
      mission.state = 'needs_review';
      mission.currentStep = interrupted.id;
      mission.error = { code: 'INTERRUPTED_DURING_EXECUTION', stepId: interrupted.id };
      await event(mission, 'étape interrompue — vérification requise', 'warning', interrupted.label || interrupted.tool, deps);
      return mission;
    }
    mission.state = 'running';
    mission.error = null;
    await saveMission(mission.tenant, mission);
    await executePlan(mission, deps);
    return mission;
  } finally { activeMissionIds.delete(key); }
}

async function executePlan(mission, deps) {
  const principal = authz.currentPrincipal();
  const ctx = Object.assign({}, deps.toolContext || {}, { tenant: mission.tenant, principal,
    runtime: deps.runtime || null, permissions: deps.permissions || ['messages:send'],
    generateImage: deps.generateImage || null, autonomous: true });
  const tools = new Map((await availableTools(ctx)).map((t) => [t.name, t]));
  while (mission.state === 'running') {
    const completedById = Object.fromEntries(mission.steps.filter((s) => s.state === 'SUCCESS').map((s) => [s.id, s]));
    const pendingSteps = mission.steps.filter((s) => s.state !== 'SUCCESS');
    for (const step of pendingSteps) {
      if (mission.state === 'paused' || mission.state === 'stopped') break;
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
      try { args = resolveRefs(step.args, completedById); args = verbatimPayload.applyVerbatimText(step.tool, args, mission.objective); }
      catch (err) {
        step.state = 'BLOCKED'; step.error = { code: err.message.split(':')[0] };
        return askForMissionInput(mission, 'Je n’ai pas retrouvé une donnée réelle nécessaire à « ' + step.label + ' ». Quelle valeur dois-je utiliser ?', deps, 'information manquante');
      }
      const missing = missingFields(tool, args);
      if (missing.length) return askForMissionInput(mission, 'Il me manque ' + missing.join(', ') + ' pour ' + step.label + '.', deps, 'information requise');
      step.state = 'RUNNING'; step.executedArgs = args; mission.state = 'running'; mission.currentStep = step.id; mission.nextStep = step.id;
      await event(mission, 'étape démarrée', 'pending', step.label, deps);
      let call;
      try { call = await registry().execute(mission.tenant, step.tool, args, ctx); }
      catch (err) { call = { state: 'FAILED', error: { code: 'EXECUTION_ERROR', message: String(err.message || err) } }; }
      step.state = call.state; step.result = call.result || null; step.error = call.error || null;
      step.verification = call.verification || null; step.finishedAt = Date.now();
      mission.lastResult = { stepId: step.id, tool: step.tool, state: call.state, result: call.result || null, error: call.error || null, verification: call.verification || null, at: step.finishedAt };
      if (mission.context) mission.context.lastToolResult = mission.lastResult;
      mission.currentStep = null;
      if (call.state === 'SUCCESS') {
        completedById[step.id] = step;
        const nextIndex = mission.steps.indexOf(step) + 1;
        mission.nextStep = mission.steps[nextIndex] ? mission.steps[nextIndex].id : null;
        await event(mission, 'étape vérifiée', 'ok', step.label + ' — ' + summarizeResult(call.result), deps);
        continue;
      }
      const missingInput = call.state === 'FAILED' && call.error && call.error.code === 'MISSING_INPUT';
      if (missingInput) step.state = 'BLOCKED';
      mission.state = call.state === 'NEEDS_CONFIRMATION' ? 'needs_confirmation'
        : (call.state === 'UNCONFIRMED' ? 'needs_review' : (missingInput ? 'waiting_input' : 'failed'));
      if (missingInput) {
        const fields = Array.isArray(call.error.fields) ? call.error.fields.join(', ') : 'une information obligatoire';
        mission.question = 'Il me manque ' + fields + ' pour ' + step.label + '. Rien n’a été exécuté.';
      }
      if (mission.context) mission.context.pendingTask = { missionId: mission.id, state: mission.state, currentStep: step.id };
      if (call.state === 'NEEDS_CONFIRMATION') {
        mission.pendingActionId = mission.pendingActionId || 'ACT-' + crypto.randomBytes(6).toString('hex').toUpperCase();
        mission.confirmationExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
        if (mission.context) mission.context.pendingAction = { pendingActionId: mission.pendingActionId, missionId: mission.id, stepId: step.id, tool: step.tool, args: args };
      }
      mission.question = call.state === 'NEEDS_CONFIRMATION' ? 'L’action « ' + step.label + ' » attend une confirmation explicite.' : mission.question;
      await event(mission, missingInput ? 'information nécessaire' : ('étape ' + String(call.state || 'FAILED').toLowerCase()), missingInput || call.state === 'NEEDS_CONFIRMATION' || call.state === 'UNCONFIRMED' ? 'warning' : 'error', mission.question || (step.label + (call.error && call.error.code ? ' — ' + call.error.code : '')), deps);
      return mission;
    }
    if (mission.state === 'paused' || mission.state === 'stopped' || mission.state === 'needs_review') return mission;

    // Chaque lot est suivi d'une nouvelle décision du modèle sur les résultats
    // vérifiés. Cette boucle n'a pas de plafond de nombre d'appels d'outils.
    let plan;
    try {
      mission.replanCount = (mission.replanCount || 0) + 1;
      await event(mission, 'analyse des résultats — prochaine étape', 'pending', 'L’IA décide à partir des sorties vérifiées du registre.', deps);
      plan = await makePlan(mission, deps, mission.steps.map((s) => ({ id: s.id, tool: s.tool, args: s.args, state: s.state, result: s.result, error: s.error, verification: s.verification })));
    } catch (err) {
      mission.state = 'failed'; mission.error = String(err.message || err).slice(0, 300);
      await event(mission, 'replanification échouée', 'error', mission.error, deps); return mission;
    }
    if (plan.needsInput) return askForMissionInput(mission, plan.question, deps, 'information nécessaire après analyse');
    if (plan.complete && !plan.steps.length) return finalizeMission(mission, deps, ctx);

    const next = plan.steps.filter((candidate) => !mission.steps.some((done) => done.tool === candidate.tool
      && JSON.stringify(done.args) === JSON.stringify(candidate.args)));
    if (!next.length) {
      return askForMissionInput(mission, 'Je n’ai pas identifié d’étape suivante vérifiable à partir des résultats. Quelle cible ou information dois-je préciser ?', deps, 'aucune étape suivante vérifiable');
    }
    ensureUniqueStepIds(next, mission.steps);
    for (const step of next) step.state = 'PENDING';
    mission.steps.push(...next);
    mission.state = 'running';
    mission.nextStep = next[0].id;
    await event(mission, 'suite du plan enregistrée', 'pending', next.length + ' nouvelle(s) étape(s) prête(s).', deps);
  }
  return mission;
}

async function processNewMission(mission, deps) {
  activeMissionIds.add(mission.id);
  try {
    await event(mission, 'planification démarrée', 'pending', mission.objective.slice(0, 250), deps);
    let plan;
    try { plan = await makePlan(mission, deps, mission.steps.map((s) => ({ id: s.id, tool: s.tool, args: s.args, state: s.state, result: s.result, error: s.error, verification: s.verification }))); }
    catch (err) {
      mission.state = 'failed'; mission.error = String(err.message || err).slice(0, 300);
      await event(mission, 'planification échouée', 'error', mission.error, deps);
      return { text: 'Je n’ai pas pu établir un plan d’actions vérifiable (' + mission.error + ').', missionId: mission.id, stopReason: 'PLAN_FAILED' };
    }
    if (plan.needsInput) {
      await askForMissionInput(mission, plan.question, deps);
      return Object.assign(render(mission), { isPlanningQuestion: true, intent: 'goal' });
    }
    const ctx = Object.assign({}, deps.toolContext || {}, { tenant: mission.tenant, principal: authz.currentPrincipal(),
      runtime: deps.runtime || null, permissions: deps.permissions || ['messages:send'], generateImage: deps.generateImage || null, autonomous: true });
    if (plan.complete && !plan.steps.length) {
      await finalizeMission(mission, deps, ctx);
      return render(mission);
    }
    const completed = mission.steps.filter((s) => s.state === 'SUCCESS');
    const next = plan.steps.filter((s) => !mission.steps.some((done) => done.tool === s.tool && JSON.stringify(done.args) === JSON.stringify(s.args)));
    if (!next.length) {
      await askForMissionInput(mission, 'Je n’ai pas identifié d’étape exécutable avec les outils disponibles. Quelle information ou ressource dois-je utiliser ?', deps);
      return Object.assign(render(mission), { isPlanningQuestion: true, intent: 'goal' });
    }
    if (mission.context) mission.context.pendingTask = { missionId: mission.id, state: 'running' };
    ensureUniqueStepIds(next, completed);
    mission.steps = completed.concat(next);
    mission.state = 'running';
    mission.nextStep = next[0].id;
    await saveMission(mission.tenant, mission);
    await executePlan(mission, deps);
    return render(mission);
  } finally { activeMissionIds.delete(mission.id); }
}

async function start({ text, tenantId, sessionId, channel, history, completedSteps }, deps) {
  const principal = authz.currentPrincipal();
  if (!authz.isPrincipal(principal) || principal.tenant !== String(tenantId) || !['OWNER', 'ADMIN'].includes(principal.role)) return { text: 'La mission ne peut pas démarrer sans une identité propriétaire vérifiée.', blocked: true };
  const recent = (Array.isArray(history) ? history : []).slice(-12).map((m) => ({
    who: m && (m.role === 'assistant' ? 'Cyrus' : 'Propriétaire'), text: String(m && m.text || '').slice(0, 500),
  }));
  const mission = { id: uid(), tenant: safeTenant(tenantId), userId: String(principal.userId || ''), sessionId: String(sessionId || ''),
    channel: String(channel || principal.channel || 'CHAT').toUpperCase(), objective: String(text || '').slice(0, 4000),
    serviceId: null, pendingActionId: null, context: { conversationId: String(sessionId || ''), userId: String(principal.userId || ''), tenantId: safeTenant(tenantId),
      currentSubject: null, currentIntent: 'goal', currentGoal: String(text || '').slice(0, 1000), lastRelevantMessages: recent,
      activeProduct: null, activeService: null, commercialState: null, pendingTask: null, lastToolResult: null, handoffState: null },
    state: 'planning', question: null, steps: (Array.isArray(completedSteps) ? completedSteps : []).filter((s) => s && s.state === 'SUCCESS' && (s.tool || s.name)).map((s, i) => ({
      id: 'verified_' + (i + 1), tool: String(s.tool || s.name), args: s.args || {}, executedArgs: s.args || {},
      label: String(s.label || s.tool || s.name).slice(0, 160), state: 'SUCCESS', result: s.result || null,
      error: null, verification: s.verification || { verified: true, source: 'previous_tool_registry_call' }, finishedAt: Date.now(),
    })), createdAt: Date.now(), startedAt: Date.now(), updatedAt: Date.now(),
    taskId: null, currentStep: null, nextStep: null, lastResult: null, retryCount: 0,
    progress: [], lastNotificationAt: null, result: null, error: null,
    ownerConversationId: String(sessionId || '') };
  mission.taskId = mission.id;
  try {
    const services = await businessServices.getEngineContext(tenantId);
    const matched = businessServices.matchService(services, mission.objective);
    if (matched) {
      mission.serviceId = matched.id;
      mission.context.activeService = { id: matched.id, name: matched.name };
      mission.context.currentSubject = matched.name;
    }
  } catch (_) { /* service context may be unavailable; never invent a match */ }
  await saveMission(mission.tenant, mission);
  if (deps && deps.background === true) {
    setImmediate(() => processNewMission(mission, deps).catch(async (err) => {
      mission.state = 'failed'; mission.error = String(err.message || err).slice(0, 300);
      await event(mission, 'exécution de mission interrompue', 'error', mission.error, deps).catch(() => {});
    }));
    return { text: 'Mission ' + mission.id + ' enregistrée. La préparation et les étapes démarrent en arrière-plan.',
      missionId: mission.id, taskId: mission.taskId, state: 'planning', status: 'QUEUED', objective: mission.objective,
      currentStep: null, nextStep: null, pendingActionId: null, startedAt: mission.startedAt, updatedAt: mission.updatedAt };
  }
  return processNewMission(mission, deps || {});
}

async function resumeCore({ tenantId, id, answer, sessionId, pendingActionId }, deps) {
  const mission = await get(tenantId, id);
  if (!mission) return { text: 'Mission introuvable pour ce compte.' };
  const caller = authz.currentPrincipal();
  if (!authz.isPrincipal(caller) || caller.tenant !== mission.tenant || (mission.userId && caller.userId !== mission.userId)) {
    return { text: 'Cette mission n’est pas rattachée à votre identité ou à votre compte.', blocked: true };
  }
  if (sessionId && ['needs_confirmation', 'waiting_input'].includes(mission.state)
    && String(sessionId) !== String(mission.ownerConversationId || mission.sessionId || '')) {
    return { text: 'Cette confirmation ou précision appartient à une autre conversation.', blocked: true };
  }
  if (mission.state === 'needs_confirmation') {
    const answerRef = String(answer || '').match(/\bACT-[A-F0-9]{12}\b/i);
    if ((answerRef && answerRef[0].toUpperCase() !== String(mission.pendingActionId || '').toUpperCase())
      || (pendingActionId && String(pendingActionId).toUpperCase() !== String(mission.pendingActionId || '').toUpperCase())) {
      return { text: 'Cette référence ne correspond pas à l’action en attente pour cette mission.', missionId: id, blocked: true };
    }
  }
  if (mission.state === 'needs_confirmation' && answer) {
    if (mission.confirmationExpiresAt && mission.confirmationExpiresAt <= Date.now()) {
      mission.state = 'needs_review'; mission.error = { code: 'CONFIRMATION_EXPIRED' };
      await event(mission, 'confirmation expirée — vérification requise', 'warning', mission.pendingActionId || mission.id, deps);
      return render(mission);
    }
    if (authz.isPrincipal(authz.currentPrincipal()) && require('./personaManager').detectDecline(answer)) {
      mission.state = 'stopped';
      mission.pendingActionId = null; mission.confirmationExpiresAt = null;
      if (mission.context) { mission.context.pendingAction = null; mission.context.pendingTask = { missionId: mission.id, state: 'stopped' }; }
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
      mission.pendingActionId = null; mission.confirmationExpiresAt = null;
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
    mission.lastResult = { stepId: step.id, tool: step.tool, state: call.state, result: call.result || null, error: call.error || null, verification: call.verification || null, at: step.finishedAt };
    if (mission.context) mission.context.lastToolResult = mission.lastResult;
    if (call.state !== 'SUCCESS') {
      mission.state = call.state === 'UNCONFIRMED' ? 'needs_review' : 'failed';
      await event(mission, 'action confirmée mais non vérifiée', 'warning', step.label, deps);
      return render(mission);
    }
    mission.pendingActionId = null; mission.confirmationExpiresAt = null;
    if (mission.context) mission.context.pendingAction = null;
    mission.state = 'running';
    await event(mission, 'action confirmée et vérifiée', 'ok', step.label, deps);
    await executePlan(mission, deps);
    return render(mission);
  }
  if (mission.state === 'waiting_input' && answer) {
    mission.objective += '\nPrécision utilisateur : ' + String(answer).slice(0, 1500);
    if (mission.context) {
      mission.context.currentGoal = mission.objective.slice(0, 1500);
      mission.context.lastRelevantMessages = (mission.context.lastRelevantMessages || []).concat([{ who: 'Propriétaire', text: String(answer).slice(0, 500) }]).slice(-12);
    }
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
      await askForMissionInput(mission, plan.question, deps); return render(mission);
    }
    const ctx = Object.assign({}, deps.toolContext || {}, { tenant: mission.tenant, principal: authz.currentPrincipal(),
      runtime: deps.runtime || null, permissions: deps.permissions || ['messages:send'], generateImage: deps.generateImage || null, autonomous: true });
    if (plan.complete && !plan.steps.length) {
      await finalizeMission(mission, deps, ctx); return render(mission);
    }
    const successful = mission.steps.filter((s) => s.state === 'SUCCESS');
    const next = plan.steps.filter((s) => !mission.steps.some((done) => done.tool === s.tool && JSON.stringify(done.args) === JSON.stringify(s.args)));
    if (!next.length) {
      await askForMissionInput(mission, 'Je n’ai pas identifié d’étape exécutable avec les outils disponibles. Quelle information ou ressource dois-je utiliser ?', deps);
      return render(mission);
    }
    ensureUniqueStepIds(next, successful);
    mission.steps = successful.concat(next);
    mission.state = 'running'; await saveMission(mission.tenant, mission);
    await executePlan(mission, deps); return render(mission);
  }
  if (mission.state === 'needs_review') return { text: 'La mission ' + mission.id + ' contient une étape interrompue dont l’effet doit être vérifié avant toute reprise.', missionId: id, state: mission.state };
  if (mission.state !== 'paused') return render(mission);
  mission.state = 'running'; await event(mission, 'mission reprise', 'pending', '', deps);
  await executePlan(mission, deps); return render(mission);
}

async function resume(args, deps) {
  const key = String(args && args.id || '');
  if (activeMissionIds.has(key)) {
    const current = await get(args.tenantId, key);
    if (!current) return { text: 'Mission introuvable.' };
    const caller = authz.currentPrincipal();
    if (!authz.isPrincipal(caller) || caller.tenant !== current.tenant
      || (current.userId && caller.userId !== current.userId)) {
      return { text: 'Cette mission n’est pas rattachée à votre identité ou à votre compte.', blocked: true };
    }
    return render(current);
  }
  activeMissionIds.add(key);
  try { return await resumeCore(args, deps); }
  finally { activeMissionIds.delete(key); }
}

async function control({ tenantId, id, action }, deps) {
  const mission = await get(tenantId, id);
  if (!mission) return null;
  const principal = authz.currentPrincipal();
  if (!authz.isPrincipal(principal) || principal.tenant !== mission.tenant
    || (mission.userId && principal.userId !== mission.userId)) {
    return { text: 'Cette mission n’est pas rattachée à votre identité ou à votre compte.', missionId: id, state: mission.state, blocked: true };
  }
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
        mission.pendingActionId = mission.pendingActionId || 'ACT-' + crypto.randomBytes(6).toString('hex').toUpperCase();
        mission.confirmationExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
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
  else if (mission.state === 'needs_confirmation') text = 'Mission ' + mission.id + ' en pause : l’action préparée ' + (mission.pendingActionId || '') + ' attend votre confirmation explicite.';
  else if (mission.state === 'needs_review') text = 'Mission ' + mission.id + ' arrêtée pour contrôle : une étape n’a pas pu être confirmée après interruption.';
  else if (mission.state === 'monitoring') text = 'Mission ' + mission.id + ' — campagnes en cours, suivi réel : ' + (mission.progress || []).map((p) => p.channel + ' ' + p.sent + '/' + p.total + ' (' + p.status + ')').join('; ');
  else if (mission.state === 'awaiting_outcome') text = 'Mission ' + mission.id + ' : les envois sont terminés et mesurés. ' + (mission.outcomeNote || 'Les conversions demandent une preuve commerciale disponible.');
  else if (mission.state === 'paused') text = 'Mission ' + mission.id + ' mise en pause après ' + done + '/' + mission.steps.length + ' étapes vérifiées.';
  else if (mission.state === 'stopped') text = 'Mission ' + mission.id + ' arrêtée après ' + done + '/' + mission.steps.length + ' étapes vérifiées.';
  else if (mission.state === 'failed') text = 'Mission ' + mission.id + ' incomplète : ' + done + '/' + mission.steps.length + ' étapes vérifiées' + (failed[0] && failed[0].error ? ', erreur ' + (failed[0].error.code || failed[0].error.message || 'inconnue') : '') + '.';
  else text = 'Mission ' + mission.id + ' en cours : ' + done + '/' + mission.steps.length + ' étapes vérifiées.';
  stampMission(mission);
  return { text, missionId: mission.id, taskId: mission.taskId, state: mission.state, status: mission.status,
    objective: mission.objective, currentStep: mission.currentStep || null, progressPercent: mission.progressPercent,
    pendingActionId: mission.pendingActionId || null, confirmationExpiresAt: mission.confirmationExpiresAt || null,
    serviceId: mission.serviceId || null, userId: mission.userId || null, nextStep: mission.nextStep || null,
    lastResult: mission.lastResult || null,
    startedAt: mission.startedAt, updatedAt: mission.updatedAt, ownerConversationId: mission.ownerConversationId,
    result: mission.result || null, error: mission.error || null,
    progress: mission.progress || [], outcomeNote: mission.outcomeNote || null,
    steps: mission.steps.map((s) => ({ id: s.id, tool: s.tool, label: s.label, state: s.state })),
    actionLog: mission.steps.map((s) => ({ icon: s.state === 'SUCCESS' ? '✅' : s.state === 'FAILED' || s.state === 'BLOCKED' ? '⚠️' : '⏳', label: s.label + ' — ' + s.state, status: s.state === 'SUCCESS' ? 'done' : s.state === 'FAILED' || s.state === 'BLOCKED' ? 'error' : 'pending' })) };
}

module.exports = { start, resume, control, get, list, render, monitorMission, recoverMonitoring, recoverPending, NS };
