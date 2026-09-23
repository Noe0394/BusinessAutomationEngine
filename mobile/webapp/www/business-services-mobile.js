// Fiches métier locales du mobile (sans coffre API ni synchronisation serveur).
(function () {
  const $ = id => document.getElementById(id);
  const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  let editing = null;
  async function render() {
    const services = await Cyrus.db.getBusinessServices();
    $('svc-list').innerHTML = services.map(s => {
      const c = s.commercial || {};
      const products = (s.products || []).map(p => typeof p === 'string' ? p : p.name + (p.price != null ? ' | ' + p.price : '')).join('\n');
      const facts = [c.description, c.target && 'Cible : ' + c.target, c.advantages && 'Avantages : ' + c.advantages,
        c.objections && 'Objections : ' + c.objections, c.paymentTerms && 'Paiement : ' + c.paymentTerms,
        c.accessTerms && 'Accès / livraison : ' + c.accessTerms, products && 'Produits :\n' + products,
        (s.objectives || []).length && 'Objectifs :\n' + s.objectives.join('\n')].filter(Boolean).join('\n\n');
      const price = c.price != null ? c.price + ' ' + (c.currency || 'FCFA') : (s.price || '');
      return '<div class="card"><b>' + esc(s.name) + '</b><p>' + esc(s.type || 'service') + (s.project ? ' · ' + esc(s.project) : '') + '<br>' + esc(s.offer || c.description || '') + (price ? ' · ' + esc(price) : '') + '</p><p>' + (s.waAutoReply ? 'Réponse FAQ WhatsApp activée' : 'Réponse automatique désactivée') + '</p><details><summary>Fiche commerciale, consignes et FAQ</summary><pre style="white-space:pre-wrap">' + esc([c.memo || s.memo, facts, s.rules, s.faq].filter(Boolean).join('\n\n')) + '</pre></details><button data-edit="' + esc(s.id) + '">Modifier</button> <button data-delete="' + esc(s.id) + '">Supprimer</button></div>';
    }).join('') || '<p>Aucun service configuré.</p>';
    $('svc-list').querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => fill(services.find(s => s.id === b.dataset.edit))));
    $('svc-list').querySelectorAll('[data-delete]').forEach(b => b.addEventListener('click', async () => { await Cyrus.db.deleteBusinessService(b.dataset.delete); render(); }));
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
  }
  function lines(value) { return String(value || '').split(/\r?\n/).map(x => x.trim()).filter(Boolean); }
  function products(value) { return lines(value).map(line => { const i = line.lastIndexOf('|'); return i < 0 ? { name: line, price: null } : { name: line.slice(0, i).trim(), price: line.slice(i + 1).trim() || null }; }); }
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
  $('svc-save').addEventListener('click', async () => {
    const name = $('svc-name').value.trim();
    if (!name) { $('svc-feedback').textContent = 'Le nom du service est requis.'; return; }
    const price = $('svc-price').value.trim(); const promo = $('svc-promo').value.trim(); const currency = $('svc-currency').value.trim() || 'FCFA';
    await Cyrus.db.saveBusinessService({ id: editing, name, type: $('svc-type').value, project: $('svc-project').value.trim(),
      offer: $('svc-offer').value.trim(), price, commercial: { memo: $('svc-memo').value.trim(), description: $('svc-description').value.trim(),
        price: price ? Number(price) : null, currency, promoPrice: promo ? Number(promo) : null, target: $('svc-target').value.trim(),
        advantages: $('svc-advantages').value.trim(), objections: $('svc-objections').value.trim(), paymentTerms: $('svc-payment-terms').value.trim(), accessTerms: $('svc-access-terms').value.trim() },
      products: products($('svc-products').value), objectives: lines($('svc-objectives').value), faq: $('svc-faq').value.trim(),
      rules: lines($('svc-rules').value), waAutoReply: $('svc-wa-autoreply').checked });
    editing = null; fill(null); $('svc-feedback').textContent = 'Fiche enregistrée sur cet appareil.'; await render();
  });
  render().catch(e => { $('svc-list').textContent = 'Stockage local indisponible : ' + e.message; });
  const repliedIds = new Set();
  function normalizeQuestion(text) { return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  async function handleIncomingWA(message) {
    if (!message || message.fromMe || !message.id || !message.from || /@g\.us$|@broadcast$/.test(message.from)) return;
    if (repliedIds.has(message.id)) return;
    repliedIds.add(message.id);
    if (repliedIds.size > 500) repliedIds.delete(repliedIds.values().next().value);
    const query = normalizeQuestion(message.body);
    const identifier = String(message.from).split('@')[0].replace(/\D/g, '');
    if (/^(stop|stop all|stopall|unsubscribe|quit|cancel|desabonner|arrete|arretez|ne me contacte plus)(?:\b|$)/.test(query)) {
      if (identifier) await Cyrus.db.addToBlocklist('whatsapp', identifier);
      return;
    }
    if (!query) return;
    const blocked = await Cyrus.db.getBlocklist('whatsapp');
    if (blocked.some(x => String(x.identifier).replace(/\D/g, '') === identifier)) return;
    const services = await Cyrus.db.getBusinessServices();
    for (const service of services.filter(s => s.waAutoReply)) {
      for (const line of String(service.faq || '').split(/\r?\n/)) {
        const pair = line.split(/\s*=>\s*/);
        if (pair.length < 2 || !normalizeQuestion(pair[0]) || normalizeQuestion(pair[0]) !== query) continue;
        const answer = pair.slice(1).join(' => ').trim();
        if (!answer) continue;
        const script = 'window.__cyrusSend && window.__cyrusSend(' + JSON.stringify(message.from) + ', ' + JSON.stringify(answer) + ');';
        await window.Capacitor.Plugins.EmbeddedWebView.evaluate({ id: 'whatsapp', script: script });
        return;
      }
    }
  }
  window.CyrusBusinessServices = { promptContext, handleIncomingWA };
})();
