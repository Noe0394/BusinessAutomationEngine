// Relance Manuelle Express - câblage DOM (webapp-core, mode navigateur).
// Portage de mobile/webapp/www/relance.js : les IDs de #screen-relance
// dans index.html sont identiques. Différences assumées vs mobile :
//   - window.open(url, '_blank') au lieu de '_system' (navigateur standard,
//     pas de WebView Capacitor — le popup s'ouvre dans un nouvel onglet);
//   - s'appuie sur window.Cyrus.manualRelance (webapp-core/lib/manualRelance.js)
//     branché sur le CONTRAT CyrusStore, pas sur le store mobile brut.
(function () {
  'use strict';
  const relance = window.Cyrus.manualRelance;

  function channel() {
    return document.getElementById('relance-channel').value;
  }

  function getVariantTexts() {
    return ['relance-variant-a', 'relance-variant-b', 'relance-variant-c']
      .map(function (id) { return document.getElementById(id).value.trim(); })
      .filter(Boolean);
  }

  function getIntention() {
    return document.getElementById('relance-intention').value.trim();
  }

  function currentOpts() {
    return { variants: getVariantTexts(), intention: getIntention() };
  }

  function feedback(message, isError) {
    const el = document.getElementById('relance-feedback');
    el.textContent = message;
    el.style.display = 'block';
    el.className = isError ? 'error' : '';
    el.style.color = isError ? '' : 'var(--green)';
  }

  function hideFeedback() {
    document.getElementById('relance-feedback').style.display = 'none';
  }

  // ---------- Compteur de rythme ----------
  let rhythmTimerId = null;

  function formatElapsed(ms) {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m > 0 ? (m + 'min ' + String(s).padStart(2, '0') + 's') : (s + 's');
  }

  function updateRhythmDisplay() {
    const el = document.getElementById('relance-rhythm-counter');
    if (!relance.state.sessionStartAt || relance.state.sentCount === 0) { el.style.display = 'none'; return; }
    const elapsedMs = Date.now() - relance.state.sessionStartAt;
    const elapsedMin = elapsedMs / 60000;
    const rate = elapsedMin > 0 ? (relance.state.sentCount / elapsedMin) : 0;
    el.style.display = 'block';
    el.textContent = '⏱️ ' + relance.state.sentCount + ' message(s) traité(s) en ' + formatElapsed(elapsedMs) + ' — Rythme : ' + rate.toFixed(1) + ' msg/min';
  }

  function stopRhythmTimer() {
    if (rhythmTimerId) { clearInterval(rhythmTimerId); rhythmTimerId = null; }
  }

  function startRhythmTimer() {
    stopRhythmTimer();
    updateRhythmDisplay();
    rhythmTimerId = setInterval(updateRhythmDisplay, 1000);
  }

  // ---------- Mode Série Continu ----------
  const seriesState = { active: false, running: false, tempoSeconds: 8, timerId: null, remaining: 0 };

  function seriesClearTimer() {
    if (seriesState.timerId) { clearInterval(seriesState.timerId); seriesState.timerId = null; }
  }

  function seriesUpdateCountdownLabel() {
    const el = document.getElementById('relance-series-countdown');
    if (!seriesState.active || !seriesState.running) { el.style.display = 'none'; return; }
    el.style.display = 'block';
    el.textContent = seriesState.remaining > 0
      ? ('⏱️ Contact suivant dans ' + seriesState.remaining + 's...')
      : '⚡ Envoi en cours...';
  }

  function seriesArmCountdown() {
    seriesClearTimer();
    if (!seriesState.active || !seriesState.running) { seriesUpdateCountdownLabel(); return; }
    if (relance.state.cursor >= relance.state.items.length) return;

    seriesState.remaining = seriesState.tempoSeconds;
    seriesUpdateCountdownLabel();
    seriesState.timerId = setInterval(function () {
      seriesState.remaining -= 1;
      if (seriesState.remaining <= 0) {
        seriesClearTimer();
        seriesUpdateCountdownLabel();
        launchCurrent(true);
      } else {
        seriesUpdateCountdownLabel();
      }
    }, 1000);
  }

  // ---------- Rendu de la carte ----------
  function renderCard() {
    const card = document.getElementById('relance-card');
    const empty = document.getElementById('relance-empty');
    const items = relance.state.items;
    const cursor = relance.state.cursor;

    if (!items.length || cursor >= items.length) {
      card.style.display = 'none';
      empty.style.display = 'block';
      empty.textContent = items.length
        ? ('Tous les contacts de la file ont été traités (' + items.length + '/' + items.length + ').')
        : 'Aucun contact en attente ou en échec à relancer pour le moment.';
      seriesClearTimer();
      updateRhythmDisplay();
      stopRhythmTimer();
      return;
    }

    empty.style.display = 'none';
    card.style.display = 'block';

    const item = items[cursor];
    document.getElementById('relance-counter').textContent = cursor + ' / ' + items.length + ' traités — Contact ' + (cursor + 1) + '/' + items.length;
    document.getElementById('relance-status-badge').textContent = item.status;

    const identifier = item.isPhone ? item.phone : ('@' + item.username);
    document.getElementById('relance-contact-label').textContent = item.name ? (item.name + ' — ' + identifier) : identifier;

    if (typeof item.renderedMessage !== 'string') {
      item.renderedMessage = relance.computeMessageForItem(item, cursor, currentOpts());
    }
    document.getElementById('relance-message-text').value = item.renderedMessage;

    const notice = document.getElementById('relance-prefill-notice');
    if (relance.state.channel === 'telegram') {
      notice.textContent = '⚠️ Telegram ne pré-remplit pas le texte : il est copié dans le presse-papiers — collez-le (appui long) une fois la conversation ouverte.';
      notice.style.color = 'var(--red)';
    } else {
      notice.textContent = '✅ Le texte s\'affiche automatiquement dans le champ de saisie WhatsApp à l\'ouverture.';
      notice.style.color = 'var(--green)';
    }

    const callBtn = document.getElementById('relance-call-btn');
    callBtn.disabled = !item.phone;
    callBtn.onclick = item.phone ? function () { window.location.href = 'tel:' + item.phone; } : null;

    seriesArmCountdown();
  }

  function refreshCurrentMessage() {
    const item = relance.current();
    if (!item) return;
    item.renderedMessage = relance.computeMessageForItem(item, relance.state.cursor, currentOpts());
    document.getElementById('relance-message-text').value = item.renderedMessage;
  }

  function prerenderAllAndRender() {
    relance.prerenderAll(currentOpts());
    renderCard();
  }

  // ---------- Chargement / import ----------
  async function loadQueue() {
    const btn = document.getElementById('relance-reload-btn');
    btn.disabled = true;
    hideFeedback();
    try {
      await relance.loadQueue(channel());
      document.getElementById('relance-series-panel').style.display = relance.state.items.length === 0 ? 'none' : 'block';
      prerenderAllAndRender();
      if (relance.state.items.length > 0) startRhythmTimer();
    } catch (err) {
      feedback('Échec du chargement de la file d\'attente : ' + err, true);
    } finally {
      btn.disabled = false;
    }
  }

  document.getElementById('relance-channel').addEventListener('change', loadQueue);
  document.getElementById('relance-reload-btn').addEventListener('click', loadQueue);

  document.getElementById('relance-import-file').addEventListener('change', async function (e) {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;

    const variants = getVariantTexts();
    const template = variants.length ? variants[0] : getIntention();
    if (!template) {
      feedback('Renseignez "Mon Intention de Campagne" (ou une variante A/B/C) avant d\'importer un fichier — c\'est le message qui sera envoyé.', true);
      return;
    }

    const btn = document.getElementById('relance-reload-btn');
    btn.disabled = true;
    feedback('📂 Import du fichier en cours...', false);
    try {
      const result = await relance.importContactsFile(channel(), file, template);
      document.getElementById('relance-series-panel').style.display = result.items.length === 0 ? 'none' : 'block';
      prerenderAllAndRender();
      if (result.items.length > 0) startRhythmTimer();
      const skipped = result.skippedDuplicates || 0;
      feedback('✅ ' + result.items.length + ' contact(s) importé(s)' + (skipped ? (' (' + skipped + ' doublon(s) des dernières 48h ignoré(s))') : '') + '.', false);
    } catch (err) {
      feedback('Échec de l\'import du fichier : ' + err, true);
    } finally {
      btn.disabled = false;
    }
  });

  ['relance-variant-a', 'relance-variant-b', 'relance-variant-c'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', prerenderAllAndRender);
  });
  document.getElementById('relance-intention').addEventListener('change', refreshCurrentMessage);

  document.getElementById('relance-regenerate-btn').addEventListener('click', function () {
    if (!getIntention()) {
      feedback('Renseignez d\'abord "Mon Intention de Campagne" pour activer le générateur.', true);
      return;
    }
    refreshCurrentMessage();
  });

  document.getElementById('relance-copy-btn').addEventListener('click', async function () {
    const text = document.getElementById('relance-message-text').value;
    try {
      await navigator.clipboard.writeText(text);
      feedback('Texte copié dans le presse-papiers.', false);
    } catch (err) {
      feedback('Impossible de copier automatiquement — sélectionnez et copiez le texte manuellement.', true);
    }
  });

  // ---------- Envoi / suivant ----------
  async function launchCurrent(auto) {
    const item = relance.current();
    if (!item) return;
    const text = document.getElementById('relance-message-text').value;

    try { await navigator.clipboard.writeText(text); } catch (err) { /* non bloquant */ }
    const opened = window.open(relance.buildDeepLink(item, text), '_blank');
    if (auto && !opened) {
      seriesArmCountdown(); // popup bloqué : la série attend un clic manuel
      feedback('Le lien ne semble pas s\'être ouvert automatiquement. Série en pause — utilisez "Envoyer & Suivant" pour continuer.', true);
      return;
    }

    await relance.markCurrentSent();
    updateRhythmDisplay();
    renderCard();
  }

  document.getElementById('relance-launch-btn').addEventListener('click', function () { launchCurrent(false); });
  document.getElementById('relance-skip-btn').addEventListener('click', function () {
    seriesClearTimer();
    relance.skipCurrent();
    renderCard();
  });

  document.getElementById('relance-series-toggle').addEventListener('change', function (e) {
    seriesState.active = e.target.checked;
    seriesState.running = e.target.checked;
    document.getElementById('relance-series-tempo-field').style.display = e.target.checked ? 'block' : 'none';
    document.getElementById('relance-series-pause-btn').style.display = e.target.checked ? 'block' : 'none';
    document.getElementById('relance-series-pause-btn').textContent = '⏸️ Pause la série';
    seriesArmCountdown();
  });

  document.getElementById('relance-series-tempo').addEventListener('input', function (e) {
    seriesState.tempoSeconds = parseInt(e.target.value, 10) || 8;
    document.getElementById('relance-series-tempo-value').textContent = seriesState.tempoSeconds + 's';
  });

  document.getElementById('relance-series-pause-btn').addEventListener('click', function () {
    const btn = document.getElementById('relance-series-pause-btn');
    seriesState.running = !seriesState.running;
    btn.textContent = seriesState.running ? '⏸️ Pause la série' : '▶️ Reprendre la série';
    seriesArmCountdown();
  });

  // Raccourcis clavier (espace = envoyer, → = ignorer) quand l'onglet relance
  // est actif et hors saisie texte.
  document.addEventListener('keydown', function (e) {
    const screen = document.getElementById('screen-relance');
    if (!screen.classList.contains('active')) return;
    const activeTag = document.activeElement ? document.activeElement.tagName : '';
    if (activeTag === 'INPUT' || activeTag === 'TEXTAREA') return;
    if (document.getElementById('relance-card').style.display === 'none') return;
    if (e.code === 'Space') { e.preventDefault(); launchCurrent(false); }
    else if (e.code === 'ArrowRight') {
      e.preventDefault();
      seriesClearTimer();
      relance.skipCurrent();
      renderCard();
    }
  });
})();