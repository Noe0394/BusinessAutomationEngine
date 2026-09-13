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
  let sentIdentifiers = new Set();
  let failedIdentifiers = new Set();

  function channel() {
    return document.getElementById('camp-channel').value;
  }

  function sendScript(channelName, identifier, text) {
    if (channelName === 'whatsapp') {
      return 'window.__cyrusSend && window.__cyrusSend(' + JSON.stringify(identifier + '@c.us') + ', ' + JSON.stringify(text) + ');';
    }
    return 'window.__cyrusTgSend && window.__cyrusTgSend(' + JSON.stringify(identifier) + ', ' + JSON.stringify(text) + ');';
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
    return db.getLatestCampaign(channel()).then(function (c) {
      if (c && c.status === 'running') {
        currentCampaignId = c.id;
        sentIdentifiers = new Set(c.sent || []);
        failedIdentifiers = new Set(c.failed || []);
        setStatus('Campagne interrompue reprise (' + sentIdentifiers.size + '/' + (c.total || 0) + ' déjà envoyés) — cliquez sur "Démarrer" pour continuer.');
      } else {
        currentCampaignId = null;
        sentIdentifiers = new Set();
        failedIdentifiers = new Set();
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

  async function runCampaign() {
    const template = document.getElementById('camp-message').value.trim();
    if (!template) { alert('Message vide.'); return; }
    if (contacts.length === 0) { alert('Aucun contact importé.'); return; }

    const scheduleInput = document.getElementById('camp-schedule').value;
    if (scheduleInput) {
      const target = new Date(scheduleInput).getTime();
      const waitMs = target - Date.now();
      if (waitMs > 0) {
        setStatus('Programmée : démarrage dans ' + Math.round(waitMs / 60000) + ' min...');
        await sleep(waitMs);
      }
    }

    currentCampaignId = currentCampaignId || ('camp-' + Date.now());
    running = true;
    paused = false;

    const remaining = contacts.filter(function (c) { return !sentIdentifiers.has(c.identifier); });
    let done = contacts.length - remaining.length;
    setProgress(done, contacts.length);

    for (const contact of remaining) {
      if (!running || paused) break;

      const vars = personalization.buildPersonalizationVars(contact.name, contact.identifier);
      const text = personalization.personalizeMessage(template, vars);
      const webviewId = channel();

      setStatus('Envoi à ' + contact.identifier + '... (' + (done + 1) + '/' + contacts.length + ')');
      EmbeddedWebView.evaluate({ id: webviewId, script: sendScript(webviewId, contact.identifier, text) });

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
        await db.recordSent(webviewId, contact.identifier, 'campaign');
      }
      done += 1;
      setProgress(done, contacts.length);

      await db.saveCampaign({
        id: currentCampaignId,
        channel: webviewId,
        total: contacts.length,
        message: template,
        sent: Array.from(sentIdentifiers),
        failed: Array.from(failedIdentifiers),
        updatedAt: Date.now(),
        status: 'running',
      });

      if (done < contacts.length) await sleep(randomDelayMs());
    }

    running = false;
    if (paused) {
      setStatus('En pause (' + done + '/' + contacts.length + ').');
    } else {
      setStatus('Campagne terminée (' + done + '/' + contacts.length + ').');
      await db.saveCampaign({
        id: currentCampaignId, channel: channel(), total: contacts.length, message: template,
        sent: Array.from(sentIdentifiers), failed: Array.from(failedIdentifiers),
        updatedAt: Date.now(), status: 'done',
      });
    }
  }

  document.getElementById('camp-start-btn').addEventListener('click', function () {
    if (running) return;
    runCampaign();
  });

  document.getElementById('camp-pause-btn').addEventListener('click', function () {
    paused = true;
    running = false;
  });

  function escapeHtml(s) {
    return String(s || '').replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
})();
