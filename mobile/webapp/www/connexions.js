// Page "Connexions" unifiée - statut + déconnexion des deux moteurs (voir
// app.js#logoutWhatsApp/logoutTelegram, exposées via window.Cyrus.connections)
// et historique des envois (lib/db.js#getSentLog, déjà alimenté par
// campaign.js et lib/manualRelance.js).
(function () {
  const db = window.Cyrus.db;

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function formatRelative(ts) {
    const diffMs = Date.now() - ts;
    const min = Math.floor(diffMs / 60000);
    if (min < 1) return "à l'instant";
    if (min < 60) return min + ' min';
    const h = Math.floor(min / 60);
    if (h < 24) return h + ' h';
    return Math.floor(h / 24) + ' j';
  }

  function renderHistory() {
    db.getSentLog(null, 100).then(function (entries) {
      const el = document.getElementById('conn-history-list');
      el.innerHTML = '';
      if (entries.length === 0) {
        el.innerHTML = '<p class="empty" style="padding:4px 0;">Aucun envoi tracé pour l\'instant.</p>';
        return;
      }
      entries.forEach(function (entry) {
        const row = document.createElement('div');
        row.className = 'chat-row';
        row.style.padding = '6px 0';
        const channelLabel = entry.channel === 'telegram' ? '✈️' : '🚀';
        const sourceLabel = entry.source === 'campaign' ? 'campagne' : 'manuel';
        row.innerHTML =
          '<div class="chat-body"><div class="chat-peer">' + channelLabel + ' ' + escapeHtml(entry.identifier) + '</div>' +
          '<div class="chat-preview">' + sourceLabel + ' — il y a ' + formatRelative(entry.sentAt) + '</div></div>';
        el.appendChild(row);
      });
    });
  }

  document.getElementById('conn-wa-logout-btn').addEventListener('click', function () {
    window.Cyrus.connections.logoutWhatsApp();
  });
  document.getElementById('conn-tg-logout-btn').addEventListener('click', function () {
    window.Cyrus.connections.logoutTelegram();
  });
  document.getElementById('conn-history-refresh-btn').addEventListener('click', renderHistory);

  renderHistory();
})();
