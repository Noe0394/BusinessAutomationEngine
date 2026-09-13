// CHAT-TO-ACTION — interface de dialogue direct (Zero-VPS)
// -----------------------------------------------------------------------------
// Traduit un objectif en langage naturel en un plan de tâches, 100% localement
// (moteurs UMD embarqués : human-context-engine + task-parser). Aucun réseau.
// L'exécution réelle (SEND_CAMPAIGN etc.) s'appuie sur les écrans existants —
// ce module ne réimplémente jamais un moteur d'envoi.
//
// Contract : définit window.CyrusChatUI. Chargeable par webapp-core/index.html,
// copié par sync.js vers mobile/webapp/www/ et local-client/public/.

(function () {
  'use strict';

  const TP = (typeof window !== 'undefined' && window.TaskParser) ? window.TaskParser : null;
  const HC = (typeof window !== 'undefined' && window.HumanContextEngine) ? window.HumanContextEngine : null;

  const CHANNEL_ICON = { WHATSAPP: '🚀', TELEGRAM: '✈️', TIKTOK: '🎵', YOUTUBE: '▶️' };
  const ACTION_LABEL = {
    EXTRACT_MEMBERS: 'Extraire les contacts',
    SEND_CAMPAIGN: 'Lancer la campagne',
    FOLLOW_UP: 'Planifier la relance',
    ANALYZE_RESPONSES: 'Analyser les réponses',
    ANALYZE_HUMAN_CONTEXT: 'Analyser le contexte humain',
    REPLY_COMMENT: 'Répondre aux commentaires',
    GENERATE_VIDEO: 'Générer la vidéo',
    PAUSE_CAMPAIGN: 'Pause campagne',
    RESUME_CAMPAIGN: 'Reprendre campagne',
    GENERATE_REPORT: 'Générer le rapport',
    CREATE_USER_ACCOUNT: 'Créer le compte utilisateur',
    GENERATE_ACCESS_KEY: 'Générer la clé d’accès',
  };

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function delayLabel(d) {
    if (!d) return 'immédiat';
    const m = Math.round(d / 60000);
    if (m < 60) return (m < 1 ? '~1 min' : m + ' min');
    const h = Math.round(m / 60);
    return h + ' h';
  }

  function renderTasks(container, plan, runId) {
    container.innerHTML = '';
    if (!plan || !plan.length) {
      container.innerHTML = '<p class="empty">Aucune étape générée.</p>';
      return;
    }
    plan.forEach((d, i) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:8px; padding:8px 0; border-bottom:1px solid var(--line,#1e293b);';
      const icon = document.createElement('span');
      icon.textContent = CHANNEL_ICON[d.channel] || '•';
      const label = document.createElement('span');
      label.style.cssText = 'flex:1;';
      label.textContent = `${i + 1}. ${ACTION_LABEL[d.action] || d.action}`;
      const badge = document.createElement('span');
      badge.className = 'badge';
      const timing = d.immediate ? 'immédiat' : 'dans ' + delayLabel(d.scheduledOffsetMs);
      badge.textContent = `${d.channel} · ${timing}`;
      row.appendChild(icon); row.appendChild(label); row.appendChild(badge);
      container.appendChild(row);
    });
    if (runId) {
      const run = document.createElement('p');
      run.className = 'empty';
      run.style.cssText = 'font-size:12px;';
      run.textContent = 'runId (idempotence) : ' + runId;
      container.appendChild(run);
    }
  }

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
    const objectiveInput = document.getElementById('intel-objective');
    const planBtn = document.getElementById('intel-plan-btn');
    const planCard = document.getElementById('intel-plan-card');
    const summaryEl = document.getElementById('intel-summary');
    const tasksEl = document.getElementById('intel-tasks');
    const errEl = document.getElementById('intel-objective-error');
    const openCampaignsBtn = document.getElementById('intel-open-campaigns');

    if (!TP) {
      if (planBtn) planBtn.disabled = true;
    }

    if (planBtn && objectiveInput) {
      planBtn.addEventListener('click', () => {
        errEl.textContent = '';
        const text = objectiveInput.value.trim();
        if (!text) { errEl.textContent = 'Saisis un objectif d\'abord.'; return; }
        if (!TP) { errEl.textContent = 'Moteur TaskParser indisponible.'; return; }
        try {
          const doc = TP.parseObjective({ text, user: { engine: 'ZERO_VPS' } });
          const runId = 'uv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
          const tasks = TP.planToTasks(doc, { engine: 'ZERO_VPS', runId });
          summaryEl.innerHTML = escapeHtml(doc.summary)
            + ' <span class="badge">' + doc.plan.length + ' étapes</span>'
            + ' <span class="badge">reach ~' + (doc.estimatedReach || 0) + ' prosps</span>';
          renderTasks(tasksEl, doc.plan, runId);
          planCard.style.display = 'block';
        } catch (e) {
          errEl.textContent = 'Erreur : ' + e;
        }
      });
    }

    if (openCampaignsBtn) {
      openCampaignsBtn.addEventListener('click', () => {
        const navBtn = document.querySelector('.nav button[data-screen="campaigns"]');
        if (navBtn) navBtn.click();
      });
    }

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