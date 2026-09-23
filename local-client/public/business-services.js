// Gestion des Services Métiers portée de public/dashboard.html.
async function localApiFetch(url, options) { const response = await fetch(url, options); if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || 'HTTP ' + response.status); return response; }
    let svcWired = false;
    function svcEsc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function svcFeedback(msg, isError) {
      const el = document.getElementById('svc-feedback');
      if (!el) return;
      el.textContent = msg; el.hidden = false;
      el.style.cssText = 'margin:10px 0;padding:10px 12px;border-radius:8px;' + (isError ? 'background:rgba(248,113,113,.12);color:#f87171' : 'background:rgba(52,211,153,.12);color:#34d399');
    }
    function svcStatusClass(s) { return s === 'CONNECTED' ? 'svc-ok' : (s === 'ERROR' ? 'svc-err' : 'svc-warn'); }
    function svcParseLines(v) { return String(v || '').split('\n').map((x) => x.trim()).filter(Boolean); }
    function svcParseProducts(v) {
      return svcParseLines(v).map((line) => { const [name, price] = line.split('|').map((x) => x.trim()); return { name: name || line, price: price ? Number(price) : null }; });
    }
    function svcToggleApiFields() {
      const kind = document.getElementById('svc-conn-kind').value;
      document.getElementById('svc-api-fields').hidden = kind !== 'api';
      document.getElementById('svc-noapi-hint').hidden = kind !== 'account' && kind !== 'none';
    }
    function svcOpenForm(service) {
      const f = (id) => document.getElementById(id);
      const s = service || {};
      const c = s.commercial || {}; const conn = s.connection || {};
      f('svc-form-title').textContent = service ? 'Modifier le service' : 'Nouveau Service Métier';
      f('svc-id').value = s.id || '';
      f('svc-name').value = s.name || ''; f('svc-type').value = s.type || 'formation'; f('svc-project').value = s.project || '';
      f('svc-memo').value = c.memo || '';
      f('svc-desc').value = c.description || '';
      f('svc-price').value = c.price != null ? c.price : ''; f('svc-currency').value = c.currency || 'FCFA';
      f('svc-promo').value = c.promoPrice != null ? c.promoPrice : ''; f('svc-target').value = c.target || '';
      f('svc-advantages').value = c.advantages || ''; f('svc-objections').value = c.objections || '';
      f('svc-payterms').value = c.paymentTerms || ''; f('svc-accessterms').value = c.accessTerms || '';
      f('svc-products').value = (s.products || []).map((p) => `${p.name || p}${p.price != null ? ' | ' + p.price : ''}`).join('\n');
      f('svc-conn-kind').value = conn.kind || 'none'; f('svc-connector').value = conn.connectorType || 'generic';
      f('svc-baseurl').value = conn.baseUrl || ''; f('svc-authheader').value = conn.authHeader || 'X-API-Key'; f('svc-apikey').value = '';
      document.querySelectorAll('.svc-perm').forEach((cb) => { cb.checked = (s.scopes || []).includes(cb.value); });
      f('svc-rules').value = (s.rules || []).join('\n'); f('svc-objectives').value = (s.objectives || []).join('\n');
      svcToggleApiFields();
      f('svc-form').hidden = false; f('svc-feedback').hidden = true;
      f('svc-name').focus();
    }
    function svcCollectPayload() {
      const f = (id) => document.getElementById(id).value;
      const scopes = Array.from(document.querySelectorAll('.svc-perm')).filter((cb) => cb.checked).map((cb) => cb.value);
      const kind = f('svc-conn-kind'); const connectorType = f('svc-connector');
      const connection = { kind, connectorType: kind === 'api' ? connectorType : null, baseUrl: f('svc-baseurl') || null, authHeader: f('svc-authheader') || 'X-API-Key' };
      if (kind === 'api' && connectorType === 'platform_gateway') {
        connection.endpoints = { enroll: '/api/v1/agent-gateway/enroll-student', suspend: '/api/v1/agent-gateway/suspend-student' };
      }
      return {
        name: f('svc-name'), type: f('svc-type'), project: f('svc-project') || null,
        commercial: {
          memo: f('svc-memo'),
          price: f('svc-price') ? Number(f('svc-price')) : null, currency: f('svc-currency') || 'FCFA',
          promoPrice: f('svc-promo') ? Number(f('svc-promo')) : null, target: f('svc-target'),
          description: f('svc-desc'), advantages: f('svc-advantages'), objections: f('svc-objections'),
          paymentTerms: f('svc-payterms'), accessTerms: f('svc-accessterms'),
        },
        products: svcParseProducts(f('svc-products')), rules: svcParseLines(f('svc-rules')),
        objectives: svcParseLines(f('svc-objectives')), scopes, connection,
      };
    }
    async function svcSave(withTest) {
      const payload = svcCollectPayload();
      if (!payload.name) { svcFeedback('Donne un nom au service.', true); return; }
      const id = document.getElementById('svc-id').value;
      const apiKey = document.getElementById('svc-apikey').value.trim();
      try {
        let sid = id;
        if (id) { await localApiFetch('/api/business-services/' + id, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); }
        else { const r = await localApiFetch('/api/business-services', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); sid = (await r.json()).service.id; }
        if (payload.connection.kind === 'api' && apiKey) {
          await localApiFetch('/api/business-services/' + sid + '/connect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ apiKey, baseUrl: payload.connection.baseUrl, authHeader: payload.connection.authHeader, connectorType: payload.connection.connectorType, endpoints: payload.connection.endpoints }) });
        }
        if (withTest) {
          const tr = await localApiFetch('/api/business-services/' + sid + '/test', { method: 'POST' });
          const td = await tr.json();
          svcFeedback('Test : ' + (td.result ? (td.result.status + ' — ' + (td.result.detail || '')) : 'effectué'), !(td.result && (td.result.status === 'CONNECTED' || td.result.status === 'CONNECTED_LIMITED')));
        } else { svcFeedback('Service enregistré.', false); }
        document.getElementById('svc-form').hidden = true;
        svcLoadList();
      } catch (err) { if (err.message !== 'unauthorized') svcFeedback('Erreur : ' + err.message, true); }
    }
    async function svcTest(id) {
      svcFeedback('Test réel en cours…', false);
      try { const r = await localApiFetch('/api/business-services/' + id + '/test', { method: 'POST' }); const d = await r.json();
        svcFeedback('Test : ' + (d.result ? (d.result.status + ' — ' + (d.result.detail || '')) : 'effectué'), !(d.result && (d.result.status === 'CONNECTED' || d.result.status === 'CONNECTED_LIMITED')));
        svcLoadList();
      } catch (err) { if (err.message !== 'unauthorized') svcFeedback('Erreur : ' + err.message, true); }
    }
    async function svcDelete(id) {
      if (!confirm('Supprimer ce service et révoquer sa clé ?')) return;
      try { await localApiFetch('/api/business-services/' + id, { method: 'DELETE' }); svcLoadList(); svcFeedback('Service supprimé.', false); }
      catch (err) { if (err.message !== 'unauthorized') svcFeedback('Erreur : ' + err.message, true); }
    }
    function svcRender(services) {
      const box = document.getElementById('svc-list');
      box.innerHTML = '';
      if (!services.length) { box.innerHTML = '<p style="opacity:.6">Aucun service configuré. Clique sur « + Ajouter un Service Métier » pour commencer.</p>'; return; }
      services.forEach((s) => {
        const card = document.createElement('div'); card.className = 'svc-card';
        const conn = s.connection || {};
        const connLabel = conn.kind === 'api' ? ('API' + (conn.hasKey ? ' 🔑' : '')) : (conn.kind === 'account' ? 'Compte' : 'Interne');
        const price = s.commercial && s.commercial.price != null ? (s.commercial.price + ' ' + (s.commercial.currency || '')) : '—';
        const top = document.createElement('div'); top.className = 'svc-row';
        const left = document.createElement('div');
        left.innerHTML = '<strong>' + svcEsc(s.name) + '</strong> <span style="opacity:.6">· ' + svcEsc(s.type) + '</span><br><span style="opacity:.7;font-size:.85rem">Connexion : ' + connLabel + ' · Prix : ' + svcEsc(String(price)) + ' · Capacités : ' + ((s.scopes || []).length) + '</span>';
        const badge = document.createElement('span'); badge.className = 'svc-badge ' + svcStatusClass(s.status); badge.textContent = s.status || 'DRAFT';
        top.appendChild(left); top.appendChild(badge); card.appendChild(top);
        if (s.lastTest && s.lastTest.detail) { const lt = document.createElement('div'); lt.style.cssText = 'font-size:.8rem;opacity:.65;margin-top:6px'; lt.textContent = 'Dernier test : ' + s.lastTest.status + ' — ' + s.lastTest.detail; card.appendChild(lt); }
        const actions = document.createElement('div'); actions.style.cssText = 'margin-top:10px;display:flex;gap:8px;flex-wrap:wrap';
        const bManage = document.createElement('button'); bManage.textContent = '⚙️ Gérer'; bManage.addEventListener('click', () => svcOpenForm(s));
        const bTest = document.createElement('button'); bTest.textContent = '🔎 Tester'; bTest.addEventListener('click', () => svcTest(s.id));
        const bDel = document.createElement('button'); bDel.textContent = '🗑️'; bDel.addEventListener('click', () => svcDelete(s.id));
        actions.appendChild(bManage); if (conn.kind === 'api') actions.appendChild(bTest); actions.appendChild(bDel);
        card.appendChild(actions);
        box.appendChild(card);
      });
    }
    async function svcLoadList() {
      try { const r = await localApiFetch('/api/business-services'); const d = await r.json(); svcRender(d.services || []); }
      catch (err) { if (err.message !== 'unauthorized') document.getElementById('svc-list').innerHTML = '<p class="error">Impossible de charger les services.</p>'; }
    }
    function svcMetiersInit() {
      if (!svcWired) {
        svcWired = true;
        document.getElementById('svc-add-btn').addEventListener('click', () => svcOpenForm(null));
        document.getElementById('svc-cancel-btn').addEventListener('click', () => { document.getElementById('svc-form').hidden = true; });
        document.getElementById('svc-save-btn').addEventListener('click', () => svcSave(false));
        document.getElementById('svc-test-btn').addEventListener('click', () => svcSave(true));
        document.getElementById('svc-conn-kind').addEventListener('change', svcToggleApiFields);
      }
      svcLoadList();
    }

