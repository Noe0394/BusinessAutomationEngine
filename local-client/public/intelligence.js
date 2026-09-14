// Chat Intelligent (Goal Chat) — client du serveur local (voir index.js
// POST /api/intelligence/goal-chat, lib/intelligence/goal-chat.js).
// "run-plan"/"navigate-campaigns" ne réimplémentent jamais l'envoi : ils
// ouvrent l'onglet Campagnes (canal préréglé) où le vrai envoi se fait via
// createCampaign() existant.

let goalChatSessionId = null;
let goalChatWelcomed = false;

function goalChatAppendBubble(role, text) {
  const container = document.getElementById('goalchat-messages');
  const bubble = document.createElement('div');
  bubble.className = 'goalchat-msg ' + (role === 'user' ? 'user' : 'assistant');
  bubble.textContent = text;
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

function goalChatAppendChips(labels, onPick) {
  if (!labels || !labels.length) return;
  const container = document.getElementById('goalchat-messages');
  const row = document.createElement('div');
  row.className = 'goalchat-chips';
  labels.forEach((label) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', () => goalChatSend(label));
    row.appendChild(btn);
  });
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

function goalChatAppendPlanActions(actions, ctx) {
  if (!actions || !actions.length) return;
  const container = document.getElementById('goalchat-messages');
  const row = document.createElement('div');
  row.className = 'goalchat-chips';
  actions.forEach((a) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = a.label;
    btn.addEventListener('click', () => goalChatHandleAction(a.id, ctx));
    row.appendChild(btn);
  });
  container.appendChild(row);
  container.scrollTop = container.scrollHeight;
}

function goalChatHandleAction(actionId, ctx) {
  if (actionId === 'run-plan' || actionId === 'navigate-campaigns') {
    const chan = ctx && ctx.channels && ctx.channels[0];
    const select = document.getElementById('campChannel');
    if (select && chan) select.value = chan === 'TELEGRAM' ? 'telegram' : 'whatsapp';
    showTab('campagnes');
    return;
  }
  if (actionId === 'restart') {
    goalChatRestart();
  }
}

async function goalChatPost(body) {
  const res = await fetch('/api/intelligence/goal-chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(Object.assign({ sessionId: goalChatSessionId }, body)),
  });
  return res.json();
}

// Cartes d'état (voir ai-engine/chatOrchestrator.js — icon/label/status) :
// affichées comme une petite bulle système distincte, sous la réponse.
function goalChatAppendActionLog(actionLog) {
  if (!actionLog || !actionLog.length) return;
  const container = document.getElementById('goalchat-messages');
  const bubble = document.createElement('div');
  bubble.className = 'goalchat-msg assistant';
  bubble.style.fontSize = '12px';
  bubble.style.opacity = '0.85';
  bubble.textContent = actionLog.map((a) => `${a.icon || ''} ${a.label || ''}`.trim()).join('\n');
  container.appendChild(bubble);
  container.scrollTop = container.scrollHeight;
}

async function goalChatSend(message) {
  goalChatAppendBubble('user', message);
  try {
    const data = await goalChatPost({ message });
    if (!data.ok) { goalChatAppendBubble('assistant', '⚠️ ' + (data.error || 'Erreur.')); return; }
    if (data.sessionId) goalChatSessionId = data.sessionId;
    if (data.reply && data.reply.text) goalChatAppendBubble('assistant', data.reply.text);
    if (data.actionLog) goalChatAppendActionLog(data.actionLog);
    if (data.quick) goalChatAppendChips(data.quick, (label) => goalChatSend(label));
    if (data.kind === 'plan' && data.actions) goalChatAppendPlanActions(data.actions, data.ctx);
  } catch (err) {
    goalChatAppendBubble('assistant', '⚠️ Erreur de communication avec le système intelligent.');
  }
}

// Notifications asynchrones (escalade prospect, feedback client — voir
// ai-engine/emotionalCloser.js + ai-engine/platformOrchestrator.js) :
// sondées périodiquement, affichées comme un message assistant dès qu'un
// onglet "Chat Intelligent" est ouvert au moins une fois.
async function goalChatPollNotifications() {
  try {
    const res = await fetch('/api/notifications');
    const data = await res.json();
    (data.notifications || []).forEach((n) => {
      goalChatAppendBubble('assistant', n.text);
      if (n.actionLog) goalChatAppendActionLog(n.actionLog);
    });
  } catch (err) { /* silencieux — nouvelle tentative au prochain intervalle */ }
}
setInterval(goalChatPollNotifications, 8000);

async function goalChatRestart() {
  try {
    const data = await goalChatPost({ action: 'restart' });
    goalChatSessionId = data.sessionId;
    document.getElementById('goalchat-messages').innerHTML = '';
    if (data.reply) {
      goalChatAppendBubble('assistant', data.reply.text);
      goalChatAppendChips(data.reply.quick, (label) => goalChatSend(label));
    }
  } catch (err) { /* silencieux : l'utilisateur peut retaper un message */ }
}

function goalChatSendClick() {
  const input = document.getElementById('goalchat-input');
  const message = input.value.trim();
  if (!message) return;
  input.value = '';
  goalChatSend(message);
}

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('goalchat-input');
  if (!input) return; // onglet absent sur cette page
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); goalChatSendClick(); }
  });
  if (!goalChatWelcomed) {
    goalChatWelcomed = true;
    goalChatAppendBubble('assistant', "👋 Je suis le système intelligent de CYRUS. Dis-moi ton objectif — par exemple :");
    goalChatAppendChips(
      ['Vendre 50 produits aujourd\'hui', 'Trouver 20 prospects', 'Publier 3 contenus', 'Faire un suivi automatique'],
      (label) => goalChatSend(label),
    );
  }
});
