async function localApiFetch(url, options) { const r = await fetch(url, options); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'HTTP ' + r.status); return r; }
    // ---- Communautés : création/invitation de groupes + découverte (onglets WhatsApp et Telegram) -------------------------------------
    (function initCommunities() {
      // Temporisation : champs saisis en secondes/minutes côté interface (plus lisible), convertis en millisecondes pour l'API
      // (voir ai-engine/communityService.js#TIMING_BOUNDS, qui travaille en ms). readTiming ignore les champs laissés vides (défauts
      // prudents du serveur appliqués). writeTiming fait l'inverse pour préremplir le formulaire d'ajustement avec la temporisation réelle du job.
      function readTiming(prefix, $) {
        var t = {};
        var num = function (id) { var v = $(id).value; return v === '' ? undefined : Number(v); };
        var batch = num(prefix + 'batch'); if (batch != null) t.batchSize = batch;
        var items = num(prefix + 'items'); if (items != null) t.delayBetweenItems = Math.round(items * 1000);
        var batches = num(prefix + 'batches'); if (batches != null) t.delayBetweenBatches = Math.round(batches * 1000);
        var pauseEvery = num(prefix + 'pause-every'); if (pauseEvery != null) t.pauseEveryNBatches = pauseEvery;
        var pauseMin = num(prefix + 'pause-min'); if (pauseMin != null) t.pauseDuration = Math.round(pauseMin * 60000);
        var initial = num(prefix + 'initial'); if (initial != null) t.initialDelay = Math.round(initial * 1000);
        var max = num(prefix + 'max'); if (max != null) t.maxItems = max;
        return t;
      }
      function writeTiming(prefix, $, timing) {
        var t = timing || {};
        var set = function (id, v) { $(id).value = (v === undefined || v === null) ? '' : v; };
        set(prefix + 'batch', t.batchSize);
        set(prefix + 'items', t.delayBetweenItems != null ? Math.round(t.delayBetweenItems / 1000) : undefined);
        set(prefix + 'batches', t.delayBetweenBatches != null ? Math.round(t.delayBetweenBatches / 1000) : undefined);
        set(prefix + 'pause-every', t.pauseEveryNBatches);
        set(prefix + 'pause-min', t.pauseDuration != null ? Math.round(t.pauseDuration / 60000) : undefined);
        set(prefix + 'initial', t.initialDelay != null ? Math.round(t.initialDelay / 1000) : undefined);
        set(prefix + 'max', t.maxItems);
      }
      function setup(p, channel) {
        var $ = function (s) { return document.getElementById('cm-' + p + '-' + s); };
        if (!$('create-btn')) return;
        var lastResults = []; var pollTimer = null; var currentJob = null;
        function say(el, msg, ok) { el.hidden = false; el.textContent = msg; el.className = ok === false ? 'error' : (ok ? 'ok' : 'empty'); }
        function renderProgress(job) {
          var box = $('progress'); box.hidden = false; box.textContent = '';
          var c = job.counts || {};
          var pr = job.progress || { processed: 0, total: (c.total || 0), percent: 0 };
          var phases = { verification: 'Vérification des contacts…', ajout: 'Ajout des membres…', invitations: 'Envoi des invitations…' };
          var statusFr = { QUEUED: 'En file', RUNNING: 'En cours', CANCELLING: 'Arrêt en cours…', PAUSING: 'Mise en pause…', PAUSED_USER: 'En pause', INTERRUPTED: 'Interrompu (reprise possible)', CANCELLED: 'Arrêté', DONE: 'Terminé', DONE_WITH_ISSUES: 'Terminé avec des échecs', FAILED: 'Échec', PAUSED_RATE_LIMIT: 'En pause (limite de débit)' };
          var barWrap = document.createElement('div'); barWrap.style.cssText = 'background:#e6e1f5;border-radius:8px;height:18px;overflow:hidden;margin:6px 0';
          var bar = document.createElement('div'); bar.style.cssText = 'height:100%;background:#6c4fd6;transition:width .4s;width:' + pr.percent + '%'; barWrap.appendChild(bar); box.appendChild(barWrap);
          var cap = document.createElement('div'); cap.style.fontWeight = '600'; cap.textContent = pr.percent + ' % — ' + pr.processed + ' / ' + pr.total + ' contact(s) traité(s)' + (job.phase && phases[job.phase] ? ' · ' + phases[job.phase] : ''); box.appendChild(cap);
          var lines = [
            'Statut : ' + (statusFr[job.status] || job.status) + (job.error ? ' — ' + job.error : ''),
            'Ajoutés directement : ' + (c.added || 0) + ' · Invitations envoyées en message privé : ' + (c.invited_dm || 0) + ' · Déjà membres : ' + (c.already_member || 0),
            'Absents de la plateforme : ' + (c.not_on_platform || 0) + ' · Désinscrits (ignorés) : ' + (c.opted_out || 0) + ' · Échecs : ' + (c.failed || 0) + ' · En attente : ' + ((c.pending || 0) + (c.needs_invite || 0)) + ' / ' + (c.total || 0),
          ];
          if (job.group && job.group.link) lines.push('Lien du groupe : ' + job.group.link);
          lines.forEach(function (l) { var d = document.createElement('div'); d.textContent = l; box.appendChild(d); });
          var paused = ['PAUSED_RATE_LIMIT', 'DONE_WITH_ISSUES', 'PAUSED_USER', 'INTERRUPTED'].indexOf(job.status) >= 0;
          $('resume-btn').hidden = !paused;
          if ($('pause-btn')) { $('pause-btn').hidden = ['QUEUED', 'RUNNING'].indexOf(job.status) < 0; $('pause-btn').disabled = false; }
          if ($('stop-btn')) { $('stop-btn').hidden = ['QUEUED', 'RUNNING', 'PAUSING', 'CANCELLING', 'PAUSED_RATE_LIMIT', 'PAUSED_USER', 'INTERRUPTED'].indexOf(job.status) < 0; $('stop-btn').disabled = job.status === 'CANCELLING'; }
          // Ajuster la temporisation : seulement possible pendant une pause (voir communityService.setTiming), s'applique à la reprise suivante.
          if ($('timing-edit-btn')) { $('timing-edit-btn').hidden = !paused; if (!paused) $('timing-edit-box').hidden = true; }
        }
        function poll(id) {
          if (pollTimer) clearInterval(pollTimer);
          var tick = async function () {
            try {
              var res = await localApiFetch('/api/communities/groups/' + encodeURIComponent(id) + '?channel=' + channel);
              var data = await res.json();
              if (data && data.group) { currentJob = data.group; renderProgress(data.group); if (['DONE', 'DONE_WITH_ISSUES', 'FAILED', 'PAUSED_RATE_LIMIT', 'PAUSED_USER', 'INTERRUPTED', 'CANCELLED'].indexOf(data.group.status) >= 0) { clearInterval(pollTimer); pollTimer = null; } }
            } catch (e) { /* session expirée : géré par apiFetch */ }
          };
          tick(); pollTimer = setInterval(tick, 4000);
        }
        $('create-btn').addEventListener('click', async function () {
          var title = $('title').value.trim();
          if (title.length < 2) return say($('create-feedback'), 'Indiquez un nom de groupe.', false);
          var f = $('file').files[0];
          if (!$('text').value.trim() && !f) return say($('create-feedback'), 'Ajoutez des contacts (texte ou fichier).', false);
          var payload = { channel: channel, title: title, text: $('text').value, inviteMessage: $('invite').value.trim(), timing: readTiming('timing-', $) };
          if (f) {
            if (f.size > 9 * 1024 * 1024) return say($('create-feedback'), 'Le fichier dépasse 9 Mo.', false);
            var base64 = await new Promise(function (resolve, reject) {
              var reader = new FileReader(); reader.onerror = function () { reject(reader.error); };
              reader.onload = function () { resolve(String(reader.result).split(',')[1] || ''); };
              reader.readAsDataURL(f);
            });
            var uploaded = { base64: base64, name: f.name, type: f.type };
            if (/^image\//.test(f.type || '')) payload.image = uploaded; else payload.file = uploaded;
          }
          $('create-btn').disabled = true; say($('create-feedback'), 'Préparation de la liste et création du groupe…');
          try {
            var res = await localApiFetch('/api/communities/groups', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
            if (!res.ok || !data.ok) { say($('create-feedback'), (data && data.error) || 'Échec de la création.', false); }
            else { say($('create-feedback'), 'Groupe en cours de création : ' + data.group.counts.total + ' contact(s) valide(s). Les ajouts se font lentement pour protéger votre compte.', true); currentJob = data.group; renderProgress(data.group); poll(data.group.id); }
          } catch (e) { if (e.message !== 'unauthorized') say($('create-feedback'), 'Erreur de communication avec le serveur.', false); }
          $('create-btn').disabled = false;
        });
        // Le traitement tourne CÔTÉ SERVEUR : rafraîchir la page ne l'arrête pas. Au chargement, on retrouve le traitement en cours (ou le dernier) de ce canal et on reprend l'affichage.
        var reattach = async function () {
          try {
            var res = await localApiFetch('/api/communities/groups?channel=' + channel);
            var data = await res.json();
            var mine = ((data && data.groups) || []).filter(function (g) { return g.channel === channel; });
            var active = mine.filter(function (g) { return ['QUEUED', 'RUNNING', 'PAUSING', 'CANCELLING', 'PAUSED_USER', 'PAUSED_RATE_LIMIT', 'INTERRUPTED'].indexOf(g.status) >= 0; })[0] || mine[0];
            if (!active) return;
            var one = await (await localApiFetch('/api/communities/groups/' + encodeURIComponent(active.id) + '?channel=' + channel)).json();
            if (one && one.group) { currentJob = one.group; renderProgress(one.group); if (['QUEUED', 'RUNNING', 'PAUSING', 'CANCELLING'].indexOf(one.group.status) >= 0) poll(one.group.id); }
          } catch (e) { /* session expirée ou aucun traitement : rien à reprendre */ }
        };
        // Appelé à l'ouverture de l'onglet « Communautés » (aucun appel réseau au chargement de la page).
        window.__cmReattach = window.__cmReattach || {}; window.__cmReattach[p] = reattach;
        if ($('pause-btn')) $('pause-btn').addEventListener('click', async function () {
          if (!currentJob) return;
          $('pause-btn').disabled = true;
          try {
            var res = await localApiFetch('/api/communities/groups/' + encodeURIComponent(currentJob.id) + '/pause', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: channel }) });
            var data = await res.json();
            if (data && data.ok) { say($('create-feedback'), 'Pause demandée : le traitement s\'arrête avant le prochain lot.', true); currentJob = data.group; renderProgress(data.group); poll(currentJob.id); } else { $('pause-btn').disabled = false; say($('create-feedback'), (data && data.error) || 'Pause impossible.', false); }
          } catch (e) { $('pause-btn').disabled = false; }
        });
        if ($('stop-btn')) $('stop-btn').addEventListener('click', async function () {
          if (!currentJob) return;
          $('stop-btn').disabled = true;
          try {
            var res = await localApiFetch('/api/communities/groups/' + encodeURIComponent(currentJob.id) + '/cancel', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: channel }) });
            var data = await res.json();
            if (data && data.ok) { say($('create-feedback'), 'Arrêt demandé : le traitement s\'arrête avant le prochain lot. Ce qui est déjà fait est conservé.', true); currentJob = data.group; renderProgress(data.group); poll(currentJob.id); } else { $('stop-btn').disabled = false; say($('create-feedback'), (data && data.error) || 'Arrêt impossible.', false); }
          } catch (e) { $('stop-btn').disabled = false; }
        });
        $('resume-btn').addEventListener('click', async function () {
          if (!currentJob) return;
          try {
            var res = await localApiFetch('/api/communities/groups/' + encodeURIComponent(currentJob.id) + '/resume', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: channel }) });
            var data = await res.json();
            if (data && data.ok) { say($('create-feedback'), 'Reprise du traitement.', true); poll(currentJob.id); } else say($('create-feedback'), (data && data.error) || 'Reprise impossible.', false);
          } catch (e) { /* géré */ }
        });
        if ($('timing-edit-btn')) $('timing-edit-btn').addEventListener('click', function () {
          writeTiming('etiming-', $, currentJob && currentJob.timing);
          $('timing-edit-box').hidden = !$('timing-edit-box').hidden;
        });
        if ($('etiming-apply-btn')) $('etiming-apply-btn').addEventListener('click', async function () {
          if (!currentJob) return;
          var patch = readTiming('etiming-', $);
          if (!Object.keys(patch).length) return say($('etiming-feedback'), 'Renseignez au moins un réglage.', false);
          $('etiming-apply-btn').disabled = true;
          try {
            var res = await localApiFetch('/api/communities/groups/' + encodeURIComponent(currentJob.id) + '/timing', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
            var data = await res.json();
            if (data && data.ok) { currentJob = data.group; say($('etiming-feedback'), 'Nouvelle temporisation enregistrée — cliquez « Reprendre » pour l\'appliquer.', true); }
            else say($('etiming-feedback'), (data && data.error) || 'Réglage impossible (le groupe doit être en pause).', false);
          } catch (e) { say($('etiming-feedback'), 'Erreur de communication avec le serveur.', false); }
          $('etiming-apply-btn').disabled = false;
        });
        function renderMyGroups(list) {
          var body = $('mine-results'); body.textContent = '';
          if (!list.length) { var tr0 = document.createElement('tr'); var td0 = document.createElement('td'); td0.colSpan = 4; td0.className = 'empty'; td0.textContent = 'Aucun groupe trouvé.'; tr0.appendChild(td0); body.appendChild(tr0); return; }
          list.forEach(function (g) {
            var tr = document.createElement('tr');
            [g.name || '-', g.isAdmin ? '👑 admin' : '-', g.size != null ? String(g.size) : '-'].forEach(function (v) { var td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });
            var tdl = document.createElement('td');
            if (g.link) { var a = document.createElement('a'); a.href = g.link; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = g.link.replace('https://', ''); tdl.appendChild(a); } else tdl.textContent = '-';
            tr.appendChild(tdl);
            body.appendChild(tr);
          });
        }
        if ($('mine-search-btn')) $('mine-search-btn').addEventListener('click', async function () {
          $('mine-search-btn').disabled = true; say($('mine-feedback'), 'Recherche en cours…');
          try {
            var qs = 'channel=' + channel + '&adminOnly=' + ($('mine-admin').checked ? 'true' : 'false') + ($('mine-kw').value.trim() ? '&subject=' + encodeURIComponent($('mine-kw').value.trim()) : '');
            var res = await localApiFetch('/api/communities/my-groups?' + qs);
            var data = await res.json();
            if (!res.ok || !data.ok) { say($('mine-feedback'), (data && data.error) || 'Recherche impossible.', false); }
            else if (data.connected === false) { say($('mine-feedback'), data.paired ? 'La connexion se rétablit, réessayez dans un instant.' : ('Non connecté : appairez d\'abord le compte dans l\'onglet ' + (channel === 'TELEGRAM' ? 'Telegram' : 'WhatsApp') + '.'), false); renderMyGroups([]); }
            else { renderMyGroups(data.groups || []); say($('mine-feedback'), (data.matched || 0) + ' groupe(s) trouvé(s)' + (data.truncated ? ' (affichage limité aux 20 plus grands)' : '') + '.', true); }
          } catch (e) { if (e.message !== 'unauthorized') say($('mine-feedback'), 'Erreur de communication avec le serveur.', false); }
          $('mine-search-btn').disabled = false;
        });
        // Adhésion (WhatsApp uniquement) puis extraction de membres : chaque action est un clic volontaire, groupe par groupe —
        // jamais en masse ni automatique (voir joinGroupByInvite côté serveur). La communauté doit être en base CRM avant ces
        // deux actions (extractMembers/joinCommunity la cherchent par ref) : on la synchronise donc seule au premier clic.
        function ensureSynced(c) {
          return localApiFetch('/api/communities/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: channel, communities: [c] }) });
        }
        async function extractMembers(c, btn, feedbackEl) {
          btn.disabled = true; say(feedbackEl, 'Extraction des membres en cours…');
          try {
            await ensureSynced(c);
            var res = await localApiFetch('/api/communities/extract-members', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: channel, ref: c.ref }) });
            var data = await res.json();
            if (!res.ok || !data.ok) { say(feedbackEl, (data && data.error) || 'Extraction impossible.', false); btn.disabled = false; return; }
            say(feedbackEl, data.found + ' membre(s) trouvé(s), ' + data.synced + ' ajouté(s) au CRM comme prospects (étiquette "decouverte").', true);
            btn.textContent = '✅ Extrait';
          } catch (e) { say(feedbackEl, 'Erreur de communication avec le serveur.', false); btn.disabled = false; }
        }
        function renderResults(list) {
          var body = $('results'); body.textContent = '';
          if (!list.length) { var tr0 = document.createElement('tr'); var td0 = document.createElement('td'); td0.colSpan = 6; td0.className = 'empty'; td0.textContent = 'Aucune communauté trouvée pour ces mots-clés.'; tr0.appendChild(td0); body.appendChild(tr0); return; }
          list.forEach(function (c) {
            var tr = document.createElement('tr');
            [c.name || '-', c.kind === 'channel' ? 'Canal' : 'Groupe', c.members != null ? String(c.members) : '-'].forEach(function (v) { var td = document.createElement('td'); td.textContent = v; tr.appendChild(td); });
            var tdl = document.createElement('td');
            if (c.link && /^https:\/\/(t\.me|chat\.whatsapp\.com)\//.test(c.link)) { var a = document.createElement('a'); a.href = c.link; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = c.link.replace('https://', ''); tdl.appendChild(a); } else tdl.textContent = '-';
            tr.appendChild(tdl);
            var tds = document.createElement('td'); tds.textContent = c.verified ? '✅ vérifié' : '⚠️ non vérifié'; tr.appendChild(tds);
            var tda = document.createElement('td'); tda.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
            var rowFeedback = document.createElement('span'); rowFeedback.hidden = true; rowFeedback.style.cssText = 'font-size:.8rem;flex-basis:100%;';
            var extractBtn = document.createElement('button'); extractBtn.type = 'button'; extractBtn.textContent = '👥 Extraire les membres';
            extractBtn.addEventListener('click', function () { extractMembers(c, extractBtn, rowFeedback); });
            if (channel === 'WHATSAPP') {
              var joinBtn = document.createElement('button'); joinBtn.type = 'button'; joinBtn.textContent = '➕ Rejoindre';
              extractBtn.disabled = true; extractBtn.title = 'Rejoignez d\'abord ce groupe (WhatsApp ne permet pas de lire les membres sans en être membre).';
              joinBtn.addEventListener('click', async function () {
                joinBtn.disabled = true; say(rowFeedback, 'Adhésion en cours…');
                try {
                  await ensureSynced(c);
                  var res = await localApiFetch('/api/communities/join', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: channel, ref: c.ref }) });
                  var data = await res.json();
                  if (!res.ok || !data.ok) { say(rowFeedback, (data && data.error) || 'Adhésion impossible.', false); joinBtn.disabled = false; return; }
                  say(rowFeedback, 'Groupe rejoint.', true); joinBtn.textContent = '✅ Rejoint'; extractBtn.disabled = false; extractBtn.title = '';
                } catch (e) { say(rowFeedback, 'Erreur de communication avec le serveur.', false); joinBtn.disabled = false; }
              });
              tda.appendChild(joinBtn);
            }
            tda.appendChild(extractBtn); tda.appendChild(rowFeedback);
            tr.appendChild(tda);
            body.appendChild(tr);
          });
        }
        $('search-btn').addEventListener('click', async function () {
          var kw = $('kw').value.trim();
          if (kw.length < 2) return say($('search-feedback'), 'Indiquez au moins un mot-clé.', false);
          $('search-btn').disabled = true; say($('search-feedback'), 'Recherche en cours…');
          try {
            var res = await localApiFetch('/api/communities/discover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: channel, keywords: kw, country: $('country').value.trim(), city: $('city').value.trim(), department: $('department').value.trim() }) });
            var data = await res.json();
            if (!res.ok || !data.ok) { say($('search-feedback'), (data && data.error) || 'Recherche impossible.', false); }
            else { lastResults = data.results || []; renderResults(lastResults); say($('search-feedback'), lastResults.length + ' communauté(s) trouvée(s).' + (channel === 'WHATSAPP' ? ' (WhatsApp n\'a pas d\'annuaire officiel : résultats issus d\'annuaires publics du web, vérifiés auprès de WhatsApp quand c\'est possible.)' : ''), true); $('sync-btn').hidden = !lastResults.length; }
          } catch (e) { if (e.message !== 'unauthorized') say($('search-feedback'), 'Erreur de communication avec le serveur.', false); }
          $('search-btn').disabled = false;
        });
        $('sync-btn').addEventListener('click', async function () {
          try {
            var res = await localApiFetch('/api/communities/sync', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: channel, communities: lastResults }) });
            var data = await res.json();
            say($('search-feedback'), data && data.ok ? (data.count + ' communauté(s) synchronisée(s) dans le CRM.') : ((data && data.error) || 'Synchronisation impossible.'), !!(data && data.ok));
          } catch (e) { /* géré */ }
        });
      }
      setup('wa', 'WHATSAPP'); setup('tg', 'TELEGRAM');

      // Recherche de PERSONNES par thématique (Telegram uniquement — voir la note affichée dans la section : WhatsApp n'a aucun
      // annuaire public de personnes). Bloc autonome, hors du setup(p, channel) générique ci-dessus car spécifique à un seul canal.
      (function initPeopleSearch() {
        var $ = function (s) { return document.getElementById('cm-tg-people-' + s); };
        if (!$('search-btn')) return;
        var lastResults = [];
        function say(el, msg, ok) { el.hidden = false; el.textContent = msg; el.className = ok === false ? 'error' : (ok ? 'ok' : 'empty'); }
        function renderResults(list) {
          var body = $('results'); body.textContent = '';
          if (!list.length) { var tr0 = document.createElement('tr'); var td0 = document.createElement('td'); td0.colSpan = 3; td0.className = 'empty'; td0.textContent = 'Aucune personne trouvée pour ces mots-clés.'; tr0.appendChild(td0); body.appendChild(tr0); return; }
          list.forEach(function (u) {
            var tr = document.createElement('tr');
            var tdn = document.createElement('td'); tdn.textContent = u.name || '-'; tr.appendChild(tdn);
            var tdu = document.createElement('td'); tdu.textContent = u.username ? ('@' + u.username) : '-'; tr.appendChild(tdu);
            var tdl = document.createElement('td');
            if (u.link) { var a = document.createElement('a'); a.href = u.link; a.target = '_blank'; a.rel = 'noopener noreferrer'; a.textContent = u.link.replace('https://', ''); tdl.appendChild(a); } else tdl.textContent = '-';
            tr.appendChild(tdl);
            body.appendChild(tr);
          });
        }
        $('search-btn').addEventListener('click', async function () {
          var kw = $('kw').value.trim();
          if (kw.length < 2) return say($('feedback'), 'Indiquez au moins un mot-clé.', false);
          $('search-btn').disabled = true; say($('feedback'), 'Recherche en cours…');
          try {
            var res = await localApiFetch('/api/communities/discover-people', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'TELEGRAM', keywords: kw, country: $('country').value.trim(), city: $('city').value.trim(), department: $('department').value.trim() }) });
            var data = await res.json();
            if (!res.ok || !data.ok) { say($('feedback'), (data && data.error) || 'Recherche impossible.', false); }
            else { lastResults = data.results || []; renderResults(lastResults); say($('feedback'), lastResults.length + ' personne(s) trouvée(s) (correspondance sur nom/pseudo, pas un vrai ciblage par intérêt).', true); $('sync-btn').hidden = !lastResults.length; }
          } catch (e) { if (e.message !== 'unauthorized') say($('feedback'), 'Erreur de communication avec le serveur.', false); }
          $('search-btn').disabled = false;
        });
        $('sync-btn').addEventListener('click', async function () {
          try {
            var res = await localApiFetch('/api/communities/discover-people', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ channel: 'TELEGRAM', keywords: $('kw').value.trim(), sync: true, country: $('country').value.trim(), city: $('city').value.trim(), department: $('department').value.trim() }) });
            var data = await res.json();
            say($('feedback'), data && data.ok ? (data.synced + ' personne(s) synchronisée(s) dans le CRM comme prospects à valider (étiquette "decouverte").') : ((data && data.error) || 'Synchronisation impossible.'), !!(data && data.ok));
          } catch (e) { /* géré */ }
        });
      })();
    })();
