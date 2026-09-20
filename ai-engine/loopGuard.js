// LOOP GUARD — ai-engine/loopGuard.js
// ---------------------------------------------------------------------------
// Protection anti-boucle et anti-coût (§29) : empêche un enchaînement
// IA → Tool → Event → IA → … de partir en boucle et de brûler des appels IA.
// 100 % DÉTERMINISTE (aucun appel IA), en mémoire, borné.
//
// Deux garde-fous :
//   1) Plafond d'appels IA par TÂCHE (taskId/correlationId) sur une fenêtre de
//      temps : au-delà de MAX_AI_CALLS_PER_TASK, countAiCall() lève
//      AiLoopLimitError — l'appelant (generateAIResponse) refuse alors l'appel.
//   2) Idempotence (idempotencyKey) : seen() renvoie true si une clé a déjà été
//      traitée récemment (évite de re-traiter le même message/évènement).

// 30 appels / 5 min / conversation : assez pour un échange soutenu (2 à 3 appels IA par réponse : rédaction + régénération éventuelle),
// tout en coupant une vraie boucle (bot <-> bot, boucle d'outils). Avec 6, un prospect qui écrit vite faisait taire l'IA en pleine conversation.
const MAX_AI_CALLS_PER_TASK = Math.max(1, parseInt(process.env.MAX_AI_CALLS_PER_TASK, 10) || 30);
const TASK_TTL_MS = 5 * 60 * 1000; // une "tâche" vit 5 min
const IDEMP_TTL_MS = 60 * 60 * 1000; // idempotence sur 1 h

class AiLoopLimitError extends Error {
  constructor(taskId, count) {
    super(`Plafond d'appels IA atteint pour la tâche "${taskId}" (${count}/${MAX_AI_CALLS_PER_TASK}) — boucle probable, appel refusé.`);
    this.code = 'AI_LOOP_LIMIT';
    this.taskId = taskId;
  }
}

const tasks = new Map(); // taskId -> { count, first }
const idemp = new Map(); // key -> expiry

function sweep() {
  const now = Date.now();
  for (const [k, v] of tasks) { if (now - v.first > TASK_TTL_MS) tasks.delete(k); }
  for (const [k, exp] of idemp) { if (now > exp) idemp.delete(k); }
  if (tasks.size > 5000) tasks.clear();
  if (idemp.size > 20000) idemp.clear();
}

// Incrémente le compteur d'appels IA d'une tâche ; lève AiLoopLimitError si le
// plafond est dépassé. Sans taskId : no-op (appels non rattachés à une tâche).
function countAiCall(taskId) {
  if (!taskId) return { count: 0, ok: true };
  sweep();
  const now = Date.now();
  let t = tasks.get(taskId);
  if (!t || now - t.first > TASK_TTL_MS) { t = { count: 0, first: now }; tasks.set(taskId, t); }
  t.count += 1;
  if (t.count > MAX_AI_CALLS_PER_TASK) throw new AiLoopLimitError(taskId, t.count);
  return { count: t.count, ok: true };
}

function callsForTask(taskId) { const t = tasks.get(taskId); return t ? t.count : 0; }
function resetTask(taskId) { tasks.delete(taskId); }

// Idempotence : renvoie true si `key` a déjà été vue dans la fenêtre (donc à
// ignorer), false sinon (et la marque comme vue).
function seen(key) {
  if (!key) return false;
  sweep();
  if (idemp.has(key) && Date.now() < idemp.get(key)) return true;
  idemp.set(key, Date.now() + IDEMP_TTL_MS);
  return false;
}

module.exports = { countAiCall, callsForTask, resetTask, seen, AiLoopLimitError, MAX_AI_CALLS_PER_TASK };
