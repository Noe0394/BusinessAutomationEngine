// TOOL AGENT — ai-engine/toolAgent.js
// ---------------------------------------------------------------------------
// Boucle « User → Chat → sélection d'outil → tool call vérifié → réponse
// ancrée ». Quand un message ne correspond à aucune intention précise du
// chatOrchestrator, l'agent demande au LLM de choisir AU PLUS un outil réel du
// registre (ai-engine/toolRegistry.js), l'exécute via la machine à états
// vérifiée, puis rédige une réponse fondée UNIQUEMENT sur le résultat RÉEL
// (jamais un faux « c'est fait » : si l'état est FAILED/UNCONFIRMED/BLOCKED,
// il le dit honnêtement). Renvoie null si aucun outil ne s'applique (le chat
// conversationnel générique prend alors le relais).
//
// `deps.llm(prompt, history)` est injectable (défaut : cascade llmFallbackEngine)
// pour des tests déterministes ; `deps.runtime` fournit l'envoi vérifié réel.

const personaManager = require('./personaManager');
const toolRegistry = require('./toolRegistry');
const verbatimPayload = require('./verbatimPayload');

function extractJson(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch (e) { return null; }
}

function describeTools(tools) {
  return tools.map((t) => {
    const params = Object.entries(t.inputSchema || {})
      .map(([k, s]) => `${k}${s.required ? ' (requis)' : ''}: ${s.description || ''}`).join(' ; ');
    const capabilities = Array.isArray(t.capabilities) && t.capabilities.length ? t.capabilities.join(', ') : 'général';
    return `- ${t.name} [fonction=${t.feature || 'général'}; capacités=${capabilities}; risque=${t.risk || 'READ'}] : ${t.description}\n  Args : ${params || '(aucun)'}`;
  }).join('\n');
}

async function defaultLlm(prompt, history) {
  const llmFallbackEngine = require('../lib/ai/llmFallbackEngine');
  const { text } = await llmFallbackEngine.generateAIResponse(prompt, history || [], null, undefined, null, { purpose: 'tool_agent', tier: 'reasoning' });
  return text;
}

function iconFor(state) {
  return state === 'SUCCESS' ? '✅' : (state === 'UNCONFIRMED' ? '⏳' : (state === 'BLOCKED' ? '🔒' : '⚠️'));
}
function statusFor(state) {
  return state === 'SUCCESS' ? 'done' : (state === 'UNCONFIRMED' ? 'warning' : 'error');
}

async function runToolAgent({ text, history, tenantId }, deps) {
  const d = deps || {};
  const llm = typeof d.llm === 'function' ? d.llm : defaultLlm;
  const ctx = { runtime: d.runtime || null, permissions: d.permissions || ['messages:send'], generateImage: d.generateImage || null };
  ctx.principal = require('./authz').currentPrincipal();
  const tools = await toolRegistry.discover(text, ctx, { limit: 50 });

  const selPrompt = [
    personaManager.personaSystemPrompt('default'),
    'Tu peux utiliser AU PLUS UN de ces outils RÉELS pour répondre à la demande, ou aucun si c\'est juste de la conversation :',
    describeTools(tools),
    `Message du vendeur : "${text}"`,
    'Choisis l\'outil réellement pertinent et extrais ses arguments depuis le message et l\'historique. N\'invente jamais un outil hors de cette liste.',
    'Si un outil permet de répondre/agir, réponds UNIQUEMENT {"tool":"nom_exact","args":{...}}. Si c\'est une simple conversation sans besoin d\'outil, réponds UNIQUEMENT {"tool":null}.',
  ].join('\n');

  let parsed;
  try { parsed = extractJson(await llm(selPrompt, history || [])); }
  catch (e) { return null; }
  if (!parsed || !('tool' in parsed) || !parsed.tool) return null;
  if (!tools.some((t) => t.name === parsed.tool)) return null;

  const call = await toolRegistry.execute(tenantId, parsed.tool, verbatimPayload.applyVerbatimText(parsed.tool, parsed.args || {}, text), ctx);

  const ansPrompt = [
    personaManager.personaSystemPrompt('default'),
    `Tu as appelé l'outil « ${parsed.tool} ». État RÉEL de l'exécution : ${call.state}.`,
    `Résultat/erreur (données RÉELLES — n'invente rien au-delà) : ${JSON.stringify(call.result || call.error || {})}`,
    `Le vendeur avait demandé : "${text}"`,
    call.state === 'SUCCESS'
      ? 'Réponds naturellement en citant les faits réels du résultat.'
      : 'Explique honnêtement ce qui s\'est passé (échec / non confirmé / bloqué) et, si utile, ce qu\'il faut faire — ne prétends JAMAIS que l\'action est faite si elle ne l\'est pas.',
  ].join('\n');

  let answer;
  try { answer = String(await llm(ansPrompt, history || []) || '').trim(); }
  catch (e) { answer = ''; }
  if (!answer) {
    answer = call.state === 'SUCCESS'
      ? 'C\'est fait.'
      : `Je n'ai pas pu finaliser (${call.state}${call.error && call.error.code ? ' — ' + call.error.code : ''}).`;
  }

  return {
    text: answer,
    toolCall: {
      name: parsed.tool, state: call.state, result: call.result || null, error: call.error || null,
      confirmationId: (call.verification && call.verification.confirmationId) || null,
    },
    actionLog: [{ icon: iconFor(call.state), label: `${parsed.tool} → ${call.state}`, status: statusFor(call.state) }],
  };
}

module.exports = { runToolAgent, describeTools };
