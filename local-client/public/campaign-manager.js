// Gestionnaire unifie de campagnes port? du dashboard VPS, API locale.
    const CMP_STATE_LABELS = {
      draft: 'Brouillon', scheduled: 'Programmée', running: 'En cours', paused: 'En pause',
      protection_triggered: 'Protection détectée', waiting: 'En attente', manual_fallback: 'Mode continuité',
      completed: 'Terminée', cancelled: 'Annulée', error: 'Erreur',
    };
    const CMP_STATUS_LABELS = {
      pending: 'En attente', processing: 'En cours', sent: 'Envoyé', failed: 'Échec', skipped: 'Ignoré',
      manual_pending: 'Manuel : en attente', manual_processing: 'Manuel : en cours', manual_sent: 'Envoyé (manuel)',
      valid: 'Valide', duplicate: 'Doublon', invalid: 'Invalide', uncertain: 'Incertain',
    };
    const cmpState = { recipientsId: null, mediaFileId: null, openId: null, timer: null };

    function cmpEl(tag, text, attrs) {
      const el = document.createElement(tag);
      if (text != null) el.textContent = text;
      Object.entries(attrs || {}).forEach(([k, v]) => { el.setAttribute(k, v); });
      return el;
    }
    function cmpFeedback(msg, isError) {
      const box = document.getElementById('cmp-feedback');
      box.textContent = msg || '';
      box.style.color = isError ? '#ef4444' : '#22c55e';
    }
    async function cmpJson(url, options) {
      const res = await localApiFetch(url, options);
      let data = {};
      try { data = await res.json(); } catch (e) { data = {}; }
      if (!res.ok) throw new Error(data.error || ('Erreur ' + res.status));
      return data;
    }
    function cmpPostJson(url, body) {
      return cmpJson(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    }

    function cmpRenderCounts(counts) {
      const wrap = cmpEl('div', null, { class: 'cmp-counts' });
      [['Total importé', counts.total], ['Valides', counts.valid], ['Doublons', counts.duplicate], ['Invalides', counts.invalid], ['Incertains', counts.uncertain]]
        .forEach(([l, v]) => wrap.appendChild(cmpEl('span', l + ' : ' + v, { class: 'cmp-chip' })));
      return wrap;
    }
    function cmpRenderRows(rows, cols) {
      const scroll = cmpEl('div', null, { class: 'cmp-scroll' });
      const table = cmpEl('table');
      const head = cmpEl('tr');
      cols.forEach((c) => head.appendChild(cmpEl('th', c.label)));
      table.appendChild(head);
      rows.forEach((r) => {
        const tr = cmpEl('tr');
        cols.forEach((c) => {
          const raw = r[c.key];
          const v = c.map ? c.map(raw) : raw;
          tr.appendChild(cmpEl('td', v == null ? '' : String(v)));
        });
        table.appendChild(tr);
      });
      scroll.appendChild(table);
      return scroll;
    }

    async function cmpUploadMedia() {
      const file = document.getElementById('cmp-media').files[0];
      if (!file) return null;
      const data = await cmpJson('/api/campaigns/media', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: file.name, type: file.type, base64: await cmpReadBase64(file) }) });
      return data.id;
    }

    // Liste PAR DÉFAUT : la liste unique (Excel, collage, photo) devient la liste de destinataires de la campagne, sans nouvelle analyse.
    async function cmpSyncDefaultRecipients() {
      const text = document.getElementById('cmp-recipients').value.trim();
      const file = document.getElementById('cmp-recipients-file').files[0];
      const payload = {};
      if (file) { const source = { name: file.name, type: file.type, base64: await cmpReadBase64(file) }; if (file.type.startsWith('image/')) payload.image = source; else payload.file = source; }
      else if (text) payload.text = text;
      else throw new Error('Collez une liste ou choisissez un fichier de destinataires.');
      const data = await cmpJson('/api/campaigns/recipients', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      cmpState.recipientsId = data.recipientsId;
      const preview = document.getElementById('cmp-recipient-preview');
      preview.textContent = '';
      preview.appendChild(cmpRenderCounts(data.counts));
      preview.appendChild(cmpRenderRows(data.rows || [], [{ key: 'name', label: 'Nom' }, { key: 'number', label: 'Numero' }, { key: 'state', label: 'Statut', map: value => CMP_STATUS_LABELS[value] || value }, { key: 'reason', label: 'Motif' }]));
      cmpFeedback('Liste analys?e ? total ' + data.counts.total + ', valides ' + data.counts.valid + ', doublons ' + data.counts.duplicate + ', invalides ' + data.counts.invalid + ', incertains ' + data.counts.uncertain, false);
      return true;
    }
    function cmpReadBase64(file) { if (file.size > 10 * 1024 * 1024) return Promise.reject(new Error('Fichier limité à 10 Mo.')); return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1] || ''); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); }); }

    async function cmpCreate(mode) {
      cmpFeedback('', false);
      try {
        await cmpSyncDefaultRecipients();
        if (!cmpState.recipientsId) throw new Error('Aucune liste de destinataires : chargez un fichier Excel/CSV, collez une liste ou photographiez-la.');
        const body = {
          name: document.getElementById('cmp-name').value.trim(),
          channel: document.getElementById('cmp-channel').value,
          text: document.getElementById('cmp-text').value.trim(),
          recipientsId: cmpState.recipientsId,
          mediaFileId: await cmpUploadMedia(),
        };
        const when = document.getElementById('cmp-when').value;
        if (mode === 'schedule') {
          if (!when) throw new Error('Choisissez la date et l\'heure de programmation.');
          body.scheduledAt = new Date(when).toISOString();
        }
        let camp = await cmpPostJson('/api/campaigns', body);
        if (mode === 'launch') camp = await cmpPostJson('/api/campaigns/' + encodeURIComponent(camp.id) + '/launch', {});
        cmpFeedback(mode === 'launch' ? 'Campagne lancée : ' + camp.name : (mode === 'schedule' ? 'Campagne programmée : ' + camp.name : 'Campagne créée (brouillon) : ' + camp.name), false);
        cmpRefreshList();
      } catch (err) {
        if (err.message !== 'unauthorized') cmpFeedback(err.message, true);
      }
    }

    function cmpProgressBar(p) {
      const bar = cmpEl('div', null, { class: 'cmp-bar' });
      const inner = cmpEl('div');
      inner.style.width = Math.min(100, (p && p.percent) || 0) + '%';
      bar.appendChild(inner);
      return bar;
    }

    async function cmpAction(id, action) {
      try { await cmpPostJson('/api/campaigns/' + encodeURIComponent(id) + '/' + action, {}); }
      catch (err) { if (err.message !== 'unauthorized') cmpFeedback(err.message, true); }
      cmpRefreshList();
      if (cmpState.openId === id) cmpOpen(id);
    }

    async function cmpDownloadReport(id) {
      try {
        const r = await cmpJson('/api/campaigns/' + encodeURIComponent(id) + '/report');
        const blob = new Blob([r.csv], { type: 'text/csv;charset=utf-8' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'campagne-' + (r.name || r.id) + '.csv';
        a.click();
      } catch (err) { if (err.message !== 'unauthorized') cmpFeedback(err.message, true); }
    }

    function cmpButton(label, fn) {
      const b = cmpEl('button', label, { type: 'button' });
      b.addEventListener('click', fn);
      return b;
    }

    async function cmpRefreshList() {
      const box = document.getElementById('cmp-list');
      try {
        const data = await cmpJson('/api/campaigns');
        box.textContent = '';
        data.campaigns = data.campaigns.filter((c) => String(c.channel).toUpperCase() === document.getElementById('cmp-channel').value);
        if (!data.campaigns.length) { box.appendChild(cmpEl('p', 'Aucune campagne pour le moment.')); return; }
        data.campaigns.forEach((c) => {
          const card = cmpEl('div', null, { class: 'cmp-box' });
          card.style.marginBottom = '8px';
          const head = cmpEl('div');
          head.appendChild(cmpEl('strong', c.name || c.id));
          head.appendChild(document.createTextNode(' · ' + c.channel + ' '));
          head.appendChild(cmpEl('span', CMP_STATE_LABELS[c.state] || c.state, { class: 'cmp-badge' }));
          card.appendChild(head);
          if (c.progress) {
            card.appendChild(cmpProgressBar(c.progress));
            card.appendChild(cmpEl('div', c.progress.sent + ' / ' + c.progress.total + ' envoyés · ' + c.progress.failed + ' échecs · ' + c.progress.pending + ' en attente · ' + c.progress.percent + ' %', { style: 'font-size:.85rem;margin-top:4px' }));
          } else if (c.recipients) {
            card.appendChild(cmpEl('div', c.recipients.valid + ' destinataire(s) valide(s)', { style: 'font-size:.85rem' }));
          }
          if (c.state === 'scheduled' && c.scheduledAt) card.appendChild(cmpEl('div', 'Départ prévu : ' + new Date(c.scheduledAt).toLocaleString(), { style: 'font-size:.85rem' }));
          if (c.state === 'protection_triggered') card.appendChild(cmpEl('div', 'Protection détectée : reprise automatique dans ~' + Math.max(1, Math.round((c.retryAfterSeconds || 0) / 60)) + ' min. Restants : ' + ((c.progress && c.progress.remaining) || 0), { style: 'font-size:.85rem;color:#f59e0b' }));
          if (c.state === 'manual_fallback') card.appendChild(cmpEl('div', 'Mode continuité : la file de relance manuelle contient les destinataires restants (onglet « Relance Manuelle Express »).', { style: 'font-size:.85rem;color:#f59e0b' }));
          const actions = cmpEl('div', null, { class: 'cmp-actions' });
          actions.appendChild(cmpButton('Détail', () => cmpOpen(c.id)));
          if (['draft', 'scheduled'].includes(c.state)) actions.appendChild(cmpButton('Lancer', () => cmpAction(c.id, 'launch')));
          if (['running', 'waiting', 'protection_triggered', 'manual_fallback'].includes(c.state)) actions.appendChild(cmpButton('Pause', () => cmpAction(c.id, 'pause')));
          if (c.state === 'paused') actions.appendChild(cmpButton('Reprendre', () => cmpAction(c.id, 'resume')));
          if (!['completed', 'cancelled', 'error'].includes(c.state)) actions.appendChild(cmpButton('Annuler', () => { if (confirm('Annuler cette campagne ? Les messages déjà envoyés ne peuvent pas être annulés.')) cmpAction(c.id, 'cancel'); }));
          actions.appendChild(cmpButton('Rapport CSV', () => cmpDownloadReport(c.id)));
          card.appendChild(actions);
          box.appendChild(card);
        });
      } catch (err) { if (err.message !== 'unauthorized') box.textContent = err.message; }
    }

    async function cmpOpen(id) {
      cmpState.openId = id;
      const box = document.getElementById('cmp-detail');
      try {
        const c = await cmpJson('/api/campaigns/' + encodeURIComponent(id) + '?limit=200');
        box.hidden = false;
        box.textContent = '';
        box.appendChild(cmpEl('h3', (c.name || c.id) + ' — ' + (CMP_STATE_LABELS[c.state] || c.state)));
        if (c.progress) {
          box.appendChild(cmpProgressBar(c.progress));
          box.appendChild(cmpEl('p', 'Total : ' + c.progress.total + ' · Envoyés : ' + c.progress.sent + ' · En attente : ' + c.progress.pending + ' · Échecs : ' + c.progress.failed + ' · Ignorés : ' + c.progress.skipped + ' · Progression : ' + c.progress.percent + ' %'));
        }
        if (c.fallback) box.appendChild(cmpEl('p', 'Continuité : ' + (c.fallback.status === 'manual_fallback' ? 'active' : 'terminée') + ' (' + c.fallback.events + ' événement(s) de protection)'));
        if (c.warning) box.appendChild(cmpEl('p', c.warning));
        box.appendChild(cmpRenderRows(c.recipientRows || [], [
          { key: 'name', label: 'Nom' }, { key: 'number', label: 'Numéro' },
          { key: 'status', label: 'Statut', map: (s) => CMP_STATUS_LABELS[s] || s },
          { key: 'lastAttemptAt', label: 'Dernière tentative', map: (t) => (t ? new Date(t).toLocaleString() : '') }, { key: 'error', label: 'Erreur' },
        ]));
        box.appendChild(cmpButton('Fermer', () => { cmpState.openId = null; box.hidden = true; }));
      } catch (err) { if (err.message !== 'unauthorized') { box.hidden = false; box.textContent = err.message; } }
    }

    function cmpMount(channel) {
      document.getElementById('cmp-channel').value = channel;
      const media = document.getElementById('cmp-media');
      media.previousElementSibling.style.display = media.style.display = channel === 'TELEGRAM' ? 'none' : '';
      cmpState.openId = null; document.getElementById('cmp-detail').hidden = true; cmpInit();
    }
    function cmpInit() {
      if (!cmpState.wired) {
        cmpState.wired = true;
        document.getElementById('cmp-channel').addEventListener('change', () => { cmpState.recipientsId = null; cmpRefreshList(); const m = document.getElementById('cmp-media'); m.previousElementSibling.style.display = m.style.display = document.getElementById('cmp-channel').value === 'TELEGRAM' ? 'none' : ''; });

        document.getElementById('cmp-prepare').addEventListener('click', () => cmpSyncDefaultRecipients().catch(err => cmpFeedback(err.message, true)));
        document.getElementById('cmp-create').addEventListener('click', () => cmpCreate('draft'));
        document.getElementById('cmp-schedule').addEventListener('click', () => cmpCreate('schedule'));
        document.getElementById('cmp-launch').addEventListener('click', () => cmpCreate('launch'));
      }
      cmpRefreshList();
      if (cmpState.timer) clearInterval(cmpState.timer);
      // Suivi quasi temps réel tant que l'onglet est affiché.
      cmpState.timer = setInterval(() => {
        const panel = document.getElementById('cmp-shell').closest('.tab');
        if (!panel.classList.contains('active')) { clearInterval(cmpState.timer); cmpState.timer = null; return; }
        cmpRefreshList();
        if (cmpState.openId) cmpOpen(cmpState.openId);
      }, 5000);
    }


window.cmpInit = cmpInit;
