// Port fid?le des gestionnaires Centre d?aide et Rapports VPS, avec API locale.
    function aideEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function aideRenderArticle(a) {
      const steps = (a.steps && a.steps.length)
        ? '<ol class="aide-steps">' + a.steps.map((s) => '<li>' + aideEsc(s) + '</li>').join('') + '</ol>'
        : '';
      return '<details><summary>' + aideEsc(a.title) + '</summary>'
        + '<p style="opacity:.85;margin:8px 0">' + aideEsc(a.summary) + '</p>'
        + '<p style="margin:8px 0">' + aideEsc(a.body) + '</p>' + steps + '</details>';
    }
    function aideRenderAll() {
      const box = document.getElementById('aide-content');
      if (!aideDoc) { box.innerHTML = '<p class="error">Documentation indisponible.</p>'; return; }
      let html = '';
      aideDoc.categories.forEach((cat) => {
        const arts = aideDoc.articles.filter((a) => a.category === cat.id);
        if (!arts.length) return;
        html += '<div class="aide-cat">' + aideEsc(cat.label) + '</div>';
        arts.forEach((a) => { html += aideRenderArticle(a); });
      });
      if (aideDoc.faq && aideDoc.faq.length) {
        html += '<div class="aide-faq"><div class="aide-cat">❓ FAQ</div>';
        aideDoc.faq.forEach((f) => {
          html += '<div class="aide-faq-item"><div class="aide-faq-q">' + aideEsc(f.q) + '</div><div style="opacity:.85">' + aideEsc(f.a) + '</div></div>';
        });
        html += '</div>';
      }
      box.innerHTML = html;
    }
    function aideRenderSearch(results) {
      const box = document.getElementById('aide-content');
      if (!results.length) { box.innerHTML = '<p style="opacity:.7">Aucun article ne correspond. Essaie d\'autres mots, ou pose ta question au Chat Intelligent.</p>'; return; }
      box.innerHTML = '<div class="aide-cat">Résultats</div>' + results.map(aideRenderArticle).join('');
    }
    async function aideInit() {
      const input = document.getElementById('aide-search');
      if (input && !input.dataset.wired) {
        input.dataset.wired = '1';
        let t = null;
        input.addEventListener('input', () => {
          clearTimeout(t);
          const q = input.value.trim();
          t = setTimeout(async () => {
            if (!q) { aideRenderAll(); return; }
            try { const r = await localApiFetch('/api/docs?q=' + encodeURIComponent(q)); const d = await r.json(); aideRenderSearch(d.results || []); }
            catch (e) { if (e.message !== 'unauthorized') aideRenderAll(); }
          }, 200);
        });
      }
      if (aideLoaded) return;
      try {
        const r = await localApiFetch('/api/docs');
        const d = await r.json();
        aideDoc = d.doc;
        aideLoaded = true;
        aideRenderAll();
      } catch (e) {
        if (e.message !== 'unauthorized') document.getElementById('aide-content').innerHTML = '<p class="error">Impossible de charger la documentation.</p>';
      }
    }

    // ===================== RAPPORTS, ACTIVITÉS & AMÉLIORATION =====================
    function repEsc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    function repStatusClass(s) { return s === 'ok' ? 'rep-ok' : (s === 'error' ? 'rep-err' : (s === 'warning' || s === 'pending' ? 'rep-warn' : '')); }
    function repIcon(s) { return s === 'ok' ? '✓' : (s === 'error' ? '✗' : (s === 'pending' ? '⏳' : (s === 'warning' ? '⚠' : '•'))); }
    function repBars(obj) {
      const entries = Object.entries(obj || {});
      if (!entries.length) return '<p style="opacity:.6">Aucune donnée.</p>';
      const max = Math.max(...entries.map(([, v]) => Number(v) || 0), 1);
      return entries.sort((a, b) => b[1] - a[1]).map(([k, v]) => {
        const pct = Math.round((Number(v) || 0) / max * 100);
        return '<div class="rep-bar-row"><div class="rep-bar-label">' + repEsc(k) + '</div><div class="rep-bar-track"><div class="rep-bar-fill" style="width:' + pct + '%"></div></div><div>' + v + '</div></div>';
      }).join('');
    }
    async function reportsInit() {
      const box = document.getElementById('reports-content');
      const rbtn = document.getElementById('reports-refresh');
      if (rbtn && !rbtn.dataset.wired) { rbtn.dataset.wired = '1'; rbtn.addEventListener('click', () => reportsLoad()); }
      reportsLoad();
    }
    async function reportsLoad() {
      const box = document.getElementById('reports-content');
      box.innerHTML = '<p style="opacity:.6">Chargement…</p>';
      let usage = null; let activity = null;
      try {
        const [ru, ra] = await Promise.all([
          localApiFetch('/api/reports/ai-usage').then((r) => r.json()).catch(() => null),
          localApiFetch('/api/reports/activity').then((r) => r.json()).catch(() => null),
        ]);
        usage = ru && ru.usage ? ru.usage : null;
        activity = ra && ra.activity ? ra.activity : null;
      } catch (e) { if (e.message === 'unauthorized') return; }
      const t = (usage && usage.totals) || { calls: 0, tokens: 0, cost: 0 };
      let html = '';
      html += '<div class="rep-section"><strong>💸 Coûts IA (aujourd\'hui)</strong>';
      html += '<div class="rep-kpis">'
        + '<div class="rep-kpi"><div class="v">' + (t.calls || 0) + '</div><div class="l">appels IA</div></div>'
        + '<div class="rep-kpi"><div class="v">' + (t.tokens || 0) + '</div><div class="l">tokens</div></div>'
        + '<div class="rep-kpi"><div class="v">$' + (Number(t.cost || 0)).toFixed(4) + '</div><div class="l">coût estimé</div></div>'
        + '</div></div>';
      if (activity && activity.counts) {
        html += '<div class="rep-section"><strong>📈 Activités par statut</strong>' + repBars(activity.counts.byStatus) + '</div>';
        if (activity.counts.byType && Object.keys(activity.counts.byType).length) {
          html += '<div class="rep-section"><strong>📊 Activités par type</strong>' + repBars(activity.counts.byType) + '</div>';
        }
      }
      const events = (activity && activity.events) || [];
      html += '<div class="rep-section"><strong>🕒 Flux d\'activités récentes</strong>';
      if (!events.length) {
        html += '<p style="opacity:.6;margin-top:6px">Aucune activité enregistrée pour le moment. Dès qu\'un message est reçu, qu\'une réponse automatique part ou qu\'une action est exécutée, elle apparaît ici en temps réel.</p>';
      } else {
        html += '<div class="rep-feed">' + events.map((e) => {
          const when = e.ts ? new Date(e.ts).toLocaleTimeString('fr-FR') : '';
          const label = (e.action || e.type) + (e.target ? ' → ' + e.target : '') + (e.detail ? ' · ' + e.detail : '');
          return '<div class="rep-evt"><div class="' + repStatusClass(e.status) + '">' + repIcon(e.status) + '</div><div class="rep-what">' + repEsc(label) + '</div><div class="rep-when">' + repEsc(when) + '</div></div>';
        }).join('') + '</div>';
      }
      html += '</div>';
      html += '<div class="rep-section" id="rep-intel"></div>';
      box.innerHTML = html;
      repIntelLoad();
    }

    // Centre d'intelligence : fait / pas fait / bloqué / à améliorer / amélioré (données réelles) + filtres + boucle d'amélioration.
    var repIntelFilters = {};
    async function repIntelLoad() {
      var host = document.getElementById('rep-intel'); if (!host) return;
      var qs = Object.keys(repIntelFilters).filter(function (k) { return repIntelFilters[k]; }).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(repIntelFilters[k]); }).join('&');
      host.innerHTML = '<p style="opacity:.6">Analyse des données réelles…</p>';
      var data = null; var imps = null;
      try {
        data = await localApiFetch('/api/reports/intelligence' + (qs ? '?' + qs : '')).then(function (r) { return r.json(); });
        imps = await localApiFetch('/api/reports/improvements').then(function (r) { return r.json(); }).catch(function () { return null; });
      } catch (e) { if (e.message === 'unauthorized') return; }
      var rep = data && data.report; if (!rep) { host.innerHTML = '<p class="rep-err">Rapport indisponible.</p>'; return; }
      var cols = [['DONE', '✅ Fait', 'done'], ['NOT_DONE', '⏳ Pas encore fait', 'notDone'], ['BLOCKED', '⛔ Bloqué', 'blocked'], ['TO_IMPROVE', '🔧 À améliorer', 'toImprove'], ['IMPROVED', '📈 Amélioré', 'improved']];
      var h = '<strong>🧠 Centre d\'intelligence — ce qui a été fait, bloqué et amélioré</strong>';
      h += '<div style="display:flex;flex-wrap:wrap;gap:8px;margin:10px 0">'
        + '<select id="rep-f-status"><option value="">Tous les statuts</option>' + cols.map(function (c) { return '<option value="' + c[0] + '"' + (repIntelFilters.status === c[0] ? ' selected' : '') + '>' + c[1] + '</option>'; }).join('') + '</select>'
        + '<select id="rep-f-channel"><option value="">Tous les canaux</option><option value="WHATSAPP"' + (repIntelFilters.channel === 'WHATSAPP' ? ' selected' : '') + '>WhatsApp</option><option value="TELEGRAM"' + (repIntelFilters.channel === 'TELEGRAM' ? ' selected' : '') + '>Telegram</option></select>'
        + '<select id="rep-f-period"><option value="7d">7 jours</option><option value="30d"' + (!repIntelFilters.period || repIntelFilters.period === '30d' ? ' selected' : '') + '>30 jours</option><option value="24h"' + (repIntelFilters.period === '24h' ? ' selected' : '') + '>24 h</option></select>'
        + '<input id="rep-f-client" placeholder="Client" value="' + repEsc(repIntelFilters.client || '') + '" style="max-width:120px">'
        + '<input id="rep-f-service" placeholder="Service (id)" value="' + repEsc(repIntelFilters.serviceId || '') + '" style="max-width:120px">'
        + '<input id="rep-f-campaign" placeholder="Campagne" value="' + repEsc(repIntelFilters.campaign || '') + '" style="max-width:120px">'
        + '<input id="rep-f-group" placeholder="Groupe" value="' + repEsc(repIntelFilters.group || '') + '" style="max-width:120px">'
        + '<input id="rep-f-action" placeholder="Type d\'action" value="' + repEsc(repIntelFilters.actionType || '') + '" style="max-width:120px">'
        + '<button type="button" id="rep-f-apply">Filtrer</button></div>';
      if (rep.note) h += '<p style="opacity:.7">' + repEsc(rep.note) + '</p>';
      h += '<div class="rep-kpis">' + cols.map(function (c) { return '<div class="rep-kpi"><div class="v">' + (rep.totals[c[0]] || 0) + '</div><div class="l">' + c[1] + '</div></div>'; }).join('') + '</div>';
      cols.forEach(function (c) {
        var list = rep.sections[c[2]] || []; if (!list.length) return;
        h += '<div class="rep-section"><strong>' + c[1] + '</strong><div class="rep-feed">' + list.slice(0, 15).map(function (i) {
          var extra = (i.reason ? ' — ' + i.reason : '') + (i.how ? ' · comment : ' + i.how : '') + (i.result && i.result.message ? ' · résultat : ' + i.result.message : '');
          return '<div class="rep-evt"><div class="rep-what">' + repEsc(i.title + extra) + '</div><div class="rep-when">' + (i.ts ? new Date(i.ts).toLocaleString('fr-FR') : '') + '</div></div>';
        }).join('') + '</div></div>';
      });
      var open = ((imps && imps.items) || []).filter(function (i) { return i.status === 'PROPOSED' || i.status === 'APPLIED'; });
      h += '<div class="rep-section"><strong>🔁 Recommandations d\'amélioration</strong> <button type="button" id="rep-imp-scan" style="font-size:.8rem;margin-left:8px">Analyser maintenant</button> <button type="button" id="rep-imp-ai" style="font-size:.8rem">Analyse par mes spécialistes</button><div id="rep-imp-ai-out" style="margin-top:6px"></div>';
      h += open.length ? '<div class="rep-feed">' + open.map(function (i) {
        var kind = i.kind === 'AUTO_SAFE' ? 'action sûre' : (i.kind === 'TECHNICAL' ? 'technique — proposée seulement' : 'validation requise');
        var btn = i.status === 'PROPOSED' && i.kind !== 'TECHNICAL' ? '<button type="button" data-imp-apply="' + repEsc(i.id) + '">Valider et appliquer</button>' : (i.status === 'APPLIED' ? '<button type="button" data-imp-measure="' + repEsc(i.id) + '">Mesurer le résultat</button>' : '');
        return '<div class="rep-evt"><div class="rep-what"><b>' + repEsc(i.recommendation) + '</b><br><small>Observation : ' + repEsc(i.observation) + ' · Diagnostic : ' + repEsc(i.diagnostic || '') + ' · ' + repEsc(kind) + (i.result && i.result.message ? ' · Résultat : ' + repEsc(i.result.message) : '') + '</small></div><div>' + btn + '</div></div>';
      }).join('') + '</div>' : '<p style="opacity:.6;margin-top:6px">Aucune recommandation ouverte. Cliquez sur « Analyser maintenant » pour observer vos données réelles.</p>';
      h += '</div>';
      host.innerHTML = h;
      var g = function (id) { var e = document.getElementById(id); return e ? e.value.trim() : ''; };
      document.getElementById('rep-f-apply').addEventListener('click', function () { repIntelFilters = { status: g('rep-f-status'), channel: g('rep-f-channel'), period: g('rep-f-period'), client: g('rep-f-client'), serviceId: g('rep-f-service'), campaign: g('rep-f-campaign'), group: g('rep-f-group'), actionType: g('rep-f-action') }; repIntelLoad(); });
      document.getElementById('rep-imp-scan').addEventListener('click', async function () { await localApiFetch('/api/reports/improvements/refresh', { method: 'POST' }).catch(function () {}); repIntelLoad(); });
      document.getElementById('rep-imp-ai').addEventListener('click', async function () {
        var out = document.getElementById('rep-imp-ai-out'); out.textContent = 'Analyse en cours…';
        var r = await localApiFetch('/api/reports/analysis', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ period: repIntelFilters.period || '30d', channel: repIntelFilters.channel || undefined }) }).then(function (x) { return x.json(); }).catch(function () { return null; });
        out.textContent = r && r.text ? r.text : 'Analyse indisponible.';
      });
      host.querySelectorAll('[data-imp-apply]').forEach(function (b) { b.addEventListener('click', async function () { await localApiFetch('/api/reports/improvements/' + encodeURIComponent(b.getAttribute('data-imp-apply')) + '/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approve: true }) }).catch(function () {}); repIntelLoad(); }); });
      host.querySelectorAll('[data-imp-measure]').forEach(function (b) { b.addEventListener('click', async function () { await localApiFetch('/api/reports/improvements/' + encodeURIComponent(b.getAttribute('data-imp-measure')) + '/measure', { method: 'POST' }).catch(function () {}); repIntelLoad(); }); });
    }

