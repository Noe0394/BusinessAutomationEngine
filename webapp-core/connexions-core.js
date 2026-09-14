// Page Connexions - statut/déconnexion des deux moteurs + historique.
// Code PARTAGÉ : n'appelle jamais directement une API plateforme, seulement
// window.CyrusEngine/CyrusStore (voir adapters/CONTRACT.md).
(function () {
  const engine = window.CyrusEngine;
  const store = window.CyrusStore;
  const escapeHtml = window.CyrusEscapeHtml;

  function renderStatus(channel, data) {
    const dot = document.getElementById(channel === 'whatsapp' ? 'wa-dot' : 'tg-dot');
    const text = document.getElementById(channel === 'whatsapp' ? 'wa-status-text' : 'tg-status-text');
    dot.classList.toggle('on', !!data.connected);
    if (data.connected) {
      text.textContent = 'Connecté';
    } else if (data.configured === false) {
      text.textContent = 'Non configuré';
    } else if (data.error) {
      text.textContent = 'Erreur : ' + data.error;
    } else {
      text.textContent = 'Non connecté';
    }

    const slot = document.getElementById(channel === 'whatsapp' ? 'wa-connect-slot' : 'tg-connect-slot');
    if (data.connected) {
      slot.innerHTML = '';
    } else if (data.qrImage) {
      slot.innerHTML = '<img src="' + data.qrImage + '" alt="QR code" />';
    }
    // Sinon (pas connecté, pas de QR) : laisse la place à
    // CyrusEngine.mountConnectUI (formulaire desktop, ou rien sur mobile où
    // la WebView native se positionne par-dessus ce slot).
  }

  async function refreshStatus(channel) {
    const data = await engine.getStatus(channel).catch(() => ({ connected: false }));
    renderStatus(channel, data);
  }

  ['whatsapp', 'telegram'].forEach((channel) => {
    refreshStatus(channel);
    engine.onStateChange(channel, (data) => renderStatus(channel, data));
    engine.mountConnectUI(channel, document.getElementById(channel === 'whatsapp' ? 'wa-connect-slot' : 'tg-connect-slot'));
  });

  // En Mode Local sans extension, logout() n'a structurellement rien à
  // déconnecter (aucune session réelle tenue par l'onglet) — sans retour
  // visuel, le clic paraissait ne rien faire du tout (signalé par
  // l'utilisateur : boutons "morts", tapés plusieurs fois de suite en vain).
  // On affiche donc systématiquement une confirmation, même no-op.
  function wireLogout(channel, btnId, feedbackId) {
    const btn = document.getElementById(btnId);
    const feedback = document.getElementById(feedbackId);
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      feedback.style.display = 'none';
      try {
        await engine.logout(channel);
        feedback.textContent = '✅ Déconnecté.';
      } catch (e) {
        feedback.textContent = 'Erreur : ' + e;
      }
      feedback.style.display = 'block';
      await refreshStatus(channel);
      btn.disabled = false;
      setTimeout(() => { feedback.style.display = 'none'; }, 4000);
    });
  }
  wireLogout('whatsapp', 'wa-logout-btn', 'wa-logout-feedback');
  wireLogout('telegram', 'tg-logout-btn', 'tg-logout-feedback');

  function formatRelative(ts) {
    const diffMs = Date.now() - new Date(ts).getTime();
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return "à l'instant";
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60);
    if (h < 24) return h + ' h';
    return Math.floor(h / 24) + ' j';
  }

  async function refreshHistory() {
    const entries = await store.getSentLog(null, 100).catch(() => []);
    const el = document.getElementById('history-list');
    el.innerHTML = '';
    if (entries.length === 0) {
      el.innerHTML = '<p class="empty" style="padding:8px 0;">Aucun envoi tracé pour l\'instant.</p>';
      return;
    }
    entries.forEach((entry) => {
      const row = document.createElement('div');
      row.className = 'list-row';
      const channelLabel = entry.channel === 'telegram' ? '✈️' : '🚀';
      const sourceLabel = entry.source === 'campaign' ? 'campagne' : 'manuel';
      row.innerHTML =
        '<span>' + channelLabel + ' ' + escapeHtml(entry.identifier) + '</span>' +
        '<span style="color:var(--text-dim); font-size:12px;">' + sourceLabel + ' — il y a ' + formatRelative(entry.sentAt) + '</span>';
      el.appendChild(row);
    });
  }

  document.getElementById('history-refresh-btn').addEventListener('click', refreshHistory);
  refreshHistory();
})();
