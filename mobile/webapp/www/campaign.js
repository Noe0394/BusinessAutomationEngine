// Moteur de campagne cote navigateur - equivalent allege de
// queues/campaignEngine.js et queues/telegramCampaignEngine.js (VPS) :
// import/extraction de contacts, Spintax + personnalisation
// (lib/spintax.js, lib/personalization.js), envoi sequentiel avec tempo
// aleatoire configurable entre chaque message, etat persiste en IndexedDB
// (lib/db.js) pour survivre a une fermeture/reouverture de l'app. Pas de
// file d'attente multi-campagnes ni de reprise automatique au demarrage du
// process (contrairement au VPS, qui tourne en continu) - une campagne se
// relance manuellement (bouton "Demarrer") si l'app a ete fermee en cours
// d'envoi ; elle reprend alors a partir des contacts pas encore marques
// envoyes plutot que de repartir de zero.
(function () {
  const EmbeddedWebView = window.Capacitor.Plugins.EmbeddedWebView;
  const db = window.Cyrus.db;
  const personalization = window.Cyrus.personalization;

  let contacts = []; // {channel, identifier, name}
  let running = false;
  let paused = false;
  let currentCampaignId = null;
  let scheduledTimer = null;
  let scheduledResume = false;
  let cancelled = false;
  let currentMedia = null;
  let sentIdentifiers = new Set();
  let failedIdentifiers = new Set();
  let campaignHistory = [];
  let campaignRecipients = [];

  function channel() {
    return document.getElementById('camp-channel').value;
  }

  function sendScript(channelName, identifier, text, media) {
    if (media) {
      if (channelName === 'whatsapp') {
        return 'window.__cyrusSendMedia && window.__cyrusSendMedia(' + JSON.stringify(identifier + '@c.us') + ', '
          + JSON.stringify(media.data) + ', ' + JSON.stringify(media.mimetype) + ', ' + JSON.stringify(media.filename) + ', ' + JSON.stringify(text) + ');';
      }
      return 'window.__cyrusTgSendMedia && window.__cyrusTgSendMedia(' + JSON.stringify(identifier) + ', '
        + JSON.stringify(media.data) + ', ' + JSON.stringify(media.mimetype) + ', ' + JSON.stringify(media.filename) + ', ' + JSON.stringify(text) + ');';
    }
    if (channelName === 'whatsapp') {
      return 'window.__cyrusSend && window.__cyrusSend(' + JSON.stringify(identifier + '@c.us') + ', ' + JSON.stringify(text) + ');';
    }
    return 'window.__cyrusTgSend && window.__cyrusTgSend(' + JSON.stringify(identifier) + ', ' + JSON.stringify(text) + ');';
  }

  // Pièce jointe de campagne (optionnelle) — lue une seule fois au lancement
  // (voir runCampaign), pas par message : la même image/vidéo/PDF est
  // envoyée à tous les destinataires, seule la légende (texte personnalisé)
  // change par contact.
  function readFileAsBase64(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsDataURL(file);
    });
  }

  function refreshContactsCount() {
    db.getContacts(channel()).then(function (list) {
      contacts = list;
      const el = document.getElementById('camp-contacts-count');
      el.textContent = list.length > 0
        ? list.length + ' contact(s) importé(s) pour ' + channel() + '.'
        : 'Aucun contact importé.';
    });
  }

  // Reprise apres redemarrage de l'app (feuille de route "queue persistee") :
  // une campagne encore au statut 'running' au moment ou l'app a ete fermee
  // (crash, arret manuel) recharge son etat exact (deja-envoyes/echecs) au
  // lieu de forcer un redemarrage a zero si l'utilisateur reclique sur
  // "Demarrer" - une campagne 'done' ne bloque en revanche jamais une
  // nouvelle campagne ulterieure vers les memes contacts.
  function restoreRunningCampaign() {
    return Promise.all([db.getLatestCampaign(channel()), db.getContacts(channel())]).then(function (values) {
      const c = values[0]; contacts = values[1] || [];
      if (c && (c.status === 'running' || c.status === 'scheduled' || c.status === 'paused')) {
        currentCampaignId = c.id;
        campaignRecipients = Array.isArray(c.recipients) ? c.recipients : [];
        if (campaignRecipients.length) contacts = campaignRecipients;
        sentIdentifiers = new Set(c.sent || []);
        failedIdentifiers = new Set(c.failed || []);
        currentMedia = c.media || null;
        if (c.message) document.getElementById('camp-message').value = c.message;
        if (c.scheduledAt) {
          const at = Number(c.scheduledAt); const input = document.getElementById('camp-schedule');
          input.value = new Date(at - new Date(at).getTimezoneOffset() * 60000).toISOString().slice(0, 16);
        }
        if (c.status === 'scheduled' && c.scheduledAt) {
          const at = Number(c.scheduledAt);
          setStatus('Scheduled for ' + new Date(at).toLocaleString() + '; the app must stay active.');
          if (scheduledTimer) clearTimeout(scheduledTimer);
          const arm = function () {
            const remaining = at - Date.now();
            if (remaining > 2147480000) { scheduledTimer = setTimeout(arm, 2147480000); return; }
            scheduledTimer = setTimeout(function () { scheduledTimer = null; scheduledResume = true; runCampaign(); }, Math.max(0, remaining));
          };
          arm();
        } else {
          setStatus((c.status === 'paused' ? 'Paused campaign (' : 'Interrupted campaign (') + sentIdentifiers.size + '/' + (c.total || 0) + ' already sent); tap Start to resume.');
        }
      } else {
        currentCampaignId = null; currentMedia = null;
        campaignRecipients = [];
        sentIdentifiers = new Set(); failedIdentifiers = new Set();
        if (scheduledTimer) clearTimeout(scheduledTimer); scheduledTimer = null;
      }
    });
  }

  // ---------- Liste noire ----------
  function renderBlocklist() {
    db.getBlocklist(channel()).then(function (blocked) {
      const el = document.getElementById('blocklist-list');
      el.innerHTML = '';
      if (blocked.length === 0) {
        el.innerHTML = '<p class="empty" style="padding:4px 0;">Aucun contact bloqué pour ce canal.</p>';
        return;
      }
      blocked.forEach(function (b) {
        const row = document.createElement('div');
        row.className = 'chat-row';
        row.style.padding = '6px 0';
        const label = document.createElement('span');
        label.textContent = b.identifier;
        const removeBtn = document.createElement('button');
        removeBtn.textContent = 'Retirer';
        removeBtn.addEventListener('click', function () {
          db.removeFromBlocklist(channel(), b.identifier).then(renderBlocklist);
        });
        row.appendChild(label);
        row.appendChild(removeBtn);
        el.appendChild(row);
      });
    });
  }

  document.getElementById('blocklist-add-btn').addEventListener('click', function () {
    const input = document.getElementById('blocklist-add-input');
    const raw = input.value.trim();
    if (!raw) return;
    const identifier = raw.startsWith('@') ? raw : raw.replace(/\D/g, '');
    if (!identifier) return;
    db.addToBlocklist(channel(), identifier).then(function () {
      input.value = '';
      renderBlocklist();
    });
  });

  document.getElementById('camp-channel').addEventListener('change', function () {
    refreshContactsCount();
    restoreRunningCampaign();
    renderBlocklist();
    renderCampaignHistory();
  });
  refreshContactsCount();
  restoreRunningCampaign();
  renderBlocklist();

  // ---------- Import fichier ----------
  // Filtrage systématique contre la liste noire (voir db.filterBlocked) avant
  // toute écriture - un contact bloqué n'entre JAMAIS dans les contacts de
  // campagne, quelle que soit la source (fichier ou extraction de groupe,
  // voir handleGroupMembers plus bas).
  document.getElementById('camp-file-input').addEventListener('change', function (e) {
    const file = e.target.files[0];
    if (!file) return;
    let totalParsed = 0;
    window.Cyrus.contactsImport.parseContactsFile(file).then(function (parsed) {
      totalParsed = parsed.length;
      return db.filterBlocked(channel(), parsed);
    }).then(function (kept) {
      return db.putAllContacts(channel(), kept).then(function () { return kept.length; });
    }).then(function (keptCount) {
      refreshContactsCount();
      e.target.value = '';
      const blocked = totalParsed - keptCount;
      if (blocked > 0) alert(blocked + ' contact(s) exclu(s) car présent(s) dans la liste noire.');
    }).catch(function (err) {
      alert('Erreur import : ' + err);
    });
  });

  // ---------- Extraction depuis un groupe ----------
  document.getElementById('camp-list-groups-btn').addEventListener('click', function () {
    const id = channel() === 'whatsapp' ? 'whatsapp' : 'telegram';
    const fn = channel() === 'whatsapp' ? '__cyrusGetGroups' : '__cyrusTgGetGroups';
    EmbeddedWebView.evaluate({ id: id, script: 'window.' + fn + ' && window.' + fn + '();' });
  });

  EmbeddedWebView.addListener('message', function (event) {
    let data;
    try { data = JSON.parse(event.data); } catch (e) { return; }

    if (data.type === 'groups') {
      renderGroups(data.payload.groups, event.id);
    }
    if (data.type === 'group-members') {
      handleGroupMembers(data.payload.groupId, data.payload.members);
    }
    if (data.type === 'send-result') {
      handleSendResult(event.id, data.payload);
    }
  });

  // groupId -> { action: 'import' | 'export', name } ; determine, a la
  // reception asynchrone de 'group-members', ce qu'il faut faire du resultat
  // (voir handleGroupMembers) - necessaire car les deux boutons du meme
  // groupe declenchent le meme appel bridge (__cyrusGetGroupMembers).
  const pendingGroupExtractions = {};

  function requestGroupMembers(webviewId, groupId) {
    const fn = webviewId === 'whatsapp' ? '__cyrusGetGroupMembers' : '__cyrusTgGetGroupMembers';
    EmbeddedWebView.evaluate({ id: webviewId, script: 'window.' + fn + ' && window.' + fn + '(' + JSON.stringify(groupId) + ');' });
  }

  function slugify(s) {
    return String(s || 'groupe').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'groupe';
  }

  function renderGroups(groups, webviewId) {
    const el = document.getElementById('camp-groups-list');
    el.innerHTML = '';
    if (!groups || groups.length === 0) {
      el.innerHTML = '<p class="empty" style="padding:8px 0;">Aucun groupe trouvé.</p>';
      return;
    }
    groups.forEach(function (g) {
      const row = document.createElement('div');
      row.className = 'chat-row';
      row.style.padding = '8px 0';
      row.innerHTML =
        '<div class="chat-body"><div class="chat-peer">' + escapeHtml(g.name || g.id) + '</div>' +
        '<div class="chat-preview">' + (g.participantsCount || '') + '</div></div>';

      const importBtn = document.createElement('button');
      importBtn.textContent = 'Importer comme contacts';
      importBtn.style.marginRight = '8px';
      importBtn.addEventListener('click', function () {
        pendingGroupExtractions[g.id] = { action: 'import', name: g.name || g.id };
        requestGroupMembers(webviewId, g.id);
      });

      // Extraction + export Excel/CSV des membres (feuille de route :
      // equivalent local de l'export historique du dashboard, sans passer
      // par les contacts de campagne - un fichier livrable a part).
      const exportBtn = document.createElement('button');
      exportBtn.textContent = '📥 Exporter (Excel)';
      exportBtn.addEventListener('click', function () {
        pendingGroupExtractions[g.id] = { action: 'export', name: g.name || g.id };
        requestGroupMembers(webviewId, g.id);
      });

      row.appendChild(importBtn);
      row.appendChild(exportBtn);

      // Diffusion directe dans le groupe/canal lui-même (un seul message
      // pour tout le groupe), à distinguer de "Importer comme contacts"
      // ci-dessus (extrait chaque MEMBRE comme contact individuel).
      if (webviewId === 'telegram') {
        const broadcastBtn = document.createElement('button');
        broadcastBtn.textContent = '📣 Diffuser';
        broadcastBtn.addEventListener('click', function () {
          db.putAllContacts('telegram', [{ identifier: g.id, name: g.name || '' }]).then(refreshContactsCount);
        });
        row.appendChild(broadcastBtn);
      }
      el.appendChild(row);
    });
  }

  function handleGroupMembers(groupId, members) {
    const pending = pendingGroupExtractions[groupId];
    delete pendingGroupExtractions[groupId];

    if (!members || members.length === 0) {
      alert('Aucun membre extrait pour ce groupe.');
      return;
    }

    if (pending && pending.action === 'export') {
      const rows = members.map(function (m) { return { identifiant: m.id, admin: m.isAdmin ? 'oui' : 'non' }; });
      window.Cyrus.fileExport.exportRows(rows, 'membres-' + slugify(pending.name), 'xlsx').catch(function (err) {
        alert('Échec de l\'export : ' + err);
      });
      return;
    }

    const asContacts = members.map(function (m) { return { identifier: m.id, name: '' }; });
    db.filterBlocked(channel(), asContacts).then(function (kept) {
      return db.putAllContacts(channel(), kept).then(function () { return kept.length; });
    }).then(function (keptCount) {
      refreshContactsCount();
      const blocked = members.length - keptCount;
      alert(keptCount + ' membre(s) ajouté(s) aux contacts.' + (blocked > 0 ? ' (' + blocked + ' exclu(s), liste noire)' : ''));
    });
  }

  // ---------- Aperçu Spintax/personnalisation ----------
  document.getElementById('camp-preview-btn').addEventListener('click', function () {
    const template = document.getElementById('camp-message').value;
    const samples = contacts.slice(0, 3);
    const source = samples.length > 0 ? samples : [{ name: 'Jean', identifier: '22600000000' }];
    const previews = source.map(function (c) {
      const vars = personalization.buildPersonalizationVars(c.name, c.identifier);
      return personalization.personalizeMessage(template, vars);
    });
    document.getElementById('camp-preview-result').innerHTML = previews.map(function (p, i) {
      return '<div style="margin-bottom:6px;">' + (i + 1) + '. ' + escapeHtml(p) + '</div>';
    }).join('');
  });

  // ---------- Moteur d'envoi ----------
  let pendingSendResolvers = {}; // identifier -> resolve function, pour attendre l'ack avant le prochain envoi

  function handleSendResult(webviewId, payload) {
    const identifier = String(payload.chatId || '').replace('@c.us', '');
    const resolver = pendingSendResolvers[identifier];
    if (resolver) {
      resolver(payload.ok);
      delete pendingSendResolvers[identifier];
    }
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Telegram impose un délai strict 30-60s entre chaque DM (limite
  // anti-spam de la plateforme) — clampé ici quel que soit ce que
  // l'utilisateur a saisi, même comportement que le VPS.
  function randomDelayMs() {
    let min = Math.max(1, parseInt(document.getElementById('camp-delay-min').value, 10) || 8);
    let max = Math.max(min, parseInt(document.getElementById('camp-delay-max').value, 10) || 20);
    if (channel() === 'telegram') {
      min = Math.min(60, Math.max(30, min));
      max = Math.min(60, Math.max(min, max));
    }
    return (min + Math.random() * (max - min)) * 1000;
  }

  function setStatus(text) {
    document.getElementById('camp-status').textContent = text;
  }

  function setProgress(done, total) {
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    document.getElementById('camp-progress-fill').style.width = pct + '%';
  }

  async function runCampaign() {
    const template = document.getElementById('camp-message').value.trim();
    if (!template) { alert('Message vide.'); return; }
    if (contacts.length === 0) { alert('Aucun contact importé.'); return; }

    const mediaInput = document.getElementById('camp-media-input');
    const mediaFile = mediaInput && mediaInput.files[0];
    if (mediaFile) currentMedia = { data: await readFileAsBase64(mediaFile), mimetype: mediaFile.type, filename: mediaFile.name };
    const scheduleInput = document.getElementById('camp-schedule').value;
    running = true; paused = false; cancelled = false;
    currentCampaignId = currentCampaignId || ('camp-' + Date.now());
    if (!campaignRecipients.length) campaignRecipients = contacts.map(c => ({ channel: c.channel || channel(), identifier: c.identifier, name: c.name || '' }));
    if (scheduledTimer) { clearTimeout(scheduledTimer); scheduledTimer = null; }
    if (scheduleInput && !scheduledResume) {
      const target = new Date(scheduleInput).getTime();
      const waitMs = target - Date.now();
      if (waitMs > 0) {
        setStatus('Scheduled for ' + new Date(target).toLocaleString() + '; keep the app active.');
        await db.saveCampaign({ id: currentCampaignId, channel: channel(), total: contacts.length, recipients: campaignRecipients, message: template, sent: Array.from(sentIdentifiers), failed: Array.from(failedIdentifiers), media: currentMedia, scheduledAt: target, updatedAt: Date.now(), status: 'scheduled' });
        while (target > Date.now() && running && !paused) await sleep(Math.min(60000, target - Date.now()));
        if (!running || paused) {
          if (paused) await db.saveCampaign({ id: currentCampaignId, channel: channel(), total: contacts.length, recipients: campaignRecipients, message: template,
            sent: Array.from(sentIdentifiers), failed: Array.from(failedIdentifiers), media: currentMedia,
            scheduledAt: target, updatedAt: Date.now(), status: 'paused' });
          setStatus('Schedule paused.'); return;
        }
      }
    }
    scheduledResume = false;
    const media = currentMedia;

    const batchSize = parseInt(document.getElementById('camp-batch-size').value, 10) || 0;
    const batchPauseMs = (parseInt(document.getElementById('camp-batch-pause').value, 10) || 0) * 1000;
    let sentInBatch = 0;

    running = true;
    paused = false;

    const remaining = contacts.filter(function (c) { return !sentIdentifiers.has(c.identifier); });
    let done = contacts.length - remaining.length;
    setProgress(done, contacts.length);

    for (const contact of remaining) {
      if (!running || paused || cancelled) break;

      const vars = personalization.buildPersonalizationVars(contact.name, contact.identifier);
      const text = personalization.personalizeMessage(template, vars);
      const webviewId = channel();

      setStatus('Envoi à ' + contact.identifier + '... (' + (done + 1) + '/' + contacts.length + ')');
      EmbeddedWebView.evaluate({ id: webviewId, script: sendScript(webviewId, contact.identifier, text, media) });

      // Attend l'accuse d'envoi (ou 15s de timeout) avant de passer au
      // suivant - evite d'empiler des envois plus vite que le pont ne peut
      // les traiter, sans dependre d'une confirmation bloquante stricte. Un
      // timeout (pas d'accuse recu) est traite comme un succes optimiste
      // (comportement historique inchange) ; seul un accuse EXPLICITE
      // ok:false marque le contact 'failed' - il reapparaitra alors dans la
      // file de Relance Manuelle Express (voir lib/manualRelance.js) au lieu
      // d'etre silencieusement considere comme traite.
      const ok = await Promise.race([
        new Promise(function (resolve) { pendingSendResolvers[contact.identifier] = resolve; }),
        sleep(15000).then(function () { return true; }),
      ]);

      if (ok === false) {
        failedIdentifiers.add(contact.identifier);
      } else {
        sentIdentifiers.add(contact.identifier);
        await db.recordSent(webviewId, contact.identifier, 'campaign', currentCampaignId);
      }
      done += 1;
      setProgress(done, contacts.length);

      await db.saveCampaign({
        id: currentCampaignId,
        channel: webviewId,
        total: contacts.length,
        recipients: campaignRecipients,
        message: template,
        sent: Array.from(sentIdentifiers),
        failed: Array.from(failedIdentifiers),
        updatedAt: Date.now(),
        media: currentMedia, scheduledAt: null, status: 'running',
      });

      sentInBatch += 1;
      if (done < contacts.length) {
        const useBatchPause = batchSize && sentInBatch >= batchSize;
        if (useBatchPause) sentInBatch = 0;
        await sleep(useBatchPause ? Math.max(randomDelayMs(), batchPauseMs) : randomDelayMs());
      }
    }

    running = false;
    if (cancelled) {
      setStatus('Campagne annulée après l’envoi en cours (' + done + '/' + contacts.length + ').');
      await db.saveCampaign({ id: currentCampaignId, channel: channel(), total: contacts.length, recipients: campaignRecipients, message: template,
        sent: Array.from(sentIdentifiers), failed: Array.from(failedIdentifiers), updatedAt: Date.now(), media: currentMedia,
        scheduledAt: null, status: 'cancelled' });
    } else if (paused) {
      setStatus('En pause (' + done + '/' + contacts.length + ').');
      await db.saveCampaign({ id: currentCampaignId, channel: channel(), total: contacts.length, recipients: campaignRecipients, message: template,
        sent: Array.from(sentIdentifiers), failed: Array.from(failedIdentifiers), media: currentMedia,
        scheduledAt: null, updatedAt: Date.now(), status: 'paused' });
    } else {
      setStatus('Campagne terminée (' + done + '/' + contacts.length + ').');
      await db.saveCampaign({
        id: currentCampaignId, channel: channel(), total: contacts.length, recipients: campaignRecipients, message: template,
        sent: Array.from(sentIdentifiers), failed: Array.from(failedIdentifiers),
        updatedAt: Date.now(), media: currentMedia, scheduledAt: null, status: 'done',
      });
    }
    renderCampaignHistory();
  }

  document.getElementById('camp-start-btn').addEventListener('click', function () {
    if (running) return;
    if (scheduledTimer) { clearTimeout(scheduledTimer); scheduledTimer = null; scheduledResume = true; }
    runCampaign();
  });

  document.getElementById('camp-pause-btn').addEventListener('click', function () {
    paused = true;
    running = false;
  });

  document.getElementById('camp-cancel-btn').addEventListener('click', async function () {
    const c = await db.getLatestCampaign(channel());
    if (scheduledTimer) { clearTimeout(scheduledTimer); scheduledTimer = null; }
    cancelled = true; paused = false; running = false;
    if (c) await db.saveCampaign(Object.assign({}, c, { status: 'cancelled', scheduledAt: null, updatedAt: Date.now() }));
    setStatus('Campagne annulée. Les contacts déjà envoyés restent dans l’historique.');
    renderCampaignHistory();
  });

  // Rapport final de campagne (équivalent de la fenêtre modale de
  // dashboard.html) : décompte par statut à partir de la dernière campagne
  // persistée pour ce canal (db.getLatestCampaign) - même schéma sent/failed
  // que campaign.js (voir lib/cyrusStoreShim.js pour le schéma canonique
  // utilisé par chat-core.js, différent de celui-ci par conception).
  document.getElementById('camp-report-btn').addEventListener('click', function () {
    const el = document.getElementById('camp-report');
    if (el.style.display === 'block') { el.style.display = 'none'; return; }
    db.getLatestCampaign(channel()).then(function (c) {
      if (!c) { el.innerHTML = '<p class="empty">Aucune campagne pour ce canal.</p>'; el.style.display = 'block'; return; }
      const sentCount = (c.sent || []).length;
      const failedCount = (c.failed || []).length;
      const pendingCount = Math.max(0, (c.total || 0) - sentCount - failedCount);
      const statusText = escapeHtml(c.status || 'inconnu') + (c.scheduledAt ? ' · programmée le ' + escapeHtml(new Date(c.scheduledAt).toLocaleString()) : '');
      const rows = (c.failed || []).map(function (id) { return '<li>' + escapeHtml(id) + '</li>'; }).join('');
      el.innerHTML = '<div class="card" style="margin-bottom:0;">'
        + '<div><b>' + sentCount + '</b> envoyé(s) · <b>' + failedCount + '</b> échec(s) · <b>' + pendingCount + '</b> en attente</div>'
        + '<p>État : ' + statusText + '</p>'
        + (failedCount ? '<ul style="margin-top:6px;">' + rows + '</ul><button type="button" id="camp-report-export">Exporter les échecs (Excel)</button>' : '')
        + '</div>';
      el.style.display = 'block';
      const exportBtn = document.getElementById('camp-report-export');
      if (exportBtn) exportBtn.addEventListener('click', function () {
        window.Cyrus.fileExport.exportRows((c.failed || []).map(id => ({ Canal: c.channel, Identifiant: id, Statut: 'Échec' })), 'echecs-campagne', 'xlsx');
      });
    });
  });

  async function renderCampaignHistory() {
    const host = document.getElementById('camp-history-content');
    try {
      campaignHistory = await db.getCampaigns(channel());
      campaignHistory.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      host.replaceChildren();
      if (!campaignHistory.length) { host.textContent = 'Aucune campagne enregistrée pour ce canal.'; return; }
      campaignHistory.forEach(c => {
        const card = document.createElement('div'); card.className = 'card';
        const title = document.createElement('b'); title.textContent = c.message || ('Campagne ' + c.id); card.appendChild(title);
        const details = document.createElement('p');
        details.textContent = (c.status || 'inconnu') + ' · ' + (c.sent || []).length + ' envoyés · ' + (c.failed || []).length + ' échecs · ' + Math.max(0, (c.total || 0) - (c.sent || []).length - (c.failed || []).length) + ' en attente' + (c.scheduledAt ? ' · programmée le ' + new Date(c.scheduledAt).toLocaleString() : '');
        card.appendChild(details);
        const date = document.createElement('small'); date.textContent = c.updatedAt ? 'Mise à jour : ' + new Date(c.updatedAt).toLocaleString() : 'Date indisponible'; card.appendChild(date);
        const recipientButton = document.createElement('button'); recipientButton.className = 'secondary'; recipientButton.textContent = 'Afficher les destinataires (' + (Array.isArray(c.recipients) ? c.recipients.length : c.total || 0) + ')';
        const recipientList = document.createElement('div'); recipientList.hidden = true;
        recipientButton.addEventListener('click', function () {
          recipientList.hidden = !recipientList.hidden;
          recipientButton.textContent = (recipientList.hidden ? 'Afficher' : 'Masquer') + ' les destinataires (' + (Array.isArray(c.recipients) ? c.recipients.length : c.total || 0) + ')';
          if (recipientList.childElementCount) return;
          const sent = new Set(c.sent || []); const failed = new Set(c.failed || []);
          const rows = Array.isArray(c.recipients) ? c.recipients : [];
          if (!rows.length) { recipientList.textContent = 'Cette ancienne campagne ne conserve pas le détail des destinataires.'; return; }
          rows.slice(0, 500).forEach(r => {
            const line = document.createElement('p');
            const id = r.identifier || r.id || '';
            line.textContent = (r.name ? r.name + ' · ' : '') + id + ' · ' + (sent.has(id) ? 'Envoyé' : failed.has(id) ? 'Échec' : 'En attente');
            recipientList.appendChild(line);
          });
          if (rows.length > 500) { const note = document.createElement('small'); note.textContent = 'Affichage limité aux 500 premiers destinataires.'; recipientList.appendChild(note); }
        });
        card.appendChild(recipientButton); card.appendChild(recipientList);
        host.appendChild(card);
      });
    } catch (error) { host.textContent = 'Historique indisponible : ' + error.message; }
  }
  document.getElementById('camp-history-refresh').addEventListener('click', renderCampaignHistory);
  document.getElementById('camp-history-export').addEventListener('click', async function () {
    if (!campaignHistory.length) await renderCampaignHistory();
    const rows = campaignHistory.map(c => ({
      Canal: c.channel, Campagne: c.message || c.id, État: c.status || '', Total: c.total || 0,
      Envoyés: (c.sent || []).length, Échecs: (c.failed || []).length,
      'En attente': Math.max(0, (c.total || 0) - (c.sent || []).length - (c.failed || []).length),
      Programmée: c.scheduledAt ? new Date(c.scheduledAt).toLocaleString() : '',
      'Dernière mise à jour': c.updatedAt ? new Date(c.updatedAt).toLocaleString() : '',
    }));
    if (rows.length) window.Cyrus.fileExport.exportRows(rows, 'historique-campagnes', 'xlsx');
  });
  renderCampaignHistory();

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
