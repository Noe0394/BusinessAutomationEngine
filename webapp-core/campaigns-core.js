// Moteur de campagnes - code PARTAGÉ (voir adapters/CONTRACT.md). N'appelle
// jamais directement une API plateforme : import/extraction de contacts,
// Spintax + personnalisation (lib/), envoi séquentiel avec tempo aléatoire,
// délégué à CyrusEngine.sendMessage/CyrusStore pour tout ce qui touche à la
// plateforme réelle.
(function () {
  const engine = window.CyrusEngine;
  const store = window.CyrusStore;
  const personalization = window.Cyrus.personalization;
  const escapeHtml = window.CyrusEscapeHtml;

  let runningCampaignId = null;
  let stopRequested = false;

  function channel() {
    return document.getElementById('camp-channel').value;
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomDelayMs() {
    const min = Math.max(1, parseInt(document.getElementById('camp-delay-min').value, 10) || 8);
    const max = Math.max(min, parseInt(document.getElementById('camp-delay-max').value, 10) || 20);
    return (min + Math.random() * (max - min)) * 1000;
  }

  function setStatus(text) {
    document.getElementById('camp-status').textContent = text;
  }

  function setProgress(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    document.getElementById('camp-progress-fill').style.width = pct + '%';
  }

  async function refreshContactsCount() {
    const contacts = await store.getContacts(channel());
    const el = document.getElementById('camp-contacts-count');
    el.textContent = contacts.length > 0
      ? contacts.length + ' contact(s) importé(s) pour ' + channel() + '.'
      : 'Aucun contact importé.';
  }

  // ---------- Liste noire ----------
  async function renderBlocklist() {
    const blocked = await store.getBlocklist(channel());
    const el = document.getElementById('blocklist-list');
    el.innerHTML = '';
    if (blocked.length === 0) {
      el.innerHTML = '<p class="empty" style="padding:4px 0;">Aucun contact bloqué pour ce canal.</p>';
      return;
    }
    blocked.forEach((b) => {
      const row = document.createElement('div');
      row.className = 'list-row';
      const label = document.createElement('span');
      label.textContent = b.identifier;
      const removeBtn = document.createElement('button');
      removeBtn.className = 'plain';
      removeBtn.textContent = 'Retirer';
      removeBtn.addEventListener('click', () => store.removeFromBlocklist(channel(), b.identifier).then(renderBlocklist));
      row.appendChild(label);
      row.appendChild(removeBtn);
      el.appendChild(row);
    });
  }

  document.getElementById('blocklist-add-btn').addEventListener('click', async () => {
    const input = document.getElementById('blocklist-add-input');
    const raw = input.value.trim();
    if (!raw) return;
    const identifier = raw.startsWith('@') ? raw : raw.replace(/\D/g, '');
    if (!identifier) return;
    await store.addToBlocklist(channel(), identifier);
    input.value = '';
    renderBlocklist();
  });

  // ---------- Import fichier ----------
  document.getElementById('camp-file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      const parsed = await window.Cyrus.contactsImport.parseContactsFile(file);
      const kept = await store.filterBlocked(channel(), parsed);
      await store.putContacts(channel(), kept);
      await refreshContactsCount();
      const blocked = parsed.length - kept.length;
      if (blocked > 0) alert(blocked + ' contact(s) exclu(s) car présent(s) dans la liste noire.');
    } catch (err) {
      alert('Erreur import : ' + err);
    }
  });

  // ---------- Extraction depuis un groupe ----------
  document.getElementById('camp-list-groups-btn').addEventListener('click', async () => {
    const el = document.getElementById('camp-groups-list');
    el.innerHTML = '<p class="empty" style="padding:8px 0;">Chargement...</p>';
    try {
      const groups = await engine.getGroups(channel());
      renderGroups(groups);
    } catch (err) {
      el.innerHTML = '<p class="empty" style="padding:8px 0;">Échec : ' + escapeHtml(err.message || err) + '</p>';
    }
  });

  function slugify(s) {
    return String(s || 'groupe').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'groupe';
  }

  function renderGroups(groups) {
    const el = document.getElementById('camp-groups-list');
    el.innerHTML = '';
    if (!groups || groups.length === 0) {
      el.innerHTML = '<p class="empty" style="padding:8px 0;">Aucun groupe trouvé.</p>';
      return;
    }
    groups.forEach((g) => {
      const row = document.createElement('div');
      row.className = 'list-row';
      const label = document.createElement('span');
      label.textContent = g.name || g.id;

      const actions = document.createElement('div');
      actions.className = 'row';
      actions.style.flex = '0 0 auto';

      const importBtn = document.createElement('button');
      importBtn.className = 'plain';
      importBtn.textContent = 'Importer';
      importBtn.addEventListener('click', async () => {
        const members = await engine.getGroupMembers(channel(), g.id);
        const kept = await store.filterBlocked(channel(), members.map((m) => ({ identifier: m.id, name: m.name || '' })));
        await store.putContacts(channel(), kept);
        await refreshContactsCount();
        alert(kept.length + ' membre(s) ajouté(s) aux contacts.');
      });

      const exportBtn = document.createElement('button');
      exportBtn.className = 'plain';
      exportBtn.textContent = '📥 Excel';
      exportBtn.addEventListener('click', async () => {
        const members = await engine.getGroupMembers(channel(), g.id);
        const rows = members.map((m) => ({ identifiant: m.id, nom: m.name || '', admin: m.isAdmin ? 'oui' : 'non' }));
        await store.exportRows(rows, 'membres-' + slugify(g.name || g.id), 'xlsx');
      });

      actions.appendChild(importBtn);
      actions.appendChild(exportBtn);
      row.appendChild(label);
      row.appendChild(actions);
      el.appendChild(row);
    });
  }

  // ---------- Aperçu Spintax/personnalisation ----------
  document.getElementById('camp-preview-btn').addEventListener('click', async () => {
    const template = document.getElementById('camp-message').value;
    const contacts = await store.getContacts(channel());
    const source = contacts.length > 0 ? contacts.slice(0, 3) : [{ name: 'Jean', identifier: '22600000000' }];
    const previews = source.map((c) => {
      const vars = personalization.buildPersonalizationVars(c.name, c.identifier);
      return personalization.personalizeMessage(template, vars);
    });
    document.getElementById('camp-preview-result').innerHTML = previews.map((p, i) => (
      '<div style="margin-bottom:6px;">' + (i + 1) + '. ' + escapeHtml(p) + '</div>'
    )).join('');
  });

  // ---------- Moteur d'envoi ----------
  async function runLoop(campaignId) {
    if (runningCampaignId) return;
    runningCampaignId = campaignId;
    stopRequested = false;

    for (;;) {
      const campaign = await store.getCampaign(campaignId);
      if (!campaign || campaign.status !== 'running' || stopRequested) break;

      const nextIndex = campaign.recipients.findIndex((r) => r.status === 'pending');
      const done = campaign.recipients.length - campaign.recipients.filter((r) => r.status === 'pending').length;
      setProgress(done, campaign.recipients.length);

      if (nextIndex === -1) {
        setStatus('Campagne "' + campaign.name + '" terminée (' + campaign.recipients.length + '/' + campaign.recipients.length + ').');
        break;
      }

      const recipient = campaign.recipients[nextIndex];
      const vars = personalization.buildPersonalizationVars(recipient.name, recipient.to);
      const text = personalization.personalizeMessage(campaign.text, vars);

      setStatus('Envoi à ' + (recipient.name || recipient.to) + '... (' + (done + 1) + '/' + campaign.recipients.length + ')');
      const result = await engine.sendMessage(campaign.channel, recipient.to, text).catch((err) => ({ ok: false, error: err.message }));

      campaign.recipients[nextIndex] = Object.assign({}, recipient, { status: result.ok ? 'sent' : 'failed' });
      if (result.ok) await store.recordSent(campaign.channel, recipient.to, 'campaign');
      await store.saveCampaignProgress(campaignId, campaign.recipients);

      const fresh = await store.getCampaign(campaignId);
      if (!fresh || fresh.status !== 'running' || stopRequested) break;

      await sleep(randomDelayMs());
    }

    runningCampaignId = null;
    renderCampaignsList();
  }

  async function handleStartClick() {
    const text = document.getElementById('camp-message').value.trim();
    if (!text) { alert('Message vide.'); return; }

    const latest = await store.getLatestCampaign(channel());
    if (latest && (latest.status === 'running' || latest.status === 'paused')) {
      await store.startCampaign(latest.id);
      renderCampaignsList();
      runLoop(latest.id);
      return;
    }

    const contacts = await store.getContacts(channel());
    if (contacts.length === 0) { alert('Aucun contact importé.'); return; }

    const campaign = await store.createCampaign(channel(), {
      name: 'Campagne ' + new Date().toLocaleString('fr-FR'),
      text: text,
      delayMinMs: Math.max(1000, (parseInt(document.getElementById('camp-delay-min').value, 10) || 8) * 1000),
      delayMaxMs: Math.max(1000, (parseInt(document.getElementById('camp-delay-max').value, 10) || 20) * 1000),
      recipients: contacts.map((c) => ({ identifier: c.identifier, name: c.name })),
    });
    await store.startCampaign(campaign.id);
    renderCampaignsList();
    runLoop(campaign.id);
  }

  document.getElementById('camp-start-btn').addEventListener('click', handleStartClick);
  document.getElementById('camp-pause-btn').addEventListener('click', async () => {
    stopRequested = true;
    const latest = await store.getLatestCampaign(channel());
    if (latest) await store.pauseCampaign(latest.id);
    renderCampaignsList();
  });

  async function campaignAction(id, action) {
    if (action === 'start') { await store.startCampaign(id); runLoop(id); }
    if (action === 'pause') { stopRequested = true; await store.pauseCampaign(id); }
    if (action === 'cancel') { stopRequested = true; await store.cancelCampaign(id); }
    renderCampaignsList();
  }
  window.__campaignAction = campaignAction; // pont minimal pour les boutons générés dynamiquement

  async function renderCampaignsList() {
    const campaigns = await store.listCampaigns(channel());
    const el = document.getElementById('campaigns-list');
    if (campaigns.length === 0) {
      el.innerHTML = '<p class="empty" style="padding:8px 0;">Aucune campagne pour ce canal.</p>';
      return;
    }
    el.innerHTML = campaigns.map((c) => {
      const sent = c.recipients.filter((r) => r.status === 'sent').length;
      const failed = c.recipients.filter((r) => r.status === 'failed').length;
      const total = c.recipients.length;
      const actions = [];
      if (c.status === 'draft' || c.status === 'paused') actions.push('<button class="plain" onclick="__campaignAction(\'' + c.id + '\',\'start\')">Démarrer</button>');
      if (c.status === 'running') actions.push('<button class="plain" onclick="__campaignAction(\'' + c.id + '\',\'pause\')">Pause</button>');
      if (c.status !== 'completed' && c.status !== 'cancelled') actions.push('<button class="plain" onclick="__campaignAction(\'' + c.id + '\',\'cancel\')">Annuler</button>');
      return '<div class="list-row"><span><strong>' + escapeHtml(c.name) + '</strong> — ' + c.status + ' (' + sent + '/' + total + ' envoyés, ' + failed + ' échec(s))</span><span>' + actions.join(' ') + '</span></div>';
    }).join('');
  }

  document.getElementById('camp-channel').addEventListener('change', () => {
    refreshContactsCount();
    renderBlocklist();
    renderCampaignsList();
  });
  refreshContactsCount();
  renderBlocklist();
  renderCampaignsList();
})();
