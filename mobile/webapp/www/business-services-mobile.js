// Services métiers locaux du mobile : secrets Android Keystore, transport natif HTTPS.
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let editing = null;
  async function render() {
    const services = await Cyrus.db.getBusinessServices();
    const host = $('svc-list'); host.replaceChildren();
    if (!services.length) { host.textContent = 'Aucun service configuré.'; return; }
    services.forEach(s => {
      const c = s.commercial || {};
      const products = (s.products || []).map(p => typeof p === 'string' ? p : p.name + (p.price != null ? ' | ' + p.price : '')).join('\n');
      const facts = [c.description, c.target && 'Cible : ' + c.target, c.advantages && 'Avantages : ' + c.advantages,
        c.objections && 'Objections : ' + c.objections, c.paymentTerms && 'Paiement : ' + c.paymentTerms,
        c.accessTerms && 'Accès / livraison : ' + c.accessTerms, products && 'Produits :\n' + products,
        (s.objectives || []).length && 'Objectifs :\n' + s.objectives.join('\n')].filter(Boolean).join('\n\n');
      const price = c.price != null ? c.price + ' ' + (c.currency || 'FCFA') : (s.price || '');
      const replyModes = [s.waAutoReply && 'FAQ WhatsApp', s.waAiAutoReply && 'IA WhatsApp', s.tgAutoReply && 'FAQ Telegram', s.tgAiAutoReply && 'IA Telegram'].filter(Boolean).join(' + ') || 'désactivée';
      const card = document.createElement('div'); card.className = 'card';
      const title = document.createElement('b'); title.textContent = s.name; card.appendChild(title);
      const summary = document.createElement('p'); summary.textContent = (s.type || 'service') + (s.project ? ' · ' + s.project : '') + '\n' + (s.offer || c.description || '') + (price ? ' · ' + price : ''); card.appendChild(summary);
      const connection = s.connection || {};
      const status = document.createElement('p'); status.textContent = 'Connexion : ' + (s.status || 'DRAFT') + (connection.kind === 'api' ? ' · ' + (connection.connectorType || 'API') + (connection.hasKey ? ' · clé chiffrée présente' : ' · clé absente') : ''); card.appendChild(status);
      if (s.lastTest && s.lastTest.detail) { const last = document.createElement('small'); last.textContent = 'Dernier test : ' + s.lastTest.status + ' — ' + s.lastTest.detail; card.appendChild(last); }
      const replies = document.createElement('p'); replies.textContent = 'Réponse automatique : ' + replyModes; card.appendChild(replies);
      const details = document.createElement('details'); const summaryEl = document.createElement('summary'); summaryEl.textContent = 'Fiche commerciale, consignes et FAQ';
      const pre = document.createElement('pre'); pre.style.whiteSpace = 'pre-wrap'; pre.textContent = [c.memo || s.memo, facts, Array.isArray(s.rules) ? s.rules.join('\n') : s.rules, s.faq].filter(Boolean).join('\n\n');
      details.append(summaryEl, pre); card.appendChild(details);
      const edit = document.createElement('button'); edit.textContent = 'Modifier'; edit.addEventListener('click', () => fill(s)); card.appendChild(edit);
      if (connection.kind === 'api') { const test = document.createElement('button'); test.textContent = 'Tester'; test.addEventListener('click', () => testConnection(s.id)); card.appendChild(test); }
      const remove = document.createElement('button'); remove.textContent = 'Supprimer'; remove.addEventListener('click', () => deleteService(s)); card.appendChild(remove);
      const actions = createServiceActions(s); if (actions) card.appendChild(actions);
      host.appendChild(card);
    });
  }
  function fill(s) {
    const c = s && s.commercial || {};
    editing = s && s.id;
    $('svc-name').value = s && s.name || ''; $('svc-type').value = s && s.type || 'formation'; $('svc-project').value = s && s.project || '';
    $('svc-offer').value = s && s.offer || ''; $('svc-price').value = s && s.price || (c.price != null ? c.price : '');
    $('svc-currency').value = c.currency || 'FCFA'; $('svc-promo').value = c.promoPrice != null ? c.promoPrice : '';
    $('svc-memo').value = c.memo || s && s.memo || ''; $('svc-description').value = c.description || '';
    $('svc-target').value = c.target || ''; $('svc-advantages').value = c.advantages || ''; $('svc-objections').value = c.objections || '';
    $('svc-payment-terms').value = c.paymentTerms || ''; $('svc-access-terms').value = c.accessTerms || '';
    $('svc-products').value = (s && s.products || []).map(p => typeof p === 'string' ? p : p.name + (p.price != null ? ' | ' + p.price : '')).join('\n');
    $('svc-objectives').value = (s && s.objectives || []).join('\n'); $('svc-faq').value = s && s.faq || ''; $('svc-rules').value = (s && s.rules || []).join ? (s && s.rules || []).join('\n') : (s && s.rules || '');
    $('svc-wa-autoreply').checked = !!(s && s.waAutoReply);
    $('svc-wa-ai-autoreply').checked = !!(s && s.waAiAutoReply);
    $('svc-tg-autoreply').checked = !!(s && s.tgAutoReply);
    $('svc-tg-ai-autoreply').checked = !!(s && s.tgAiAutoReply);
    const conn = s && s.connection || {};
    $('svc-conn-kind').value = conn.kind || 'none'; $('svc-connector').value = conn.connectorType || 'generic';
    $('svc-baseurl').value = conn.baseUrl || ''; $('svc-authheader').value = conn.authHeader || 'X-API-Key';
    $('svc-apikey').value = ''; $('svc-endpoint-enroll').value = conn.endpoints && conn.endpoints.enroll || '/api/v1/agent-gateway/enroll-student';
    $('svc-endpoint-suspend').value = conn.endpoints && conn.endpoints.suspend || '/api/v1/agent-gateway/suspend-student';
    document.querySelectorAll('.svc-perm').forEach(cb => { cb.checked = !!(s && (s.scopes || []).includes(cb.value)); });
    toggleConnectionFields();
    $('svc-key-status').textContent = conn.hasKey ? 'Clé API chiffrée enregistrée; saisir une nouvelle clé pour la remplacer.' : 'Aucune clé API enregistrée.';
  }
  function lines(value) { return String(value || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean); }
  function products(value) { return lines(value).map(line => { const i = line.lastIndexOf('|'); return i < 0 ? { name: line, price: null } : { name: line.slice(0, i).trim(), price: line.slice(i + 1).trim() || null }; }); }
  function toggleConnectionFields() {
    const api = $('svc-conn-kind').value === 'api';
    $('svc-api-fields').hidden = !api;
    $('svc-noapi-hint').hidden = api;
  }
  function actionField(host, caption, name, type, placeholder) {
    const label = document.createElement('label'); label.textContent = caption;
    const input = document.createElement('input'); input.type = type || 'text'; input.dataset.field = name; input.placeholder = placeholder || '';
    label.appendChild(input); host.appendChild(label); return input;
  }
  function actionButton(host, caption, handler) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = caption;
    button.addEventListener('click', handler); host.appendChild(button);
  }
  function createServiceActions(service) {
    const conn = service.connection || {};
    if (conn.kind !== 'api') return null;
    const panel = document.createElement('details'); panel.className = 'card';
    const heading = document.createElement('summary'); heading.textContent = 'Actions autorisées'; panel.appendChild(heading);
    if (conn.connectorType !== 'accounting' && !conn.hasKey) { const note = document.createElement('p'); note.textContent = 'Enregistre une clé API puis teste la connexion avant toute action.'; panel.appendChild(note); return panel; }
    if (service.status !== 'CONNECTED') { const note = document.createElement('p'); note.textContent = 'Teste la connexion avant d’utiliser les actions de ce service.'; panel.appendChild(note); return panel; }
    const scopes = new Set(service.scopes || []);
    if (conn.connectorType === 'platform_gateway') {
      const email = actionField(panel, 'Email du client', 'email', 'email', 'nom@exemple.com');
      const course = actionField(panel, 'Identifiant de formation', 'courseId', 'text', 'formation-001');
      const months = actionField(panel, 'Durée de validité (mois, facultatif)', 'validityMonths', 'number', '12');
      if (scopes.has('students:create') || scopes.has('courses:enroll')) actionButton(panel, 'Créer / inscrire le compte', () => runPlatformAction(service.id, 'enroll', { email, course, months }));
      if (scopes.has('students:suspend')) actionButton(panel, 'Suspendre l’accès', () => runPlatformAction(service.id, 'suspend', { email }));
      if (!scopes.has('students:create') && !scopes.has('courses:enroll') && !scopes.has('students:suspend')) { const note = document.createElement('p'); note.textContent = 'Aucune permission d’action n’est accordée.'; panel.appendChild(note); }
    } else if (conn.connectorType === 'systemio') {
      const email = actionField(panel, 'Email du contact', 'email', 'email', 'nom@exemple.com');
      const firstName = actionField(panel, 'Prénom (facultatif)', 'firstName', 'text', 'Prénom');
      const tag = actionField(panel, 'Nom du tag', 'tag', 'text', 'Prospect');
      if (scopes.has('contacts:write')) actionButton(panel, 'Ajouter / retrouver le contact', () => runSystemIoAction(service.id, 'contact', { email, firstName }));
      if (scopes.has('tags:write')) actionButton(panel, 'Créer / attribuer le tag', () => runSystemIoAction(service.id, 'tag', { email, firstName, tag }));
      if (!scopes.has('contacts:write') && !scopes.has('tags:write')) { const note = document.createElement('p'); note.textContent = 'Aucune permission d’action n’est accordée.'; panel.appendChild(note); }
    } else if (conn.connectorType === 'accounting' && scopes.has('accounting:write')) {
      const amount = actionField(panel, 'Montant confirmé', 'amount', 'number', '15000'); amount.min = '0.01'; amount.step = '0.01';
      const currency = actionField(panel, 'Devise', 'currency', 'text', 'FCFA'); currency.value = 'FCFA';
      const product = actionField(panel, 'Produit (facultatif)', 'product', 'text', 'Formation');
      const customer = actionField(panel, 'Client (facultatif)', 'customer', 'text', 'email ou téléphone');
      const reference = actionField(panel, 'Référence de paiement (facultatif)', 'reference', 'text', 'Référence');
      actionButton(panel, 'Enregistrer la vente', () => recordAccounting(service.id, 'sale', { amount, currency, product, customer, reference }));
      actionButton(panel, 'Générer une facture locale', () => recordAccounting(service.id, 'invoice', { amount, currency, product, customer }));
    } else {
      const note = document.createElement('p'); note.textContent = 'Aucune action mobile n’est définie pour ce type de connecteur.'; panel.appendChild(note);
    }
    return panel;
  }
  async function serviceRequest(service, path, method, body) {
    const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CyrusNativeHttp;
    if (!plugin || typeof plugin.request !== 'function') throw new Error('Le transport API sécurisé nécessite la version Android installée.');
    const conn = service.connection || {};
    const base = String(conn.baseUrl || (conn.connectorType === 'systemio' ? 'https://api.systeme.io/api' : '')).replace(/\/+$/, '');
    if (!base) throw new Error('URL de base manquante.');
    const baseUrl = new URL(base);
    if (baseUrl.protocol !== 'https:') throw new Error('L’API doit utiliser HTTPS.');
    const url = path ? base + '/' + String(path).replace(/^\/+/, '') : base;
    const target = new URL(url);
    if (target.origin !== baseUrl.origin) throw new Error('Le chemin API doit rester sur le domaine configuré.');
    return plugin.request({ url: target.href, method: method || 'GET', headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      authHeader: conn.connectorType === 'systemio' ? 'X-API-Key' : (conn.authHeader || 'X-API-Key'),
      secretRef: conn.hasKey ? service.id : '', body: body === undefined ? '' : JSON.stringify(body) });
  }
  function responseData(result) { try { return JSON.parse(result.body || '{}'); } catch (_) { return {}; } }
  async function testConnection(id) {
    const services = await Cyrus.db.getBusinessServices(); const service = services.find(s => s.id === id);
    if (!service) return;
    const conn = service.connection || {}; const feedback = $('svc-feedback');
    feedback.textContent = 'Test réel de la connexion en cours…';
    try {
      let result;
      if (conn.kind !== 'api') result = { status: 'CONFIGURATION_INCOMPLETE', detail: 'Aucune API configurée.' };
      else if (conn.connectorType === 'accounting') result = { status: 'CONNECTED', detail: 'Journal comptable local disponible sur cet appareil.' };
      else if (conn.connectorType === 'platform_gateway') {
        const path = conn.endpoints && conn.endpoints.suspend || '/api/v1/agent-gateway/suspend-student';
        const res = await serviceRequest(service, path, 'POST', { email: 'cyrus-connection-test@example.invalid' });
        result = res.status === 404 ? { status: 'CONNECTED', detail: 'API joignable; le compte de test inexistant a retourné le 404 attendu.', httpStatus: 404 }
          : res.status === 401 ? { status: 'AUTHENTICATION_FAILED', detail: 'Clé API refusée.', httpStatus: 401 }
            : res.status === 403 ? { status: 'CONNECTED_LIMITED', detail: 'API joignable, permission de test refusée.', httpStatus: 403 }
              : res.ok ? { status: 'CONNECTED', detail: 'API authentifiée et joignable.', httpStatus: res.status }
                : { status: 'PARTIAL', detail: 'Réponse inattendue (HTTP ' + res.status + ').', httpStatus: res.status };
      } else {
        const path = conn.connectorType === 'systemio' ? 'tags' : '';
        const res = await serviceRequest(service, path, 'GET');
        result = res.status === 401 ? { status: 'AUTHENTICATION_FAILED', detail: 'Clé API refusée.', httpStatus: 401 }
          : res.status === 403 ? { status: 'CONNECTED_LIMITED', detail: 'API joignable, permission de lecture refusée.', httpStatus: 403 }
            : res.status >= 500 ? { status: 'SERVICE_UNAVAILABLE', detail: 'Service indisponible (HTTP ' + res.status + ').', httpStatus: res.status }
              : { status: 'CONNECTED', detail: 'API joignable (HTTP ' + res.status + ').', httpStatus: res.status };
      }
      service.lastTest = Object.assign({ at: new Date().toISOString() }, result);
      service.status = ['CONNECTED', 'CONNECTED_LIMITED'].includes(result.status) ? 'CONNECTED' : (result.status === 'CONFIGURATION_INCOMPLETE' ? 'CONFIGURED' : 'ERROR');
      await Cyrus.db.saveBusinessService(service); await render();
      feedback.textContent = 'Test : ' + result.status + ' — ' + result.detail;
    } catch (error) {
      service.lastTest = { at: new Date().toISOString(), status: 'SERVICE_UNAVAILABLE', detail: String(error.message || error) };
      service.status = 'ERROR'; await Cyrus.db.saveBusinessService(service); await render();
      feedback.textContent = 'Test : SERVICE_UNAVAILABLE — ' + String(error.message || error);
    }
  }
  async function deleteService(service) {
    if (!window.confirm('Supprimer cette fiche et sa clé API chiffrée ?')) return;
    try {
      if (service.connection && service.connection.hasKey) {
        const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CyrusSecureStore;
        if (!plugin) throw new Error('Coffre sécurisé Android indisponible; la fiche reste conservée.');
        await plugin.remove({ serviceId: service.id });
      }
      await Cyrus.db.deleteBusinessService(service.id); await render();
    } catch (error) { $('svc-feedback').textContent = 'Suppression impossible : ' + error.message; }
  }
  function actionEmail(input) {
    const email = String(input.value || '').trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Saisis une adresse email valide.');
    return email;
  }
  async function runPlatformAction(id, operation, fields) {
    try {
      const services = await Cyrus.db.getBusinessServices(); const service = services.find(s => s.id === id); if (!service) throw new Error('Service introuvable.');
      const scopes = new Set(service.scopes || []); const email = actionEmail(fields.email);
      if (operation === 'enroll') {
        if (!scopes.has('students:create') && !scopes.has('courses:enroll')) throw new Error('Permission d’inscription absente.');
        const courseId = String(fields.course.value || '').trim(); if (!courseId) throw new Error('Identifiant de formation requis.');
        if (!window.confirm('Confirmer la création ou l’inscription du compte ' + email + ' à « ' + courseId + ' » ?')) return;
        const body = { email, course_id: courseId }; const months = Number(fields.months.value); if (months > 0) body.validity_months = months;
        const res = await serviceRequest(service, service.connection.endpoints && service.connection.endpoints.enroll || '/api/v1/agent-gateway/enroll-student', 'POST', body);
        if (!res.ok) throw new Error('HTTP ' + res.status + ' — ' + (responseData(res).error || responseData(res).message || res.body));
        const data = responseData(res); const confirmed = (data.ok === true && !!data.uid) || typeof data.account_created === 'boolean';
        $('svc-feedback').textContent = confirmed ? 'Passerelle confirmée : ' + email + (data.account_created === true ? ' · compte créé' : '') + (data.password_reset_link ? ' · lien de définition reçu' : '') : 'HTTP ' + res.status + ', sans confirmation explicite de création/inscription.';
      } else {
        if (!scopes.has('students:suspend')) throw new Error('Permission de suspension absente.');
        if (!window.confirm('Confirmer la suspension réversible de l’accès de ' + email + ' ?')) return;
        const res = await serviceRequest(service, service.connection.endpoints && service.connection.endpoints.suspend || '/api/v1/agent-gateway/suspend-student', 'POST', { email });
        if (!res.ok) throw new Error('HTTP ' + res.status + ' — ' + (responseData(res).error || responseData(res).message || res.body));
        $('svc-feedback').textContent = 'La passerelle a accepté la suspension de ' + email + ' (HTTP ' + res.status + ').';
      }
    } catch (error) { $('svc-feedback').textContent = 'Action non confirmée : ' + String(error.message || error); }
  }
  async function runSystemIoAction(id, operation, fields) {
    try {
      const services = await Cyrus.db.getBusinessServices(); const service = services.find(s => s.id === id); if (!service) throw new Error('Service introuvable.');
      const scopes = new Set(service.scopes || []); const email = actionEmail(fields.email);
      if (operation === 'contact' && !scopes.has('contacts:write')) throw new Error('Permission contacts:write absente.');
      if (operation === 'tag' && !scopes.has('tags:write')) throw new Error('Permission tags:write absente.');
      const tag = fields.tag && String(fields.tag.value || '').trim();
      if (operation === 'tag' && !tag) throw new Error('Saisis un nom de tag.');
      if (!window.confirm(operation === 'tag' ? 'Créer ou retrouver le contact ' + email + ' et attribuer le tag « ' + tag + ' » ?' : 'Ajouter ou retrouver le contact ' + email + ' dans System.io ?')) return;
      const pathEmail = 'contacts?email=' + encodeURIComponent(email);
      const found = await serviceRequest(service, pathEmail, 'GET');
      if (!found.ok) throw new Error('Recherche contact refusée (HTTP ' + found.status + ').');
      const foundData = responseData(found); let contact = foundData.items && foundData.items[0];
      if (!contact) {
        const firstName = fields.firstName && String(fields.firstName.value || '').trim();
        const body = { email }; if (firstName) body.fields = [{ slug: 'first_name', value: firstName }];
        const created = await serviceRequest(service, 'contacts', 'POST', body);
        if (!created.ok) throw new Error('Création contact refusée (HTTP ' + created.status + ').');
        contact = responseData(created);
      }
      if (!contact || !contact.id) throw new Error('System.io n’a pas renvoyé d’identifiant de contact; résultat non confirmé.');
      if (operation === 'contact') { $('svc-feedback').textContent = 'Contact System.io confirmé : ' + email + (foundData.items && foundData.items.length ? ' (déjà présent).' : ' (créé).'); return; }
      const tagsRes = await serviceRequest(service, 'tags', 'GET');
      if (!tagsRes.ok) throw new Error('Lecture des tags refusée (HTTP ' + tagsRes.status + ').');
      const tagsData = responseData(tagsRes); let tagRow = (tagsData.items || []).find(row => String(row.name || '').toLowerCase() === tag.toLowerCase());
      if (!tagRow) {
        const createdTag = await serviceRequest(service, 'tags', 'POST', { name: tag });
        if (!createdTag.ok) throw new Error('Création du tag refusée (HTTP ' + createdTag.status + ').');
        tagRow = responseData(createdTag);
      }
      if (!tagRow || !tagRow.id) throw new Error('System.io n’a pas confirmé l’identifiant du tag.');
      const assigned = await serviceRequest(service, 'contacts/' + encodeURIComponent(contact.id) + '/tags', 'POST', { tagId: tagRow.id });
      if (!assigned.ok) throw new Error('Attribution du tag refusée (HTTP ' + assigned.status + ').');
      $('svc-feedback').textContent = 'Tag « ' + tag + ' » attribué à ' + email + ' (HTTP ' + assigned.status + ').';
    } catch (error) { $('svc-feedback').textContent = 'Action non confirmée : ' + String(error.message || error); }
  }
  async function recordAccounting(id, kind, fields) {
    try {
      const service = (await Cyrus.db.getBusinessServices()).find(s => s.id === id); if (!service) throw new Error('Service introuvable.');
      if (!(service.scopes || []).includes('accounting:write')) throw new Error('Permission accounting:write absente.');
      const amount = Number(fields.amount.value); if (!Number.isFinite(amount) || amount <= 0) throw new Error('Le montant doit être supérieur à zéro.');
      if (!window.confirm(kind === 'sale' ? 'Confirmer l’enregistrement local de cette vente encaissée ?' : 'Confirmer la création d’une facture locale ?')) return;
      const entry = { amount, currency: String(fields.currency.value || 'FCFA').trim() || 'FCFA', product: String(fields.product.value || '').trim() || null, customer: String(fields.customer.value || '').trim() || null };
      const saved = kind === 'sale' ? await Cyrus.db.saveSale(Object.assign({}, entry, { reference: String(fields.reference.value || '').trim() || null })) : await Cyrus.db.saveInvoice(entry);
      $('svc-feedback').textContent = kind === 'sale' ? 'Vente enregistrée localement · ' + saved.amount + ' ' + saved.currency + '.' : 'Facture locale créée : ' + saved.invoiceNumber + ' · ' + saved.amount + ' ' + saved.currency + '.';
    } catch (error) { $('svc-feedback').textContent = 'Écriture comptable refusée : ' + String(error.message || error); }
  }
  async function promptContext(prompt) {
    if (!$('ai-business-context') || !$('ai-business-context').checked) return prompt;
    const services = await Cyrus.db.getBusinessServices();
    if (!services.length) return prompt;
    const context = services.map(s => {
      const c = s.commercial || {};
      return [s.name && 'Service : ' + s.name, s.type && 'Type : ' + s.type, s.project && 'Projet : ' + s.project,
        c.description || s.offer, c.memo || s.memo, c.price != null && 'Prix : ' + c.price + ' ' + (c.currency || 'FCFA'),
        c.promoPrice != null && 'Prix promotionnel : ' + c.promoPrice + ' ' + (c.currency || 'FCFA'),
        c.target && 'Clientèle cible : ' + c.target, c.advantages && 'Avantages : ' + c.advantages,
        c.objections && 'Objections : ' + c.objections, c.paymentTerms && 'Conditions de paiement : ' + c.paymentTerms,
        c.accessTerms && 'Conditions d’accès : ' + c.accessTerms,
        (s.products || []).length && 'Produits : ' + (s.products || []).map(p => typeof p === 'string' ? p : p.name + (p.price != null ? ' (' + p.price + ')' : '')).join(', '),
        (s.objectives || []).length && 'Objectifs : ' + s.objectives.join('; '), s.rules && 'Règles : ' + (Array.isArray(s.rules) ? s.rules.join('; ') : s.rules), s.faq && 'FAQ :\n' + s.faq].filter(Boolean).join('\n');
    }).join('\n---\n');
    return 'Contexte commercial fourni par l’utilisateur (ne rien inventer au-delà de ces informations):\n' + context + '\n\nDemande:\n' + prompt;
  }
  async function saveService(withTest) {
    const name = $('svc-name').value.trim();
    if (!name) { $('svc-feedback').textContent = 'Le nom du service est requis.'; return; }
    const price = $('svc-price').value.trim(); const promo = $('svc-promo').value.trim(); const currency = $('svc-currency').value.trim() || 'FCFA';
    const kind = $('svc-conn-kind').value; const connectorType = $('svc-connector').value;
    const services = await Cyrus.db.getBusinessServices(); const existing = editing && services.find(s => s.id === editing);
    const apiKey = $('svc-apikey').value.trim();
    const baseUrl = $('svc-baseurl').value.trim() || (connectorType === 'systemio' ? 'https://api.systeme.io/api' : '');
    if (kind === 'api' && !baseUrl) { $('svc-feedback').textContent = 'URL de base requise pour ce connecteur API.'; return; }
    if (kind === 'api' && baseUrl) {
      let parsed;
      try { parsed = new URL(baseUrl); } catch (_) { $('svc-feedback').textContent = 'URL API invalide.'; return; }
      if (parsed.protocol !== 'https:') { $('svc-feedback').textContent = 'L’API doit utiliser HTTPS pour protéger la clé.'; return; }
      if (parsed.username || parsed.password) { $('svc-feedback').textContent = 'Ne place pas d’identifiants dans l’URL API.'; return; }
    }
    const authHeader = $('svc-authheader').value.trim() || 'X-API-Key';
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,100}$/.test(authHeader)) { $('svc-feedback').textContent = 'Nom d’en-tête d’authentification invalide.'; return; }
    const scopes = Array.from(document.querySelectorAll('.svc-perm')).filter(cb => cb.checked).map(cb => cb.value);
    const connection = { kind, connectorType: kind === 'api' ? connectorType : null, baseUrl: baseUrl || null, authHeader,
      hasKey: kind === 'api' && !!(existing && existing.connection && existing.connection.hasKey),
      endpoints: kind === 'api' && connectorType === 'platform_gateway' ? { enroll: $('svc-endpoint-enroll').value.trim() || '/api/v1/agent-gateway/enroll-student', suspend: $('svc-endpoint-suspend').value.trim() || '/api/v1/agent-gateway/suspend-student' } : null };
    if (kind === 'api' && existing && existing.connection && existing.connection.hasKey && !apiKey) {
      try {
        if (new URL(existing.connection.baseUrl || '').origin !== new URL(baseUrl).origin) {
          $('svc-feedback').textContent = 'Saisis à nouveau la clé API pour autoriser son utilisation sur cette nouvelle origine.'; return;
        }
      } catch (_) { $('svc-feedback').textContent = 'Saisis à nouveau la clé API pour modifier son origine.'; return; }
    }
    try {
      if (kind !== 'api' && existing && existing.connection && existing.connection.hasKey) {
        const secure = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CyrusSecureStore;
        if (!secure) throw new Error('Coffre sécurisé Android indisponible; la clé existante est conservée.');
        await secure.remove({ serviceId: existing.id });
      }
      const row = await Cyrus.db.saveBusinessService({ id: editing, name, type: $('svc-type').value, project: $('svc-project').value.trim(),
        offer: $('svc-offer').value.trim(), price, commercial: { memo: $('svc-memo').value.trim(), description: $('svc-description').value.trim(),
          price: price ? Number(price) : null, currency, promoPrice: promo ? Number(promo) : null, target: $('svc-target').value.trim(),
          advantages: $('svc-advantages').value.trim(), objections: $('svc-objections').value.trim(), paymentTerms: $('svc-payment-terms').value.trim(), accessTerms: $('svc-access-terms').value.trim() },
        products: products($('svc-products').value), objectives: lines($('svc-objectives').value), faq: $('svc-faq').value.trim(),
        rules: lines($('svc-rules').value), waAutoReply: $('svc-wa-autoreply').checked, waAiAutoReply: $('svc-wa-ai-autoreply').checked,
        tgAutoReply: $('svc-tg-autoreply').checked, tgAiAutoReply: $('svc-tg-ai-autoreply').checked,
        connection, scopes, status: kind === 'api' ? 'CONFIGURED' : 'DRAFT', lastTest: kind === 'api' ? (existing && existing.lastTest || null) : null,
        createdAt: existing && existing.createdAt, history: existing && existing.history || [] });
      if (kind === 'api' && apiKey) {
        const secure = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CyrusSecureStore;
        if (!secure) throw new Error('Coffre chiffré Android indisponible; la fiche est enregistrée sans nouvelle clé.');
        await secure.set({ serviceId: row.id, value: apiKey, baseUrl: row.connection.baseUrl });
        row.connection.hasKey = true;
        await Cyrus.db.saveBusinessService(row);
      }
      $('svc-apikey').value = '';
      if (withTest && kind === 'api') {
        await render();
        await testConnection(row.id);
      } else {
        $('svc-feedback').textContent = kind === 'api' ? 'Service enregistré sur cet appareil. ' + (row.connection.hasKey ? 'Clé conservée dans le coffre Android.' : 'Aucune clé API configurée.') : 'Service enregistré sur cet appareil.';
        await render();
      }
      editing = null; fill(null);
    } catch (error) { $('svc-feedback').textContent = 'Enregistrement impossible : ' + String(error.message || error); }
  }
  $('svc-save').addEventListener('click', () => saveService(false));
  $('svc-test').addEventListener('click', () => saveService(true));
  $('svc-conn-kind').addEventListener('change', toggleConnectionFields);
  render().catch(e => { $('svc-list').textContent = 'Stockage local indisponible : ' + e.message; });
  const repliedIds = new Set();
  const aiUsageByContact = new Map();
  function normalizeQuestion(text) { return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function conversationKey(channel, from) { return 'cyrus_' + channel + '_auto_history_' + encodeURIComponent(String(from)); }
  function readConversation(channel, from) {
    try { const value = JSON.parse(localStorage.getItem(conversationKey(channel, from)) || '[]'); return Array.isArray(value) ? value : []; }
    catch (_) { return []; }
  }
  function saveConversation(channel, from, message) {
    const history = readConversation(channel, from);
    if (!message.id || !history.some(item => item.id === message.id)) {
      history.push({ id: message.id, role: message.fromMe ? 'assistant' : 'customer', text: String(message.body || '').slice(0, 1200), at: Date.now() });
      try { localStorage.setItem(conversationKey(channel, from), JSON.stringify(history.slice(-12))); } catch (_) { /* stockage local plein : la réponse reste possible sans historique sauvegardé */ }
    }
  }
  function allowAiReply(channel, identifier) {
    const now = Date.now();
    const key = channel + ':' + identifier;
    let recent = aiUsageByContact.get(key) || [];
    try {
      const stored = JSON.parse(localStorage.getItem('cyrus_' + channel + '_ai_usage_' + encodeURIComponent(identifier)) || '[]');
      if (Array.isArray(stored)) recent = stored.concat(recent.filter(at => !stored.includes(at)));
    } catch (_) { /* la limite mémoire reste active */ }
    recent = recent.filter(at => Number.isFinite(at) && now - at < 60 * 60 * 1000);
    if (recent.length >= 10) return false;
    recent.push(now);
    aiUsageByContact.set(key, recent);
    try { localStorage.setItem('cyrus_' + channel + '_ai_usage_' + encodeURIComponent(identifier), JSON.stringify(recent)); } catch (_) { /* limite également conservée en mémoire */ }
    return true;
  }
  function serviceContext(service) {
    const c = service.commercial || {};
    const productsText = (service.products || []).map(p => typeof p === 'string' ? p : [p.name, p.price != null && 'Prix: ' + p.price].filter(Boolean).join(' — ')).join('\n');
    return [
      service.name && 'Nom : ' + service.name, service.type && 'Type : ' + service.type, service.project && 'Projet : ' + service.project,
      service.offer && 'Offre : ' + service.offer, c.description && 'Description : ' + c.description, c.memo && 'Mémo : ' + c.memo,
      c.price != null && 'Prix : ' + c.price + ' ' + (c.currency || 'FCFA'), c.promoPrice != null && 'Prix promotionnel : ' + c.promoPrice + ' ' + (c.currency || 'FCFA'),
      c.target && 'Clientèle cible : ' + c.target, c.advantages && 'Avantages : ' + c.advantages, c.objections && 'Objections : ' + c.objections,
      c.paymentTerms && 'Paiement : ' + c.paymentTerms, c.accessTerms && 'Accès/livraison : ' + c.accessTerms,
      productsText && 'Produits :\n' + productsText, (service.objectives || []).length && 'Objectifs : ' + service.objectives.join('; '),
      service.rules && 'Règles : ' + (Array.isArray(service.rules) ? service.rules.join('; ') : service.rules), service.faq && 'FAQ :\n' + service.faq,
    ].filter(Boolean).join('\n').slice(0, 6000);
  }
  function buildReplyPrompt(service, message, channel, conversationId) {
    const history = readConversation(channel, conversationId || message.from).filter(item => item.id !== message.id).slice(-7).map(item => (item.role === 'customer' ? 'Client' : 'Vendeur') + ' : ' + item.text).join('\n');
    const context = serviceContext(service);
    return [
      'Tu réponds directement au client au nom du vendeur, avec un ton naturel, humain, chaleureux et concis. Rédige uniquement le message à envoyer, en 1 à 4 phrases.',
      'Contexte métier réel fourni par le vendeur :\n' + (context || 'Aucune information métier n’est renseignée.'),
      history ? 'Historique récent de cette conversation :\n' + history : '',
      'N’invente aucun produit, prix, promotion, condition, moyen de paiement, délai ni promesse. Si une information manque, dis-le simplement et propose de revenir avec la réponse exacte. Ne confirme jamais un paiement reçu ou un accès activé. Ne répète pas une salutation si la conversation a déjà commencé.',
      'Nouveau message du client : ' + String(message.body || '').slice(0, 1200),
    ].filter(Boolean).join('\n\n').slice(0, 9000);
  }
  function sendAutoReply(message, text, channel) {
    const bridge = channel === 'telegram' ? 'telegram' : 'whatsapp';
    const send = channel === 'telegram' ? '__cyrusTgSend' : '__cyrusSend';
    const destination = message.isGroup && channel === 'whatsapp' ? (message.to || message.from) : message.from;
    const script = 'window.' + send + ' && window.' + send + '(' + JSON.stringify(destination) + ', ' + JSON.stringify(text) + ');';
    return window.Capacitor.Plugins.EmbeddedWebView.evaluate({ id: bridge, script: script });
  }
  async function loadAutoResponderSettings() {
    const settings = await Cyrus.db.getAutoResponderSettings();
    $('auto-reply-wa').checked = !!settings.whatsapp;
    $('auto-reply-tg').checked = !!settings.telegram;
    $('auto-reply-always').checked = !!settings.alwaysOn;
    $('auto-reply-paused').checked = !!settings.paused;
    $('auto-reply-groups').checked = !!settings.groupReplies;
    $('auto-reply-wa').disabled = !!settings.alwaysOn;
    $('auto-reply-tg').disabled = !!settings.alwaysOn;
    $('auto-reply-status').textContent = settings.paused ? 'Répondeur en pause.' : (settings.alwaysOn || settings.whatsapp || settings.telegram) ? 'Actif · ' + [settings.whatsapp || settings.alwaysOn ? 'WhatsApp' : '', settings.telegram || settings.alwaysOn ? 'Telegram' : ''].filter(Boolean).join(' + ') + (settings.groupReplies ? ' · groupes autorisés' : ' · conversations privées') : 'Répondeur désactivé.';
  }
  async function saveAutoResponderSettingsFromUi() {
    const alwaysOn = $('auto-reply-always').checked;
    await Cyrus.db.saveAutoResponderSettings({
      whatsapp: alwaysOn || $('auto-reply-wa').checked,
      telegram: alwaysOn || $('auto-reply-tg').checked,
      alwaysOn,
      paused: $('auto-reply-paused').checked,
      groupReplies: $('auto-reply-groups').checked,
    });
    await loadAutoResponderSettings();
  }
  ['auto-reply-wa', 'auto-reply-tg', 'auto-reply-always', 'auto-reply-paused', 'auto-reply-groups'].forEach(id => $(id).addEventListener('change', () => {
    saveAutoResponderSettingsFromUi().catch(error => { $('auto-reply-status').textContent = 'Enregistrement impossible : ' + error.message; });
  }));
  loadAutoResponderSettings().catch(error => { $('auto-reply-status').textContent = 'Réglages indisponibles : ' + error.message; });
  async function handleIncoming(channel, message) {
    if (!message || !message.id || !message.from) return;
    const isGroup = !!message.isGroup || (channel === 'whatsapp' && /@g\.us$/.test(String(message.to || message.from)));
    const chatId = message.fromMe ? message.to : (isGroup && channel === 'whatsapp' ? message.to : message.from);
    if (!chatId || (channel === 'whatsapp' && /@broadcast$/.test(chatId))) return;
    const messageKey = channel + ':' + message.id;
    if (repliedIds.has(messageKey)) return;
    repliedIds.add(messageKey);
    if (repliedIds.size > 500) repliedIds.delete(repliedIds.values().next().value);
    const identifier = channel === 'whatsapp' ? String(chatId).split('@')[0].replace(/\D/g, '') : String(chatId);
    if (message.fromMe) { saveConversation(channel, chatId, message); return; }
    const query = normalizeQuestion(message.body);
    if (!query) return;
    const blocked = await Cyrus.db.getBlocklist(channel);
    if (blocked.some(x => channel === 'whatsapp' ? String(x.identifier).replace(/\D/g, '') === identifier : String(x.identifier) === identifier)) return;
    saveConversation(channel, chatId, message);
    if (/^(stop|stop all|stopall|unsubscribe|quit|cancel|desabonner|arrete|arretez|ne me contacte plus)(?:\b|$)/.test(query)) {
      if (identifier) await Cyrus.db.addToBlocklist(channel, identifier);
      return;
    }
    const settings = await Cyrus.db.getAutoResponderSettings();
    const channelEnabled = settings.alwaysOn || (channel === 'whatsapp' ? settings.whatsapp : settings.telegram);
    if (settings.paused || !channelEnabled || (isGroup && !settings.groupReplies)) return;
    const services = await Cyrus.db.getBusinessServices();
    const faqEnabled = channel === 'whatsapp' ? 'waAutoReply' : 'tgAutoReply';
    const aiEnabled = channel === 'whatsapp' ? 'waAiAutoReply' : 'tgAiAutoReply';
    for (const service of services.filter(s => s[faqEnabled])) {
      for (const line of String(service.faq || '').split(/\r?\n/)) {
        const pair = line.split(/\s*=>\s*/);
        if (pair.length < 2 || !normalizeQuestion(pair[0]) || normalizeQuestion(pair[0]) !== query) continue;
        const answer = pair.slice(1).join(' => ').trim();
        if (!answer) continue;
        await sendAutoReply(message, answer, channel);
        saveConversation(channel, chatId, { id: 'auto-faq-' + message.id, fromMe: true, body: answer });
        return;
      }
    }
    const aiService = services.find(s => s[aiEnabled]);
    if (!aiService || !identifier || !allowAiReply(channel, identifier)) return;
    const feedback = $('svc-feedback');
    try {
      if (!Cyrus.ai || typeof Cyrus.ai.generateText !== 'function') throw new Error('Service IA indisponible.');
      const result = await Cyrus.ai.generateText(buildReplyPrompt(aiService, message, channel, chatId));
      const answer = String(result.text || '').trim().replace(/^["'«»\s]+|["'«»\s]+$/g, '').slice(0, 1200);
      if (!answer) return;
      await sendAutoReply(message, answer, channel);
      saveConversation(channel, chatId, { id: 'auto-ai-' + message.id, fromMe: true, body: answer });
      if (feedback) feedback.textContent = 'Réponse IA transmise au pont ' + channel + ' pour ' + identifier + (result.provider ? ' · ' + result.provider : '') + '.';
    } catch (error) {
      if (feedback) feedback.textContent = 'Réponse IA non envoyée : ' + String(error.message || error).slice(0, 180);
    }
  }
  window.CyrusBusinessServices = { promptContext, handleIncomingWA: message => handleIncoming('whatsapp', message), handleIncomingTG: message => handleIncoming('telegram', message), loadAutoResponderSettings };
})();
