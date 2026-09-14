// CHAT-TO-ACTION — interface de dialogue direct (Zero-VPS)
// -----------------------------------------------------------------------------
// Fenêtre de dialogue objectif -> plan, 100% locale (moteurs UMD embarqués :
// human-context-engine + task-parser + goal-chat, les MÊMES modules que côté
// VPS — voir lib/intelligence/goal-chat.js). Aucun réseau pour la
// conversation elle-même. L'exécution réelle (SEND_CAMPAIGN) ne réimplémente
// JAMAIS le moteur d'envoi : "🚀 Lancer" navigue vers l'onglet Campagnes
// (canal préréglé), où l'utilisateur déclenche le VRAI envoi via
// campaigns-core.js — c'est la seule voie d'exécution existante.
//
// Contract : définit window.CyrusChatUI. Chargeable par webapp-core/index.html,
// copié par sync.js vers mobile/webapp/www/ et local-client/public/.

(function () {
  'use strict';

  const TP = (typeof window !== 'undefined' && window.TaskParser) ? window.TaskParser : null;
  const HC = (typeof window !== 'undefined' && window.HumanContextEngine) ? window.HumanContextEngine : null;
  const GC = (typeof window !== 'undefined' && window.CyrusGoalChat) ? window.CyrusGoalChat : null;

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ------------------------------------------------------------------ Chat
  let goalSession = null;

  function goalAppendBubble(role, text) {
    const container = document.getElementById('goalchat-messages');
    if (!container) return null;
    const bubble = document.createElement('div');
    bubble.className = 'goalchat-msg ' + (role === 'user' ? 'user' : 'assistant');
    bubble.textContent = text;
    container.appendChild(bubble);
    container.scrollTop = container.scrollHeight;
    return bubble;
  }

  function goalAppendChips(labels, onPick) {
    if (!labels || !labels.length) return;
    const container = document.getElementById('goalchat-messages');
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'goalchat-chips';
    labels.forEach((label) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'secondary';
      btn.textContent = label;
      btn.addEventListener('click', () => onPick(label));
      row.appendChild(btn);
    });
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
  }

  function goalAppendPlanActions(actions) {
    if (!actions || !actions.length) return;
    const container = document.getElementById('goalchat-messages');
    if (!container) return;
    const row = document.createElement('div');
    row.className = 'goalchat-chips';
    actions.forEach((a) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = a.kind === 'primary' ? 'primary' : 'secondary';
      btn.textContent = a.label;
      btn.addEventListener('click', () => goalHandleAction(a.id));
      row.appendChild(btn);
    });
    container.appendChild(row);
    container.scrollTop = container.scrollHeight;
  }

  function goalChannelValue(ctx) {
    const chan = ctx && ctx.channels && ctx.channels[0];
    return chan === 'TELEGRAM' ? 'telegram' : 'whatsapp';
  }

  function navigateToScreen(name) {
    const navBtn = document.querySelector('.nav button[data-screen="' + name + '"]');
    if (navBtn) navBtn.click();
  }

  // "Lancer" prépare RÉELLEMENT l'envoi (contacts déjà importés, message
  // généré à partir de l'objectif) puis ouvre la Relance Manuelle Express
  // avec la file prête — mais ne réimplémente JAMAIS l'envoi lui-même : le
  // premier clic ("Envoyer & Suivant", ou l'activation du Mode Série
  // Continu) reste la main de l'utilisateur, un message à la fois — c'est
  // la seule voie d'envoi qui existe dans un onglet navigateur (voir
  // adapters/browser.js). Le moteur exploite ce mode manuel, il ne le
  // contourne pas.
  async function runPlanViaRelance(ctx) {
    const store = window.CyrusStore;
    const channel = goalChannelValue(ctx);
    const rawContacts = await store.getContacts(channel);
    if (!rawContacts || !rawContacts.length) {
      goalAppendBubble('assistant', "⚠️ Aucun contact " + (channel === 'telegram' ? 'Telegram' : 'WhatsApp') + " importé pour l'instant — importe une liste ou extrait un groupe dans l'onglet Campagnes, puis relance ton objectif.");
      navigateToScreen('campaigns');
      return;
    }
    const unblocked = await store.filterBlocked(channel, rawContacts);
    if (!unblocked.length) {
      goalAppendBubble('assistant', '⚠️ Tous les contacts disponibles sont dans la liste noire — rien à relancer sur ce canal.');
      return;
    }

    const intention = GC.buildObjectiveString(ctx);
    const campaign = await store.createCampaign(channel, {
      name: 'Objectif IA — ' + new Date().toLocaleString('fr-FR'),
      text: intention,
      delayMinMs: 8000,
      delayMaxMs: 20000,
      recipients: unblocked.map((c) => ({ to: c.identifier, name: c.name })),
    });

    navigateToScreen('relance');
    const channelSelect = document.getElementById('relance-channel');
    const intentionField = document.getElementById('relance-intention');
    if (channelSelect) channelSelect.value = channel;
    if (intentionField) intentionField.value = intention;
    const reloadBtn = document.getElementById('relance-reload-btn');
    if (reloadBtn) reloadBtn.click(); // charge la file + génère un message personnalisé par contact

    goalAppendBubble('assistant', '✅ File de Relance Manuelle Express prête : ' + unblocked.length + ' contact(s) sur ' + (channel === 'telegram' ? 'Telegram' : 'WhatsApp') + ', message généré à partir de ton objectif. Rien n\'est envoyé sans ta confirmation — valide "Envoyer & Suivant" (ou active le Mode Série Continu) dans l\'onglet Relance Manuelle. (Campagne : ' + campaign.id + ')');
  }

  function goalHandleAction(actionId) {
    if (actionId === 'navigate-campaigns') {
      const ctx = goalSession && goalSession.ctx;
      const select = document.getElementById('camp-channel');
      if (select && ctx) {
        const v = goalChannelValue(ctx);
        if (Array.from(select.options).some((o) => o.value === v)) {
          select.value = v;
          select.dispatchEvent(new Event('change'));
        }
      }
      navigateToScreen('campaigns');
      return;
    }
    if (actionId === 'run-plan') {
      const ctx = goalSession && goalSession.ctx;
      if (!ctx) return;
      runPlanViaRelance(ctx).catch((err) => {
        goalAppendBubble('assistant', '⚠️ Erreur lors de la préparation de la relance : ' + (err && err.message || err));
      });
      return;
    }
    if (actionId === 'restart') {
      goalSession = GC.createSession({});
      const container = document.getElementById('goalchat-messages');
      if (container) container.innerHTML = '';
      goalAppendBubble('assistant', GC.WELCOME.text);
      goalAppendChips(GC.WELCOME.quick, (label) => goalSend(label));
    }
  }

  function goalSend(message) {
    if (!GC || !goalSession) return;
    goalAppendBubble('user', message);
    const out = GC.step(goalSession, { message, parser: TP, humanContext: HC });
    if (out.reply && out.reply.text) goalAppendBubble('assistant', out.reply.text);
    if (out.quick) goalAppendChips(out.quick, (label) => goalSend(label));
    if (out.kind === 'plan' && out.actions) goalAppendPlanActions(out.actions);
  }

  function initGoalChat() {
    const input = document.getElementById('goalchat-input');
    const sendBtn = document.getElementById('goalchat-send-btn');
    if (!input || !sendBtn) return; // écran non présent sur cette plateforme

    if (!GC || !TP) {
      goalAppendBubble('assistant', "⚠️ Le moteur intelligent (task-parser/goal-chat) n'a pas pu se charger.");
      sendBtn.disabled = true;
      return;
    }

    goalSession = GC.createSession({});
    goalAppendBubble('assistant', GC.WELCOME.text);
    goalAppendChips(GC.WELCOME.quick, (label) => goalSend(label));

    sendBtn.addEventListener('click', () => {
      const message = input.value.trim();
      if (!message) return;
      input.value = '';
      goalSend(message);
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendBtn.click();
      }
    });
  }

  // ------------------------------------------------------- Human Context (tel quel)
  function renderAnalysis(container, message) {
    if (!HC) {
      container.innerHTML = '<p class="empty">Moteur HumanContext indisponible.</p>';
      return;
    }
    const a = HC.analyzeMessage(message);
    if (a.error) {
      container.innerHTML = '<p class="error">' + escapeHtml(String(a.error)) + '</p>';
      return;
    }
    const strategy = HC.selectStrategy(a);
    const followUp = HC.generateFollowUp(a, strategy, {});

    const html = [];
    html.push('<div style="font-size:12px; line-height:1.7;">');
    html.push(`<div><b>Sentiment :</b> <span class="badge">${escapeHtml(a.sentiment)}</span> &nbsp; <b>Émotion :</b> <span class="badge">${escapeHtml(a.dominant_emotion)}</span></div>`);
    html.push(`<div><b>Intérêt :</b> ${escapeHtml(a.interest)} · <b>Intention :</b> ${escapeHtml(a.intent)} · <b>Prob. achat :</b> ${Math.round(a.purchase_probability * 100)}%</div>`);
    html.push(`<div><b>Confiance :</b> ${Math.round(a.trust * 100)}% · <b>Hésitation :</b> ${Math.round(a.hesitation * 100)}% · <b>Urgence :</b> ${Math.round(a.urgency * 100)}%</div>`);
    html.push(`<div><b>Objections probables :</b> ${(a.likely_objections || []).join(', ') || 'aucune'} · <b>Incertitude :</b> ${Math.round(a.uncertainty_level * 100)}%</div>`);
    html.push(`<div style="margin-top:8px;"><b>Stratégie :</b> <span class="badge">${escapeHtml(strategy.id)}</span> — <span style="color:var(--cyan)">${escapeHtml(strategy.angle)}</span></div>`);
    html.push(`<div style="margin-top:6px;"><b>Relance suggérée :</b></div><blockquote style="margin:6px 0; padding:8px; border-left:3px solid var(--cyan); background:rgba(34,211,238,.06); color:var(--text,#e2e8f0);">${escapeHtml(followUp.replace('{first_name}', '<i>nom</i>'))}</blockquote>`);
    html.push('</div>');
    container.innerHTML = html.join('');
  }

  function init() {
    initGoalChat();

    const msgBtn = document.getElementById('intel-analyze-btn');
    const msgInput = document.getElementById('intel-msg');
    const analysisEl = document.getElementById('intel-analysis');
    if (msgBtn && msgInput) {
      msgBtn.addEventListener('click', () => {
        const text = msgInput.value.trim();
        if (!text) { analysisEl.innerHTML = '<p class="error">Saisis un message reçu.</p>'; return; }
        renderAnalysis(analysisEl, text);
      });
    }
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
  }

  window.CyrusChatUI = { parseObjective: TP && TP.parseObjective, analyzeMessage: HC && HC.analyzeMessage };
})();
