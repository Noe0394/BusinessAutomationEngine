// Écrans téléphone complémentaires, bâtis sur les données locales du mobile.
(function () {
  const guides = [
    ['WhatsApp', 'Appairez WhatsApp Web depuis l’écran WhatsApp et gardez l’application active pendant les envois. Les sessions sont conservées par la WebView.'],
    ['Telegram', 'Connectez votre compte Telegram depuis l’écran Telegram. La session et ses limites dépendent du pont Telegram de cet appareil.'],
    ['Campagnes', 'Importez les contacts, préparez le message puis démarrez la campagne. Les listes noires et l’historique sont enregistrés localement.'],
    ['Relance manuelle', 'Importez les destinataires, vérifiez le canal et le message, puis contrôlez le résultat dans l’historique.'],
    ['Studio Média', 'Créez et exportez vos visuels depuis le studio. Les fonctions qui demandent une clé ou un service en ligne nécessitent une connexion.'],
  ];
  function renderHelp(q) {
    const norm = String(q || '').toLowerCase();
    const rows = guides.filter(x => !norm || (x[0] + ' ' + x[1]).toLowerCase().includes(norm));
    document.getElementById('mobile-help-content').innerHTML = rows.map(x => '<details><summary>' + x[0] + '</summary><p>' + x[1] + '</p></details>').join('') || '<p>Aucun guide trouvé.</p>';
  }
  let reportSnapshot = null;
  async function renderReports() {
    const host = document.getElementById('mobile-report-content'); host.replaceChildren();
    try {
      const [wa, tg, campaigns, allSent, blockedWa, blockedTg, services, ledger] = await Promise.all([
        Cyrus.db.getContacts('whatsapp'), Cyrus.db.getContacts('telegram'), Cyrus.db.getCampaigns(), Cyrus.db.getSentLog(null),
        Cyrus.db.getBlocklist('whatsapp'), Cyrus.db.getBlocklist('telegram'), Cyrus.db.getBusinessServices(), Cyrus.db.getLedgerEntries(),
      ]);
      const fromText = document.getElementById('mobile-report-from').value;
      const toText = document.getElementById('mobile-report-to').value;
      const from = fromText ? new Date(fromText + 'T00:00:00').getTime() : 0;
      const to = toText ? new Date(toText + 'T00:00:00').getTime() + 86400000 : Infinity;
      const channel = document.getElementById('mobile-report-channel').value;
      const status = document.getElementById('mobile-report-status').value;
      const search = document.getElementById('mobile-report-search').value.trim().toLocaleLowerCase();
      const inPeriod = value => { const numeric = Number(value); const ts = Number.isFinite(numeric) && String(value).trim() !== '' ? numeric : (Date.parse(value) || 0); return ts >= from && ts < to; };
      const statusOf = campaign => {
        const value = String(campaign.status || 'unknown').toLowerCase();
        return ['completed', 'launched'].includes(value) ? 'done' : value;
      };
      const dateCampaigns = campaigns.filter(c => inPeriod(c.updatedAt || c.createdAt || 0));
      const datedCampaigns = dateCampaigns.filter(c => (!channel || c.channel === channel)
        && (!status || statusOf(c) === status)
        && (!search || String(c.message || '').toLocaleLowerCase().includes(search) || String(c.id || '').toLocaleLowerCase().includes(search)));
      const visibleCampaignIds = new Set(datedCampaigns.map(c => c.id));
      const sent = allSent.filter(e => inPeriod(e.sentAt) && (!channel || e.channel === channel)
        && (!status || (status === 'done' && e.source !== 'campaign') || (e.campaignId && visibleCampaignIds.has(e.campaignId)))
        && (!search || String(e.identifier || '').toLocaleLowerCase().includes(search)
          || String(e.source || '').toLocaleLowerCase().includes(search)
          || String(e.campaignId || '').toLocaleLowerCase().includes(search)));
      const visibleWa = wa.filter(c => (!channel || c.channel === channel) && (!search || String(c.identifier || '').toLocaleLowerCase().includes(search) || String(c.name || '').toLocaleLowerCase().includes(search)));
      const visibleTg = tg.filter(c => (!channel || c.channel === channel) && (!search || String(c.identifier || '').toLocaleLowerCase().includes(search) || String(c.name || '').toLocaleLowerCase().includes(search)));
      const visibleBlockedWa = blockedWa.filter(c => !search || String(c.identifier || '').toLocaleLowerCase().includes(search));
      const visibleBlockedTg = blockedTg.filter(c => !search || String(c.identifier || '').toLocaleLowerCase().includes(search));
      const blockedCount = (channel === 'telegram' ? 0 : visibleBlockedWa.length) + (channel === 'whatsapp' ? 0 : visibleBlockedTg.length);
      const datedLedger = ledger.filter(entry => inPeriod(entry.recordedAt || entry.issuedAt));
      const sales = datedLedger.filter(entry => entry.kind === 'sale');
      const invoices = datedLedger.filter(entry => entry.kind === 'invoice');
      const revenue = sales.reduce((out, entry) => { const currency = String(entry.currency || 'FCFA'); out[currency] = (out[currency] || 0) + (Number(entry.amount) || 0); return out; }, {});
      const waSent = sent.filter(e => e.channel === 'whatsapp').length;
      const tgSent = sent.filter(e => e.channel === 'telegram').length;
      const failed = datedCampaigns.reduce((n, c) => n + (c.failed || []).length, 0);
      const campaignSent = datedCampaigns.reduce((n, c) => n + (c.sent || []).length, 0);
      const totalReported = campaignSent + failed;
      const successRate = totalReported ? Math.round(campaignSent * 100 / totalReported) + '%' : '—';
      const improvementItems = await Cyrus.db.getReportImprovements();
      const totals = {
        done: datedCampaigns.filter(c => ['done', 'completed'].includes(statusOf(c))).length,
        notDone: datedCampaigns.filter(c => ['running', 'scheduled', 'paused', 'cancelled'].includes(statusOf(c))).length,
        blocked: datedCampaigns.filter(c => statusOf(c) === 'failed').length,
        toImprove: datedCampaigns.filter(c => (c.failed || []).length > 0).length,
        improved: improvementItems.filter(i => i.status === 'MEASURED').length,
      };
      reportSnapshot = { wa: visibleWa, tg: visibleTg, contacts: visibleWa.concat(visibleTg), campaigns: datedCampaigns, sent, blockedWa: visibleBlockedWa, blockedTg: visibleBlockedTg, services,
        ledger: datedLedger, sales, invoices, revenue, failed, campaignSent, successRate, totalReported, waSent, tgSent, totals, from, to, channel, status, search };
      const metrics = [
        ['Contacts WhatsApp', visibleWa.length], ['Contacts Telegram', visibleTg.length], ['Campagnes dans la période', datedCampaigns.length],
        ['Envois journalisés', sent.length], ['WhatsApp envoyés', waSent], ['Telegram envoyés', tgSent],
        ['Échecs de campagne', failed], ['Taux de réussite des campagnes mises à jour', successRate],
        ['Désinscriptions / blocages', blockedCount], ['Services Métiers', services.length],
        ['Ventes enregistrées localement', sales.length], ['Factures locales', invoices.length],
        ...Object.keys(revenue).sort().map(currency => ['Ventes · ' + currency, revenue[currency].toLocaleString()]),
        ['Fait / terminé', totals.done], ['Pas encore fait', totals.notDone], ['Bloqué (campagne en échec)', totals.blocked],
        ['À améliorer (avec échecs)', totals.toImprove], ['Améliorations mesurées', totals.improved],
      ];
      metrics.forEach(([label, value]) => { const card = document.createElement('div'); card.className = 'card'; const b = document.createElement('b'); b.textContent = String(value); const p = document.createElement('p'); p.textContent = label; card.append(b, p); host.appendChild(card); });
      const title = document.createElement('h3'); title.textContent = 'Derniers envois de la période'; host.appendChild(title);
      if (!sent.length) { const empty = document.createElement('p'); empty.textContent = 'Aucun envoi journalisé pour cette période.'; host.appendChild(empty); }
      sent.slice(0, 100).forEach(e => { const row = document.createElement('p'); row.textContent = new Date(e.sentAt).toLocaleString() + ' · ' + e.channel + ' · ' + e.identifier + (e.source ? ' · ' + e.source : ''); host.appendChild(row); });
      const campaignTitle = document.createElement('h3'); campaignTitle.textContent = 'Campagnes'; host.appendChild(campaignTitle);
      datedCampaigns.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 50).forEach(c => {
        const row = document.createElement('p'); row.textContent = (c.channel || '') + ' · ' + (c.status || 'inconnu') + ' · ' + (c.sent || []).length + ' envoyés · ' + (c.failed || []).length + ' échecs · ' + (c.message || c.id); host.appendChild(row);
      });
      await renderImprovements();
    } catch (err) { host.textContent = 'Les données locales ne sont pas disponibles : ' + err.message; }
  }
  async function analyzeMobileReport() {
    const status = document.getElementById('mobile-report-analysis-feedback');
    const output = document.getElementById('mobile-report-analysis');
    if (!reportSnapshot) { status.textContent = 'Actualisez les rapports avant l’analyse.'; return; }
    status.textContent = 'Analyse Cloudflare en cours…'; output.textContent = '';
    const s = reportSnapshot;
    const summary = {
      period: { from: s.from || null, to: Number.isFinite(s.to) ? s.to : null }, channel: s.channel || 'all',
      contactsWhatsApp: s.wa.length, contactsTelegram: s.tg.length, campaigns: s.campaigns.length,
      journalizedSends: s.sent.length, whatsappSends: s.waSent, telegramSends: s.tgSent,
      campaignSuccessfulRecipients: s.campaignSent, campaignFailedRecipients: s.failed,
      campaignSuccessRate: s.totalReported ? Math.round(s.campaignSent * 100 / s.totalReported) : null,
      blockedContacts: s.channel === 'whatsapp' ? s.blockedWa.length : (s.channel === 'telegram' ? s.blockedTg.length : s.blockedWa.length + s.blockedTg.length), businessServices: s.services.length,
      accountingSales: s.sales.length, accountingInvoices: s.invoices.length, revenueByCurrency: s.revenue,
      campaignStatuses: s.campaigns.reduce((out, c) => { const key = String(c.status || 'unknown').toLowerCase(); out[key] = (out[key] || 0) + 1; return out; }, {}),
    };
    const prompt = 'Tu analyses un rapport local de CYRUS. Réponds en français avec les faits mesurés, les limites de l’échantillon, puis des recommandations concrètes. Utilise uniquement les nombres fournis; ne prétends pas connaître des messages, des contacts ou des causes qui ne sont pas dans ces agrégats. Distingue clairement les constats des hypothèses et ne déclenche aucune action. Si les données sont insuffisantes, dis-le.\n\nIndicateurs agrégés (aucun nom, numéro ou texte de message) :\n' + JSON.stringify(summary);
    try {
      if (!Cyrus.ai || typeof Cyrus.ai.generateText !== 'function') throw new Error('Cascade IA indisponible.');
      const result = await Cyrus.ai.generateText(prompt);
      output.textContent = result.text;
      status.textContent = 'Analyse reçue via ' + (result.provider || 'Cloudflare') + '.';
    } catch (error) { status.textContent = 'Analyse indisponible : ' + String(error.message || error); }
  }
  async function renderImprovements() {
    const host = document.getElementById('mobile-report-improvements');
    const feedback = document.getElementById('mobile-report-improvements-feedback');
    if (!host || !reportSnapshot) return;
    const items = await Cyrus.db.getReportImprovements(); host.replaceChildren();
    if (!items.length) { feedback.textContent = 'Aucune recommandation enregistrée sur cet appareil.'; return; }
    feedback.textContent = items.length + ' recommandation(s) locales.';
    items.slice(0, 50).forEach(item => {
      const card = document.createElement('div'); card.className = 'card';
      const title = document.createElement('b'); title.textContent = item.recommendation; card.appendChild(title);
      const observation = document.createElement('p'); observation.textContent = item.observation; card.appendChild(observation);
      const state = document.createElement('p'); state.textContent = item.status === 'PROPOSED' ? 'À valider' : item.status === 'APPLIED' ? 'Appliquée — mesure disponible après de nouvelles campagnes' : 'Mesurée'; card.appendChild(state);
      if (item.result) { const result = document.createElement('p'); result.textContent = item.result.message + ' Les chiffres décrivent une évolution et ne prouvent pas à eux seuls un lien de causalité.'; card.appendChild(result); }
      if (item.status === 'PROPOSED') {
        const apply = document.createElement('button'); apply.textContent = 'J’ai appliqué cette recommandation';
        apply.addEventListener('click', () => markImprovementApplied(item.id)); card.appendChild(apply);
      } else if (item.status === 'APPLIED') {
        const measure = document.createElement('button'); measure.textContent = 'Mesurer après les nouvelles campagnes';
        measure.addEventListener('click', () => measureImprovement(item.id)); card.appendChild(measure);
      }
      host.appendChild(card);
    });
  }
  async function scanImprovements() {
    const feedback = document.getElementById('mobile-report-improvements-feedback');
    if (!reportSnapshot) { feedback.textContent = 'Actualisez les rapports avant le diagnostic.'; return; }
    const s = reportSnapshot;
    if (!s.failed || !s.totalReported) { feedback.textContent = 'Aucun échec de campagne mesuré dans ce périmètre; aucune recommandation automatique n’est créée.'; await renderImprovements(); return; }
    const existing = await Cyrus.db.getReportImprovements();
    const fingerprint = [s.channel || 'all', s.campaigns.map(c => c.id).sort().join(','), s.failed, s.totalReported].join(':');
    const duplicate = existing.find(item => item.key === 'campaign-failures' && item.fingerprint === fingerprint);
    if (duplicate) { feedback.textContent = 'Ce même périmètre a déjà une recommandation enregistrée.'; await renderImprovements(); return; }
    const rate = Math.round(s.failed * 100 / s.totalReported);
    await Cyrus.db.saveReportImprovement({ id: 'mobile_imp_' + Date.now().toString(36), key: 'campaign-failures', fingerprint, channel: s.channel || null,
      status: 'PROPOSED', kind: 'NEEDS_VALIDATION', createdAt: Date.now(),
      observation: s.failed + ' échec(s) parmi ' + s.totalReported + ' destinataire(s) de campagne sur le périmètre choisi (' + rate + '%).',
      recommendation: 'Examiner les causes d’échec par destinataire et corriger la liste ou le canal avant la prochaine campagne.',
      baseline: { sent: s.campaignSent, failed: s.failed, attempts: s.totalReported, failureRate: rate },
    });
    feedback.textContent = 'Recommandation enregistrée. Aucune campagne ni aucun contact n’a été modifié.';
    await renderImprovements();
  }
  async function markImprovementApplied(id) {
    const items = await Cyrus.db.getReportImprovements(); const item = items.find(row => row.id === id);
    if (!item || item.status !== 'PROPOSED' || !reportSnapshot) return;
    item.status = 'APPLIED'; item.appliedAt = Date.now();
    item.baseline = { sent: reportSnapshot.campaignSent, failed: reportSnapshot.failed, attempts: reportSnapshot.totalReported,
      failureRate: reportSnapshot.totalReported ? Math.round(reportSnapshot.failed * 100 / reportSnapshot.totalReported) : null };
    item.channel = reportSnapshot.channel || item.channel || null;
    await Cyrus.db.saveReportImprovement(item);
    document.getElementById('mobile-report-improvements-feedback').textContent = 'Application confirmée manuellement. La mesure attend de nouvelles campagnes.';
    await renderImprovements();
  }
  async function measureImprovement(id) {
    const items = await Cyrus.db.getReportImprovements(); const item = items.find(row => row.id === id);
    if (!item || item.status !== 'APPLIED') return;
    const campaigns = await Cyrus.db.getCampaigns();
    const afterCampaigns = campaigns.filter(c => Number(c.createdAt || 0) >= item.appliedAt && (!item.channel || c.channel === item.channel));
    const sent = afterCampaigns.reduce((n, c) => n + (c.sent || []).length, 0);
    const failed = afterCampaigns.reduce((n, c) => n + (c.failed || []).length, 0);
    const attempts = sent + failed;
    if (!attempts) {
      document.getElementById('mobile-report-improvements-feedback').textContent = 'Aucune nouvelle campagne créée après la validation n’est encore disponible pour mesurer cette recommandation.';
      return;
    }
    const afterRate = Math.round(failed * 100 / attempts);
    const beforeRate = item.baseline && Number.isFinite(item.baseline.failureRate) ? item.baseline.failureRate : null;
    const comparison = beforeRate == null ? 'taux après application : ' + afterRate + '%' : 'taux d’échec avant : ' + beforeRate + '%; après : ' + afterRate + '% (' + (beforeRate - afterRate >= 0 ? 'baisse de ' : 'hausse de ') + Math.abs(beforeRate - afterRate) + ' points)';
    item.status = 'MEASURED'; item.measuredAt = Date.now();
    item.result = { message: comparison + ' sur ' + attempts + ' destinataire(s) dans ' + afterCampaigns.length + ' nouvelle(s) campagne(s).', sent, failed, attempts, failureRate: afterRate };
    await Cyrus.db.saveReportImprovement(item);
    document.getElementById('mobile-report-improvements-feedback').textContent = 'Mesure enregistrée à partir des campagnes locales postérieures.';
    await renderImprovements();
  }
  function exportReports() {
    const feedback = document.getElementById('mobile-report-feedback');
    if (!reportSnapshot) { feedback.textContent = 'Actualisez les rapports avant l’export.'; return; }
    const s = reportSnapshot;
    const overview = [
      { Indicateur: 'Contacts WhatsApp', Valeur: s.wa.length }, { Indicateur: 'Contacts Telegram', Valeur: s.tg.length },
      { Indicateur: 'Campagnes', Valeur: s.campaigns.length }, { Indicateur: 'Envois journalisés', Valeur: s.sent.length },
      { Indicateur: 'Envoyés par campagnes', Valeur: s.campaignSent }, { Indicateur: 'Échecs campagne', Valeur: s.failed },
      { Indicateur: 'Taux de réussite campagne', Valeur: s.successRate }, { Indicateur: 'Blocages', Valeur: s.blockedWa.length + s.blockedTg.length },
      { Indicateur: 'Services Métiers', Valeur: s.services.length },
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(overview), 'Synthèse');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s.sent.map(e => ({ Date: new Date(e.sentAt).toLocaleString(), Canal: e.channel, Identifiant: e.identifier, Source: e.source || '', Campagne: e.campaignId || '' }))), 'Envois');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s.campaigns.map(c => ({ Canal: c.channel, État: c.status || '', Message: c.message || '', Total: c.total || 0, Envoyés: (c.sent || []).length, Échecs: (c.failed || []).length, MiseAJour: c.updatedAt ? new Date(c.updatedAt).toLocaleString() : '' }))), 'Campagnes');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet((s.contacts || s.wa.concat(s.tg)).map(c => ({ Canal: c.channel, Nom: c.name || '', Identifiant: c.identifier, Provenance: c.source || '' }))), 'Contacts');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s.sales.map(e => ({ Date: e.recordedAt, Montant: e.amount, Devise: e.currency, Produit: e.product || '', Client: e.customer || '', Référence: e.reference || '' }))), 'Ventes');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s.invoices.map(e => ({ Numéro: e.invoiceNumber, Date: e.issuedAt, Montant: e.amount, Devise: e.currency, Produit: e.product || '', Client: e.customer || '' }))), 'Factures');
    XLSX.writeFile(wb, 'rapports-activite-locale.xlsx');
  }  let prospectRows = [];
  async function renderProspects() {
    const host = document.getElementById('mobile-prospects-content');
    const feedback = document.getElementById('mobile-prospects-feedback');
    feedback.textContent = 'Chargement…';
    try {
      const [wa, tg, campaigns, sent] = await Promise.all([
        Cyrus.db.getContacts('whatsapp'), Cyrus.db.getContacts('telegram'), Cyrus.db.getCampaigns(), Cyrus.db.getSentLog(null, 500),
      ]);
      const campaignById = new Map(campaigns.map(c => [c.id, c]));
      const sentByKey = new Map();
      sent.forEach(e => { const k = e.channel + ':' + e.identifier; if (!sentByKey.has(k)) sentByKey.set(k, e); });
      prospectRows = wa.concat(tg).map(c => {
        const activity = sentByKey.get(c.channel + ':' + c.identifier);
        const campaign = activity && campaignById.get(activity.campaignId);
        return { channel: c.channel, identifier: c.identifier, name: c.name || '', campaign: campaign ? campaign.message || campaign.id : '',
          lastSent: activity ? new Date(activity.sentAt).toLocaleString() : '', source: c.source === 'telegram-public-discovery' ? 'Découverte publique Telegram (prospect à valider)' : 'Import local (origine publicitaire inconnue)' };
      });
      host.replaceChildren();
      const summary = document.createElement('p'); summary.textContent = prospectRows.length + ' contacts locaux · ' + campaigns.length + ' campagnes enregistrées'; host.appendChild(summary);
      prospectRows.forEach(row => {
        const card = document.createElement('div'); card.className = 'card';
        const title = document.createElement('b'); title.textContent = row.name || row.identifier; card.appendChild(title);
        const detail = document.createElement('p'); detail.textContent = row.channel + ' · ' + row.identifier + (row.lastSent ? ' · dernier envoi ' + row.lastSent : ' · aucun envoi journalisé'); card.appendChild(detail);
        const origin = document.createElement('small'); origin.textContent = row.source; card.appendChild(origin); host.appendChild(card);
      });
      feedback.textContent = 'Liste actualisée.';
    } catch (error) { feedback.textContent = 'Erreur : ' + error.message; }
  }
  function exportProspects() {
    if (!prospectRows.length) { document.getElementById('mobile-prospects-feedback').textContent = 'Aucun contact à exporter.'; return; }
    const rows = prospectRows.map(r => ({ Nom: r.name, Identifiant: r.identifier, Canal: r.channel, Campagne: r.campaign, 'Dernier envoi': r.lastSent, Provenance: r.source }));
    const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Contacts locaux');
    XLSX.writeFile(wb, 'contacts-locaux.xlsx');
  }
  const communityNames = new Map();
  function renderGroups(channel, groups) {
    const host = document.getElementById('mobile-groups-content'); host.replaceChildren();
    const heading = document.createElement('h3'); heading.textContent = channel + ' · ' + groups.length + ' groupes'; host.appendChild(heading);
    if (!groups.length) { const empty = document.createElement('p'); empty.textContent = 'Aucun groupe retourné.'; host.appendChild(empty); return; }
    groups.forEach(g => {
      const id = String(g.id || ''); const name = String(g.name || id); communityNames.set(channel + ':' + id, name);
      const card = document.createElement('div'); card.className = 'card';
      const title = document.createElement('b'); title.textContent = name; card.appendChild(title);
      const detail = document.createElement('p'); detail.textContent = (g.participantsCount || '') + (id ? ' · ' + id : ''); card.appendChild(detail);
      const button = document.createElement('button'); button.textContent = 'Extraire les membres';
      button.addEventListener('click', () => {
        const fn = channel === 'WHATSAPP' ? '__cyrusGetGroupMembers' : '__cyrusTgGetGroupMembers';
        const bridge = channel === 'WHATSAPP' ? 'whatsapp' : 'telegram';
        document.getElementById('mobile-groups-feedback').textContent = 'Extraction en cours pour ' + name + '…';
        window.Capacitor.Plugins.EmbeddedWebView.evaluate({ id: bridge, script: 'window.' + fn + '(' + JSON.stringify(id) + ')' });
      });
      card.appendChild(button); host.appendChild(card);
    });
  }
  async function renderStoredMembers(channel) {
    const host = document.getElementById('mobile-members-content'); host.replaceChildren();
    const rows = channel ? await Cyrus.db.getGroupMembers(channel)
      : (await Promise.all([Cyrus.db.getGroupMembers('whatsapp'), Cyrus.db.getGroupMembers('telegram')])).flat();
    const exportButton = document.getElementById('mobile-members-export'); exportButton.disabled = rows.length === 0;
    if (!rows.length) { host.textContent = 'Aucune extraction conservée pour ' + channel + '.'; return; }
    const title = document.createElement('h3'); title.textContent = 'Membres extraits' + (channel ? ' · ' + channel : '') + ' · ' + rows.length; host.appendChild(title);
    const table = document.createElement('table'); const head = table.createTHead().insertRow();
    ['Groupe', 'Nom', 'Identifiant', 'Rôle', 'Extrait le'].forEach(label => { const th = document.createElement('th'); th.textContent = label; head.appendChild(th); });
    const body = table.createTBody(); rows.sort((a, b) => (b.extractedAt || 0) - (a.extractedAt || 0)).slice(0, 500).forEach(member => {
      const row = body.insertRow(); [member.groupName, member.name || '—', member.identifier, member.isAdmin ? 'Administrateur' : 'Membre', new Date(member.extractedAt).toLocaleString()].forEach(value => { const cell = row.insertCell(); cell.textContent = String(value); });
    });
    host.appendChild(table);
    if (rows.length > 500) { const note = document.createElement('small'); note.textContent = 'Affichage limité aux 500 extractions les plus récentes.'; host.appendChild(note); }
  }
  async function renderMembers(channel, data) {
    const channelKey = channel.toLowerCase(); const members = data.members || [];
    const groupId = String(data.groupId || ''); const groupName = communityNames.get(channel + ':' + groupId) || groupId;
    try {
      await Cyrus.db.saveGroupMembers(channelKey, groupId, groupName, members);
      const contacts = members.map(m => ({ identifier: String(m.id || m.identifier || ''), name: String(m.name || '') })).filter(m => m.identifier);
      if (contacts.length) await Cyrus.db.putAllContacts(channelKey, contacts);
      document.getElementById('mobile-groups-feedback').textContent = members.length + ' membre(s) extraits de « ' + groupName + ' » et enregistrés sur cet appareil.';
      await renderStoredMembers(channelKey);
    } catch (err) { document.getElementById('mobile-groups-feedback').textContent = 'Échec de l’enregistrement des membres : ' + err.message; }
  }
  async function exportGroupMembers() {
    const rows = (await Promise.all([Cyrus.db.getGroupMembers('whatsapp'), Cyrus.db.getGroupMembers('telegram')])).flat();
    if (!rows.length) return;
    await Cyrus.fileExport.exportRows(rows.map(m => ({ Canal: m.channel, Groupe: m.groupName, Nom: m.name, Identifiant: m.identifier, Rôle: m.isAdmin ? 'Administrateur' : 'Membre', 'Date d’extraction': new Date(m.extractedAt).toLocaleString() })), 'membres-des-communautes', 'xlsx');
  }
  const communityEngines = [
    q => 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q),
    q => 'https://www.bing.com/search?q=' + encodeURIComponent(q) + '&count=30',
    q => 'https://www.startpage.com/sp/search?query=' + encodeURIComponent(q),
  ];
  function communityRefs(html, channel) {
    const text = String(html || '').replace(/&amp;/g, '&').replace(/&#x2F;/gi, '/').replace(/\\\//g, '/');
    const refs = new Set(); let match;
    if (channel === 'WHATSAPP') {
      const re = /(?:https?:\/\/)?(?:www\.)?chat\.whatsapp\.com\/(?:invite\/)?([A-Za-z0-9]{16,24})/gi;
      while ((match = re.exec(text))) refs.add(match[1]);
    } else {
      const re = /(?:https?:\/\/)?(?:www\.)?t\.me\/([A-Za-z][A-Za-z0-9_]{4,31})/gi;
      const reserved = new Set(['joinchat', 'share', 'addstickers', 'addemoji', 'proxy', 'socks5', 'login', 'setlanguage', 'boost', 'iv', 'c']);
      while ((match = re.exec(text))) if (!reserved.has(match[1].toLowerCase())) refs.add(match[1]);
    }
    return [...refs];
  }
  async function nativeSearch(url) {
    const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CyrusNativeHttp;
    if (!plugin || typeof plugin.request !== 'function') throw new Error('La recherche publique requiert la version Android installée.');
    const result = await plugin.request({ url, method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CyrusMobileDirectory/1.0)' } });
    if (result.status < 200 || result.status >= 400) throw new Error('Moteur public HTTP ' + result.status);
    return result.body || '';
  }
  function canonicalCommunity(channel, ref) {
    return channel === 'WHATSAPP'
      ? { channel, ref, name: 'Invitation WhatsApp ' + ref.slice(0, 7) + '…', link: 'https://chat.whatsapp.com/' + ref, kind: 'group' }
      : { channel, ref: '@' + ref, name: '@' + ref, link: 'https://t.me/' + ref, kind: 'public-link' };
  }
  async function discoverCommunities() {
    const feedback = document.getElementById('mobile-community-discovery-feedback');
    const host = document.getElementById('mobile-community-results'); host.replaceChildren();
    const button = document.getElementById('mobile-community-discover');
    const channel = document.getElementById('mobile-community-channel').value;
    const keywords = [...new Set(document.getElementById('mobile-community-keywords').value.split(/[,;\n]/).map(x => x.trim()).filter(x => x.length >= 2))].slice(0, 5);
    const location = [document.getElementById('mobile-community-city').value.trim(), document.getElementById('mobile-community-country').value.trim()].filter(Boolean).join(' ');
    if (!keywords.length) { feedback.textContent = 'Saisis au moins un mot-clé de 2 caractères.'; return; }
    button.disabled = true; feedback.textContent = 'Recherche dans les annuaires publics…';
    try {
      if (channel === 'TELEGRAM') {
        const bridge = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.EmbeddedWebView;
        if (!bridge) throw new Error('Pont Telegram indisponible.');
        const script = 'window.__cyrusTgDiscoverCommunities ? window.__cyrusTgDiscoverCommunities(' + JSON.stringify(keywords.join(',')) + ', 15) : window.Cyrus.postMessage(JSON.stringify({type:"bridge-error",payload:{where:"discoverCommunities",message:"Pont Telegram pas encore prêt. Ouvre d’abord l’écran Telegram."}}));';
        await bridge.evaluate({ id: 'telegram', script });
        feedback.textContent = 'Recherche officielle Telegram lancée. Les résultats apparaîtront ici si la session est connectée.';
        return;
      }
      const found = new Map(); const errors = [];
      for (const keyword of keywords) {
        const siteQuery = channel === 'WHATSAPP' ? '"chat.whatsapp.com" ' + keyword + ' groupe whatsapp' : 'site:t.me ' + keyword + ' groupe telegram';
        const query = siteQuery + (location ? ' ' + location : '');
        const settled = await Promise.allSettled(communityEngines.map(engine => nativeSearch(engine(query))));
        let usable = 0;
        settled.forEach(result => {
          if (result.status !== 'fulfilled') { errors.push(String(result.reason && result.reason.message || result.reason)); return; }
          usable++;
          communityRefs(result.value, channel).forEach(ref => {
            const item = canonicalCommunity(channel, ref); const key = channel + ':' + ref.toLowerCase();
            const prior = found.get(key);
            if (prior) prior.keywords.push(keyword);
            else found.set(key, Object.assign(item, { members: null, description: '', verified: false, keywords: [keyword], discoveredAt: Date.now() }));
          });
        });
        if (!usable) await new Promise(resolve => setTimeout(resolve, 700));
      }
      const results = [...found.values()].slice(0, 60);
      if (results.length) {
        await Cyrus.db.saveCommunities(results);
        renderCommunityItems(results, host, false);
        await renderCommunityDirectory();
        feedback.textContent = results.length + ' lien(s) public(s) trouvé(s), tous non vérifiés. Ouvre un lien pour examiner ou rejoindre toi-même le groupe.';
      } else {
        feedback.textContent = errors.length === keywords.length * communityEngines.length
          ? 'Les moteurs publics ne répondent pas depuis cet appareil. Réessaie plus tard ou utilise un réseau différent.'
          : 'Aucun lien correspondant trouvé. Les annuaires publics peuvent omettre des groupes ou limiter les recherches.';
      }
    } catch (error) { feedback.textContent = 'Recherche impossible : ' + String(error.message || error); }
    finally { button.disabled = false; }
  }
  function openCommunity(item) {
    const plugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.CyrusOpenUrl;
    if (plugin && typeof plugin.open === 'function') plugin.open({ url: item.link }).catch(error => { document.getElementById('mobile-community-discovery-feedback').textContent = 'Ouverture impossible : ' + error.message; });
    else window.open(item.link, '_blank', 'noopener');
  }
  function renderCommunityItems(items, host, saved) {
    host.replaceChildren();
    items.forEach(item => {
      const card = document.createElement('div'); card.className = 'card';
      const title = document.createElement('b'); title.textContent = item.name || item.ref; card.appendChild(title);
      const info = document.createElement('p'); info.textContent = item.channel + ' · ' + (item.verified ? 'vérifié' : 'non vérifié') + (item.keywords && item.keywords.length ? ' · ' + item.keywords.join(', ') : ''); card.appendChild(info);
      const link = document.createElement('p'); link.textContent = item.link; link.style.wordBreak = 'break-all'; card.appendChild(link);
      const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Ouvrir le lien officiel'; open.addEventListener('click', () => openCommunity(item)); card.appendChild(open);
      if (saved) {
        const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Retirer de l’annuaire';
        remove.addEventListener('click', async () => { await Cyrus.db.deleteCommunity(item.channel, item.ref); await renderCommunityDirectory(); }); card.appendChild(remove);
      }
      host.appendChild(card);
    });
  }
  async function renderCommunityDirectory() {
    const host = document.getElementById('mobile-community-directory');
    const items = await Cyrus.db.getCommunities();
    if (!items.length) { host.textContent = 'Aucun lien public enregistré.'; return; }
    renderCommunityItems(items, host, true);
  }
  const communityOps = new Map();
  const activeCommunityJobs = new Set();
  const communityPauseRequests = new Map();
  const COMMUNITY_LIMIT = 100;
  function communityOpKey(payload) { return String(payload.jobId || '') + ':' + String(payload.action || '') + ':' + String(payload.identifier || ''); }
  function sendCommunityOperation(job, action, payload) {
    const bridge = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.EmbeddedWebView;
    if (!bridge) return Promise.reject(new Error('Pont de communication mobile indisponible.'));
    const id = job.channel === 'WHATSAPP' ? 'whatsapp' : 'telegram';
    const fn = job.channel === 'WHATSAPP'
      ? (action === 'create' ? '__cyrusWaCommunityCreate' : '__cyrusWaCommunityInvite')
      : (action === 'create' ? '__cyrusTgCommunityCreate' : '__cyrusTgCommunityInvite');
    const body = Object.assign({}, payload, { jobId: job.id, action });
    const key = communityOpKey(body);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { communityOps.delete(key); reject(new Error('La plateforme n’a pas répondu à temps. Vérifie le groupe avant de relancer cette opération.')); }, 90000);
      communityOps.set(key, result => { clearTimeout(timer); resolve(result); });
      const fallback = 'window.Cyrus.postMessage(JSON.stringify({type:"community-operation-result",payload:' + JSON.stringify(Object.assign({}, body, { action, ok: false, error: 'Ouvre d’abord une session connectée sur ce canal.' })) + '}));';
      const script = 'window.' + fn + ' ? window.' + fn + '(' + JSON.stringify(body) + ') : ' + fallback;
      bridge.evaluate({ id, script }).catch(error => { clearTimeout(timer); communityOps.delete(key); reject(error); });
    });
  }
  function handleCommunityOperation(payload) {
    const resolver = communityOps.get(communityOpKey(payload || {}));
    if (!resolver) return false;
    communityOps.delete(communityOpKey(payload)); resolver(payload); return true;
  }
  function communityStatusLabel(status) {
    return ({ CREATING: 'Création du groupe', RUNNING: 'Invitations en cours', PAUSING: 'Pause après l’invitation en cours', CANCELLING: 'Arrêt après l’invitation en cours', PAUSED_USER: 'En pause', PAUSED_RATE_LIMIT: 'En pause après une limite de débit', INTERRUPTED: 'Interrompue — reprise manuelle disponible', CREATION_UNKNOWN: 'Création à vérifier dans la plateforme avant toute nouvelle action', DONE: 'Terminée', DONE_WITH_ISSUES: 'Terminée avec des contacts non invités', FAILED: 'Échec', CANCELLED: 'Arrêtée' })[status] || status || 'En attente';
  }
  async function renderCommunityJobs() {
    const host = document.getElementById('mobile-community-jobs');
    if (!host) return;
    const jobs = await Cyrus.db.getCommunityJobs(); host.replaceChildren();
    if (!jobs.length) { host.textContent = 'Aucun job de groupe enregistré.'; return; }
    jobs.forEach(job => {
      const card = document.createElement('div'); card.className = 'card';
      const title = document.createElement('b'); title.textContent = job.title + ' · ' + job.channel; card.appendChild(title);
      const finished = (job.members || []).filter(m => m.status !== 'pending').length;
      const detail = document.createElement('p'); detail.textContent = communityStatusLabel(job.status) + ' · ' + finished + '/' + (job.members || []).length + ' traités' + (job.group && job.group.link ? ' · lien officiel disponible' : ''); card.appendChild(detail);
      if (job.group && job.group.id) { const group = document.createElement('small'); group.textContent = 'Groupe : ' + job.group.id; card.appendChild(group); }
      if (job.error) { const error = document.createElement('p'); error.textContent = job.error; card.appendChild(error); }
      const counts = document.createElement('p');
      const tally = (job.members || []).reduce((out, member) => { out[member.status] = (out[member.status] || 0) + 1; return out; }, {});
      counts.textContent = Object.entries(tally).map(([key, count]) => key + ': ' + count).join(' · ') || 'Aucun membre'; card.appendChild(counts);
      if (job.group && job.group.link) { const link = document.createElement('p'); link.textContent = job.group.link; link.style.wordBreak = 'break-all'; card.appendChild(link); }
      const actions = document.createElement('div'); actions.style.display = 'flex'; actions.style.gap = '8px'; actions.style.flexWrap = 'wrap';
      if (['RUNNING', 'CREATING'].includes(job.status)) {
        const pause = document.createElement('button'); pause.type = 'button'; pause.textContent = 'Pause'; pause.addEventListener('click', () => controlCommunityJob(job.id, 'pause')); actions.appendChild(pause);
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Arrêter'; cancel.addEventListener('click', () => controlCommunityJob(job.id, 'cancel')); actions.appendChild(cancel);
      }
      if (['PAUSED_USER', 'PAUSED_RATE_LIMIT', 'INTERRUPTED'].includes(job.status) && job.group && job.group.id) {
        const resume = document.createElement('button'); resume.type = 'button'; resume.textContent = 'Reprendre'; resume.addEventListener('click', () => resumeCommunityJob(job.id)); actions.appendChild(resume);
      }
      if (job.status === 'CREATION_UNKNOWN') {
        const stop = document.createElement('button'); stop.type = 'button'; stop.textContent = 'Marquer comme arrêtée'; stop.addEventListener('click', () => controlCommunityJob(job.id, 'cancel')); actions.appendChild(stop);
      }
      if (actions.childElementCount) card.appendChild(actions);
      const members = document.createElement('details'); const summary = document.createElement('summary'); summary.textContent = 'Résultat par contact'; members.appendChild(summary);
      (job.members || []).forEach(member => { const row = document.createElement('p'); row.textContent = (member.name ? member.name + ' · ' : '') + member.identifier + ' · ' + member.status + (member.reason ? ' · ' + member.reason : ''); members.appendChild(row); });
      card.appendChild(members); host.appendChild(card);
    });
  }
  async function saveJob(job) { await Cyrus.db.saveCommunityJob(job); await renderCommunityJobs(); }
  async function communityPauseState(jobId) {
    if (communityPauseRequests.has(jobId)) return communityPauseRequests.get(jobId);
    const jobs = await Cyrus.db.getCommunityJobs();
    const job = jobs.find(item => item.id === jobId);
    return job && job.controlRequest || '';
  }
  function waitCommunityDelay(seconds) { return new Promise(resolve => setTimeout(resolve, seconds * 1000)); }
  function mapCommunityOutcome(member, result) {
    const outcome = String(result && result.outcome || 'FAILED');
    if (outcome === 'INVITED') { member.status = 'added'; member.reason = ''; }
    else if (outcome === 'ALREADY') { member.status = 'already_member'; member.reason = ''; }
    else if (outcome === 'LINK_SENT') { member.status = 'invited_dm'; member.reason = 'Lien officiel envoyé en message privé'; }
    else if (outcome === 'NEEDS_LINK') { member.status = 'needs_invite'; member.reason = 'Ajout direct refusé; partager manuellement le lien officiel'; }
    else if (outcome === 'NOT_ON_PLATFORM') { member.status = 'not_on_platform'; member.reason = 'Compte introuvable sur cette plateforme'; }
    else if (outcome === 'RATE_LIMIT') { member.status = 'pending'; member.reason = 'Limitation de débit; reprise possible plus tard'; }
    else if (outcome === 'UNKNOWN') { member.status = 'unknown'; member.reason = String(result && result.error || 'La plateforme n’a pas confirmé le résultat. Vérifie le groupe avant toute nouvelle action.').slice(0, 300); }
    else { member.status = 'failed'; member.reason = String(result && result.error || 'Action refusée par la plateforme').slice(0, 300); }
  }
  async function runCommunityJob(jobId, createGroup) {
    if (activeCommunityJobs.has(jobId)) return;
    activeCommunityJobs.add(jobId);
    let job = (await Cyrus.db.getCommunityJobs()).find(item => item.id === jobId);
    let activeMember = null;
    if (!job) { activeCommunityJobs.delete(jobId); return; }
    try {
      if (createGroup || !job.group || !job.group.id) {
        job.status = 'CREATING'; job.controlRequest = ''; job.phase = 'create'; job.error = '';
        await saveJob(job);
        const first = job.channel === 'WHATSAPP' ? job.members[0] : null;
        const result = await sendCommunityOperation(job, 'create', { title: job.title, about: job.about,
          firstIdentifier: first && first.identifier || '' });
        if (!result || !result.ok || !result.groupId) {
          job.status = result && result.ambiguous ? 'CREATION_UNKNOWN' : 'FAILED';
          job.error = String(result && result.error || 'La plateforme n’a pas confirmé la création du groupe.');
          await saveJob(job); return;
        }
        job.group = { id: String(result.groupId), subject: result.title || job.title, link: result.inviteLink || '' };
        job.phase = 'inviting'; job.status = 'RUNNING';
        if (first && result.firstOutcome) {
          if (result.firstOutcome === 'NEEDS_LINK' && job.sendFallback) first.status = 'pending';
          else mapCommunityOutcome(first, { outcome: result.firstOutcome, error: result.firstError });
        }
        if (result.linkError && !job.error) job.error = 'Le groupe est créé, mais son lien d’invitation n’a pas pu être récupéré : ' + result.linkError;
        await saveJob(job);
      }
      const pending = job.members.filter(member => member.status === 'pending');
      for (let index = 0; index < pending.length; index++) {
        const control = await communityPauseState(job.id);
        if (control === 'pause' || control === 'cancel') {
          job.status = control === 'cancel' ? 'CANCELLED' : 'PAUSED_USER'; job.controlRequest = ''; job.error = control === 'cancel' ? 'Arrêt demandé; le groupe et les invitations déjà confirmées sont conservés.' : 'En pause à votre demande; reprenez pour continuer avec les contacts en attente.';
          await saveJob(job); return;
        }
        const member = pending[index];
        activeMember = member;
        const result = await sendCommunityOperation(job, 'invite', { groupId: job.group.id, identifier: member.identifier,
          name: member.name, title: job.title, inviteMessage: job.inviteMessage, inviteLink: job.group.link,
          sendFallback: job.sendFallback === true });
        if (!result || !result.ok) {
          const error = String(result && result.error || 'La plateforme a refusé cette invitation.');
          if (/rate|429|flood|overlimit/i.test(error)) {
            job.status = 'PAUSED_RATE_LIMIT'; member.reason = error.slice(0, 300); job.error = 'La plateforme a limité les invitations; le contact courant reste en attente.';
            await saveJob(job); return;
          }
          member.status = 'failed'; member.reason = error.slice(0, 300);
        } else {
          mapCommunityOutcome(member, result);
          if (result.inviteLink && !job.group.link) job.group.link = result.inviteLink;
          if (result.outcome === 'RATE_LIMIT') {
            job.status = 'PAUSED_RATE_LIMIT'; job.error = String(result.error || 'Limitation de débit; reprise possible plus tard.');
            await saveJob(job); return;
          }
        }
        job.status = 'RUNNING'; job.controlRequest = '';
        await saveJob(job); activeMember = null;
        if (index < pending.length - 1) {
          const min = job.channel === 'TELEGRAM' ? 30 : job.delayMin;
          const max = job.channel === 'TELEGRAM' ? 60 : job.delayMax;
          await waitCommunityDelay(min + Math.random() * Math.max(0, max - min));
        }
      }
      const finalControl = await communityPauseState(job.id);
      if (finalControl === 'pause' || finalControl === 'cancel') {
        job.status = finalControl === 'cancel' ? 'CANCELLED' : 'PAUSED_USER'; job.controlRequest = '';
        job.error = finalControl === 'cancel' ? 'Arrêt demandé; les actions déjà confirmées sont conservées.' : 'En pause à votre demande; reprenez pour continuer avec les contacts en attente.';
        await saveJob(job); return;
      }
      const issue = job.members.some(member => ['failed', 'needs_invite', 'not_on_platform', 'opted_out', 'unknown'].includes(member.status));
      job.status = issue ? 'DONE_WITH_ISSUES' : 'DONE'; job.phase = ''; job.controlRequest = '';
      job.error = issue ? 'Consulte le détail par contact; aucun refus de plateforme n’est contourné.' : '';
      await saveJob(job);
    } catch (error) {
      if (activeMember) { activeMember.status = 'unknown'; activeMember.reason = String(error && error.message || error).slice(0, 300); }
      job.status = job.group && job.group.id ? 'PAUSED_USER' : 'CREATION_UNKNOWN';
      job.error = String(error && error.message || error).slice(0, 500);
      await saveJob(job);
    } finally { activeCommunityJobs.delete(jobId); communityPauseRequests.delete(jobId); }
  }
  async function createCommunityJob() {
    const feedback = document.getElementById('mobile-community-job-feedback');
    const button = document.getElementById('mobile-community-create');
    const channel = document.getElementById('mobile-community-create-channel').value;
    const title = document.getElementById('mobile-community-title').value.trim();
    const about = document.getElementById('mobile-community-about').value.trim();
    const raw = document.getElementById('mobile-community-recipients').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (title.length < 2 || !raw.length) { feedback.textContent = 'Saisis le nom du groupe et au moins un contact.'; return; }
    if (raw.length > COMMUNITY_LIMIT) { feedback.textContent = 'Limite mobile : ' + COMMUNITY_LIMIT + ' contacts par opération.'; return; }
    const members = raw.map(line => {
      const parts = line.split('|'); const name = parts.length > 1 ? parts[0].trim() : '';
      const identifier = (parts.length > 1 ? parts.slice(1).join('|') : parts[0]).trim();
      return { identifier: channel === 'WHATSAPP' ? identifier.replace(/\D/g, '') : identifier, name, status: 'pending', reason: '' };
    }).filter(member => channel === 'WHATSAPP' ? /^\d{8,15}$/.test(member.identifier) : (member.identifier.startsWith('@') || /^\d{1,11}$/.test(member.identifier)));
    const unique = [...new Map(members.map(member => [member.identifier.toLowerCase(), member])).values()];
    if (!unique.length) { feedback.textContent = channel === 'WHATSAPP' ? 'Aucun numéro WhatsApp valide (8 à 15 chiffres avec indicatif pays).' : 'Saisis des @usernames ou identifiants utilisateur Telegram valides.'; return; }
    const allowed = await Cyrus.db.filterBlocked(channel.toLowerCase(), unique);
    const blocked = unique.length - allowed.length;
    if (!allowed.length) { feedback.textContent = 'Tous les contacts sont bloqués ou la liste est vide.'; return; }
    const minRaw = Math.max(5, Number(document.getElementById('mobile-community-delay-min').value) || 5);
    const maxRaw = Math.max(minRaw, Number(document.getElementById('mobile-community-delay-max').value) || 9);
    const delayMin = channel === 'TELEGRAM' ? Math.max(30, minRaw) : Math.min(300, minRaw);
    const delayMax = channel === 'TELEGRAM' ? Math.max(60, maxRaw) : Math.min(600, maxRaw);
    const job = {
      id: 'community_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), channel, title, about,
      inviteMessage: document.getElementById('mobile-community-invite-message').value.trim(),
      sendFallback: document.getElementById('mobile-community-send-fallback').checked,
      delayMin, delayMax, status: 'QUEUED', phase: 'create', members: allowed, group: null, error: blocked ? blocked + ' contact(s) bloqué(s) exclus.' : '', createdAt: Date.now(),
    };
    const fallbackNotice = job.sendFallback ? '\n\nLa case autorise aussi un message privé avec le lien officiel aux personnes pour lesquelles l’ajout direct est refusé.' : '';
    const confirmation = 'Créer « ' + title + ' » sur ' + channel + ' et lancer les invitations pour ' + allowed.length + ' contact(s)' + (blocked ? ' (' + blocked + ' bloqué(s) exclus)' : '') + ' ?' + fallbackNotice;
    if (!window.confirm(confirmation)) return;
    button.disabled = true; feedback.textContent = 'Création du job local…';
    try { await Cyrus.db.saveCommunityJob(job); await renderCommunityJobs(); feedback.textContent = 'Job enregistré; la création et les invitations commencent.'; await runCommunityJob(job.id, true); }
    catch (error) { feedback.textContent = 'Impossible d’enregistrer le job : ' + error.message; }
    finally { button.disabled = false; }
  }
  async function controlCommunityJob(jobId, action) {
    const job = (await Cyrus.db.getCommunityJobs()).find(item => item.id === jobId); if (!job) return;
    if (action === 'cancel' && !window.confirm('Arrêter ce job ? Les invitations déjà confirmées restent effectives.')) return;
    if (activeCommunityJobs.has(jobId)) {
      communityPauseRequests.set(jobId, action);
      job.controlRequest = action; job.status = action === 'cancel' ? 'CANCELLING' : 'PAUSING';
    } else { job.status = action === 'cancel' ? 'CANCELLED' : 'PAUSED_USER'; job.controlRequest = ''; }
    job.error = action === 'cancel' ? 'Arrêt demandé.' : 'Pause demandée.'; await saveJob(job);
  }
  async function resumeCommunityJob(jobId) {
    const job = (await Cyrus.db.getCommunityJobs()).find(item => item.id === jobId); if (!job || activeCommunityJobs.has(jobId)) return;
    if (!job.group || !job.group.id) { document.getElementById('mobile-community-job-feedback').textContent = 'Le résultat de création est incertain. Vérifie la liste des groupes avant de lancer une nouvelle création.'; return; }
    job.status = 'RUNNING'; job.error = ''; job.controlRequest = ''; await saveJob(job); runCommunityJob(jobId, false);
  }
  async function loadContactsForCommunity() {
    const channel = document.getElementById('mobile-community-create-channel').value;
    const rows = await Cyrus.db.getContacts(channel.toLowerCase());
    const valid = rows.filter(item => item && item.identifier).map(item => (item.name ? item.name + ' | ' : '') + item.identifier);
    document.getElementById('mobile-community-recipients').value = valid.join('\n');
    document.getElementById('mobile-community-contact-count').textContent = valid.length + ' contact(s) importé(s); la liste noire sera appliquée au lancement.';
  }
  async function restoreCommunityJobs() {
    const jobs = await Cyrus.db.getCommunityJobs();
    for (const job of jobs) {
      if (job.status === 'CREATING' || (job.status === 'RUNNING' && (!job.group || !job.group.id))) {
        job.status = 'CREATION_UNKNOWN'; job.error = 'L’application s’est arrêtée pendant la création. Vérifie les groupes sur la plateforme avant toute nouvelle opération.'; await Cyrus.db.saveCommunityJob(job);
      } else if (job.status === 'RUNNING' || job.status === 'PAUSING' || job.status === 'CANCELLING') {
        job.status = 'INTERRUPTED'; job.controlRequest = ''; job.error = 'L’application s’est arrêtée pendant les invitations; les contacts non traités peuvent être repris.'; await Cyrus.db.saveCommunityJob(job);
      }
    }
    await renderCommunityJobs();
  }
  const scheduledTimers = new Map();
  const scheduledSendOps = new Map();
  function formatScheduledStatus(status) {
    return ({ scheduled: 'Programmée', sending: 'En cours', sent: 'Envoyée', failed: 'Échec confirmé', unknown: 'Résultat incertain — vérifie la conversation avant un nouvel envoi', overdue: 'Échéance passée pendant la fermeture de l’application', cancelled: 'Annulée' })[status] || status;
  }
  async function renderScheduledMessages() {
    const host = document.getElementById('schedule-list'); if (!host) return;
    const items = await Cyrus.db.getScheduledMessages(); host.replaceChildren();
    if (!items.length) { host.textContent = 'Aucun message programmé.'; return; }
    items.slice().reverse().forEach(item => {
      const card = document.createElement('div'); card.className = 'card';
      const title = document.createElement('b'); title.textContent = item.channel.toUpperCase() + ' · ' + item.identifier; card.appendChild(title);
      const when = document.createElement('p'); when.textContent = new Date(item.scheduledAt).toLocaleString() + ' · ' + formatScheduledStatus(item.status); card.appendChild(when);
      const message = document.createElement('p'); message.textContent = (item.text || '[Pièce jointe]') + (item.media ? ' · ' + item.media.filename : ''); card.appendChild(message);
      if (item.error) { const error = document.createElement('small'); error.textContent = item.error; card.appendChild(error); }
      const actions = document.createElement('div'); actions.style.display = 'flex'; actions.style.gap = '8px'; actions.style.flexWrap = 'wrap';
      if (item.status === 'scheduled') {
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Annuler'; cancel.addEventListener('click', () => cancelScheduledMessage(item.id)); actions.appendChild(cancel);
      }
      if (['failed', 'unknown', 'overdue'].includes(item.status)) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.textContent = 'Renvoyer après vérification';
        retry.addEventListener('click', async () => {
          if (!window.confirm('Vérifie d’abord la conversation. Si le premier envoi a abouti sans accusé de réception, le renvoi peut créer un doublon. Continuer ?')) return;
          const latest = (await Cyrus.db.getScheduledMessages()).find(row => row.id === item.id); if (!latest) return;
          latest.status = 'scheduled'; latest.scheduledAt = Date.now(); latest.error = ''; await Cyrus.db.saveScheduledMessage(latest); armScheduledMessage(latest); await renderScheduledMessages();
        }); actions.appendChild(retry);
      }
      if (actions.childElementCount) card.appendChild(actions);
      host.appendChild(card);
    });
  }
  function scheduleTimer(id, at) {
    if (scheduledTimers.has(id)) clearTimeout(scheduledTimers.get(id));
    const arm = async function () {
      const remaining = Number(at) - Date.now();
      if (remaining > 2147480000) { scheduledTimers.set(id, setTimeout(arm, 2147480000)); return; }
      if (remaining > 0) { scheduledTimers.set(id, setTimeout(arm, remaining)); return; }
      scheduledTimers.delete(id); await dispatchScheduledMessage(id);
    };
    arm();
  }
  function armScheduledMessage(item) { if (item.status === 'scheduled') scheduleTimer(item.id, item.scheduledAt); }
  async function readScheduledMedia(file) {
    if (!file) return null;
    if (file.size > 4 * 1024 * 1024) throw new Error('La pièce jointe dépasse 4 Mo.');
    if (!(file.type.startsWith('image/') || file.type.startsWith('video/') || file.type === 'application/pdf')) throw new Error('Seules les images, vidéos et pièces PDF sont acceptées.');
    return new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve({ filename: file.name, mimetype: file.type || 'application/octet-stream', data: String(reader.result).split(',')[1] || '' }); reader.onerror = () => reject(reader.error || new Error('Lecture du fichier impossible.')); reader.readAsDataURL(file); });
  }
  async function createScheduledMessage() {
    const feedback = document.getElementById('schedule-feedback'); const button = document.getElementById('schedule-create');
    const channel = document.getElementById('schedule-channel').value;
    let identifier = document.getElementById('schedule-recipient').value.trim();
    const text = document.getElementById('schedule-message').value.trim(); const scheduledAt = new Date(document.getElementById('schedule-at').value).getTime();
    const file = document.getElementById('schedule-media').files[0] || null;
    if (channel === 'whatsapp') identifier = identifier.replace(/\D/g, '');
    if (channel === 'whatsapp' && !/^\d{8,15}$/.test(identifier)) { feedback.textContent = 'Saisis un numéro WhatsApp de 8 à 15 chiffres avec son indicatif pays.'; return; }
    if (channel === 'telegram' && !(identifier.startsWith('@') || /^\d{1,11}$/.test(identifier))) { feedback.textContent = 'Saisis un @username ou un identifiant utilisateur Telegram.'; return; }
    if (!text && !file) { feedback.textContent = 'Ajoute un message ou une pièce jointe.'; return; }
    if (!Number.isFinite(scheduledAt) || scheduledAt < Date.now() + 60000 || scheduledAt > Date.now() + 366 * 86400000) { feedback.textContent = 'Choisis une date entre 1 minute et 1 an à partir de maintenant.'; return; }
    button.disabled = true; feedback.textContent = 'Enregistrement local…';
    try {
      const media = await readScheduledMedia(file);
      if (!window.confirm('Programmer ce message pour ' + identifier + ' le ' + new Date(scheduledAt).toLocaleString() + ' ? Il sera envoyé automatiquement si Cyrus mobile est ouvert et la session connectée.')) return;
      const item = { id: 'scheduled_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), channel, identifier, text, media, scheduledAt, status: 'scheduled', createdAt: Date.now(), error: '' };
      await Cyrus.db.saveScheduledMessage(item); armScheduledMessage(item); await renderScheduledMessages();
      feedback.textContent = 'Message programmé sur cet appareil.';
      document.getElementById('schedule-message').value = ''; document.getElementById('schedule-media').value = '';
    } catch (error) { feedback.textContent = 'Programmation impossible : ' + String(error && error.message || error); }
    finally { button.disabled = false; }
  }
  async function dispatchScheduledMessage(id) {
    const item = (await Cyrus.db.getScheduledMessages()).find(row => row.id === id);
    if (!item || item.status !== 'scheduled') return;
    if (!window.CyrusMobileSessions || !window.CyrusMobileSessions.isReady(item.channel)) {
      item.status = 'failed'; item.error = 'Le canal n’était pas connecté à l’heure prévue. Ouvre-le, vérifie la conversation, puis renvoie manuellement.';
      await Cyrus.db.saveScheduledMessage(item); await renderScheduledMessages(); return;
    }
    item.status = 'sending'; item.error = ''; await Cyrus.db.saveScheduledMessage(item); await renderScheduledMessages();
    const bridge = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.EmbeddedWebView;
    if (!bridge) { item.status = 'failed'; item.error = 'Pont de communication mobile indisponible.'; await Cyrus.db.saveScheduledMessage(item); await renderScheduledMessages(); return; }
    const webviewId = item.channel === 'whatsapp' ? 'whatsapp' : 'telegram';
    const fn = item.channel === 'whatsapp' ? '__cyrusWaScheduledSend' : '__cyrusTgScheduledSend';
    const timer = setTimeout(async () => {
      scheduledSendOps.delete(item.id); item.status = 'unknown'; item.error = 'Aucun accusé de réception. Vérifie la conversation avant de renvoyer.'; await Cyrus.db.saveScheduledMessage(item); await renderScheduledMessages();
    }, 90000);
    scheduledSendOps.set(item.id, { timer });
    const payload = { id: item.id, identifier: item.identifier, text: item.text, media: item.media };
    const fallback = 'window.Cyrus.postMessage(JSON.stringify({type:"scheduled-send-result",payload:{id:' + JSON.stringify(item.id) + ',ok:false,error:"Session du canal non prête; ouvrez et connectez le canal avant de programmer un nouvel envoi."}}));';
    bridge.evaluate({ id: webviewId, script: 'window.' + fn + ' ? window.' + fn + '(' + JSON.stringify(payload) + ') : ' + fallback }).catch(async error => {
      const pending = scheduledSendOps.get(item.id); if (pending) clearTimeout(pending.timer); scheduledSendOps.delete(item.id);
      item.status = 'unknown'; item.error = 'Résultat incertain après l’appel au pont : ' + String(error.message || error); await Cyrus.db.saveScheduledMessage(item); await renderScheduledMessages();
    });
  }
  async function handleScheduledSendResult(payload) {
    const pending = scheduledSendOps.get(String(payload && payload.id || ''));
    if (pending) clearTimeout(pending.timer); scheduledSendOps.delete(String(payload && payload.id || ''));
    const item = (await Cyrus.db.getScheduledMessages()).find(row => row.id === String(payload && payload.id || ''));
    if (!item || item.status !== 'sending') return;
    item.status = payload && payload.ok ? 'sent' : 'failed'; item.sentAt = item.status === 'sent' ? Date.now() : null;
    item.error = item.status === 'sent' ? '' : String(payload && payload.error || 'La plateforme n’a pas confirmé l’envoi.');
    await Cyrus.db.saveScheduledMessage(item); await renderScheduledMessages();
  }
  async function cancelScheduledMessage(id) {
    const item = (await Cyrus.db.getScheduledMessages()).find(row => row.id === id); if (!item || item.status !== 'scheduled') return;
    if (!window.confirm('Annuler ce message programmé ?')) return;
    if (scheduledTimers.has(id)) clearTimeout(scheduledTimers.get(id)); scheduledTimers.delete(id);
    item.status = 'cancelled'; item.error = ''; await Cyrus.db.saveScheduledMessage(item); await renderScheduledMessages();
  }
  async function restoreScheduledMessages() {
    const items = await Cyrus.db.getScheduledMessages();
    for (const item of items) {
      if (item.status === 'sending') { item.status = 'unknown'; item.error = 'L’application s’est arrêtée pendant l’envoi. Vérifie la conversation avant de renvoyer.'; await Cyrus.db.saveScheduledMessage(item); }
      else if (item.status === 'scheduled' && Number(item.scheduledAt) <= Date.now()) {
        item.status = 'overdue'; item.error = 'L’application était fermée à l’heure prévue. Vérifie le canal puis choisis explicitement de renvoyer.'; await Cyrus.db.saveScheduledMessage(item);
      } else if (item.status === 'scheduled') armScheduledMessage(item);
    }
    await renderScheduledMessages();
  }
  async function handleCommunitySearch(payload) {
    const feedback = document.getElementById('mobile-community-discovery-feedback');
    const host = document.getElementById('mobile-community-results');
    const items = (payload && payload.results) || [];
    if (!items.length) { host.textContent = 'Aucune communauté publique trouvée dans les résultats Telegram.'; feedback.textContent = 'Recherche officielle terminée.'; return; }
    items.forEach(item => communityNames.set('TELEGRAM:' + String(item.id || item.ref), item.name || item.ref));
    await Cyrus.db.saveCommunities(items);
    renderCommunityItems(items, host, false);
    await renderCommunityDirectory();
    feedback.textContent = items.length + ' communauté(s) publique(s) trouvée(s) par la recherche officielle Telegram.';
  }
  async function discoverPeople() {
    const input = document.getElementById('mobile-people-keywords');
    const button = document.getElementById('mobile-people-discover');
    const feedback = document.getElementById('mobile-people-feedback');
    const keywords = [...new Set(input.value.split(/[,;\n]/).map(x => x.trim()).filter(x => x.length >= 2))].slice(0, 5);
    if (!keywords.length) { feedback.textContent = 'Saisis au moins un mot-clé de 2 caractères.'; return; }
    const bridge = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.EmbeddedWebView;
    if (!bridge) { feedback.textContent = 'Pont Telegram indisponible.'; return; }
    button.disabled = true; feedback.textContent = 'Recherche officielle des profils publics en cours…';
    try {
      const script = 'window.__cyrusTgDiscoverPeople ? window.__cyrusTgDiscoverPeople(' + JSON.stringify(keywords.join(',')) + ', 15) : window.Cyrus.postMessage(JSON.stringify({type:"bridge-error",payload:{where:"discoverPeople",message:"Pont Telegram pas encore prêt. Ouvre d’abord l’écran Telegram."}}));';
      await bridge.evaluate({ id: 'telegram', script });
    } catch (error) { button.disabled = false; feedback.textContent = 'Recherche impossible : ' + String(error.message || error); }
  }
  async function handleCommunityPeopleSearch(payload) {
    const host = document.getElementById('mobile-people-results'); host.replaceChildren();
    const feedback = document.getElementById('mobile-people-feedback');
    const button = document.getElementById('mobile-people-discover'); button.disabled = false;
    const people = (payload && payload.results) || [];
    if (!people.length) { feedback.textContent = 'Aucun profil public Telegram correspondant.'; return; }
    const contacts = await Cyrus.db.getContacts('telegram');
    const existing = new Set(contacts.map(c => String(c.identifier)));
    people.forEach(person => {
      const card = document.createElement('div'); card.className = 'card';
      const title = document.createElement('b'); title.textContent = person.name; card.appendChild(title);
      const detail = document.createElement('p'); detail.textContent = '@' + person.username + ' · identifiant Telegram ' + person.id + ' · ' + person.keywords.join(', '); card.appendChild(detail);
      const open = document.createElement('button'); open.type = 'button'; open.textContent = 'Ouvrir le profil public'; open.addEventListener('click', () => openCommunity({ link: person.link })); card.appendChild(open);
      const save = document.createElement('button'); save.type = 'button'; save.textContent = existing.has(String(person.id)) ? 'Déjà dans les contacts' : 'Ajouter comme prospect local'; save.disabled = existing.has(String(person.id));
      save.addEventListener('click', async () => {
        save.disabled = true;
        try {
          await Cyrus.db.putAllContacts('telegram', [{ identifier: String(person.id), name: person.name, username: person.username, source: 'telegram-public-discovery', discoveryKeywords: person.keywords, discoveredAt: Date.now() }]);
          save.textContent = 'Prospect enregistré'; existing.add(String(person.id));
          feedback.textContent = person.name + ' ajouté aux contacts locaux comme prospect à valider.';
          await renderProspects();
        } catch (error) { save.disabled = false; feedback.textContent = 'Enregistrement impossible : ' + error.message; }
      });
      card.appendChild(save); host.appendChild(card);
    });
    feedback.textContent = people.length + ' profil(s) public(s) trouvé(s). Rien n’a été contacté automatiquement.';
  }
  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('mobile-help-search').addEventListener('input', e => renderHelp(e.target.value));
    document.getElementById('mobile-report-refresh').addEventListener('click', renderReports);
    document.getElementById('mobile-report-export').addEventListener('click', exportReports);
    document.getElementById('mobile-report-from').addEventListener('change', renderReports);
    document.getElementById('mobile-report-to').addEventListener('change', renderReports);
    document.getElementById('mobile-report-channel').addEventListener('change', renderReports);
    document.getElementById('mobile-report-status').addEventListener('change', renderReports);
    document.getElementById('mobile-report-search').addEventListener('input', renderReports);
    document.getElementById('mobile-report-analyze').addEventListener('click', analyzeMobileReport);
    document.getElementById('mobile-report-improvements-scan').addEventListener('click', scanImprovements);
    document.getElementById('mobile-prospects-refresh').addEventListener('click', renderProspects);
    document.getElementById('mobile-prospects-export').addEventListener('click', exportProspects);
    document.getElementById('mobile-groups-wa').addEventListener('click', () => window.Capacitor.Plugins.EmbeddedWebView.evaluate({ id: 'whatsapp', script: 'window.__cyrusGetGroups && window.__cyrusGetGroups()' }));
    document.getElementById('mobile-groups-tg').addEventListener('click', () => window.Capacitor.Plugins.EmbeddedWebView.evaluate({ id: 'telegram', script: 'window.__cyrusTgGetGroups && window.__cyrusTgGetGroups()' }));
    document.getElementById('mobile-community-discover').addEventListener('click', discoverCommunities);
    document.getElementById('mobile-people-discover').addEventListener('click', discoverPeople);
    document.getElementById('mobile-community-create').addEventListener('click', createCommunityJob);
    document.getElementById('mobile-community-load-contacts').addEventListener('click', loadContactsForCommunity);
    document.getElementById('schedule-create').addEventListener('click', createScheduledMessage);
    document.getElementById('schedule-refresh').addEventListener('click', renderScheduledMessages);
    document.getElementById('mobile-community-create-channel').addEventListener('change', () => {
      const min = document.getElementById('mobile-community-delay-min'); const max = document.getElementById('mobile-community-delay-max');
      if (document.getElementById('mobile-community-create-channel').value === 'TELEGRAM') { min.value = Math.max(30, Number(min.value) || 30); max.value = Math.max(60, Number(max.value) || 60); min.min = '30'; max.min = '60'; }
      else { min.min = '5'; max.min = '5'; min.value = Math.max(5, Math.min(300, Number(min.value) || 5)); max.value = Math.max(Number(min.value), Math.min(600, Number(max.value) || 9)); }
    });
    renderCommunityDirectory().catch(err => { document.getElementById('mobile-community-directory').textContent = 'Annuaire local indisponible : ' + err.message; });
    restoreCommunityJobs().catch(err => { document.getElementById('mobile-community-jobs').textContent = 'Jobs locaux indisponibles : ' + err.message; });
    restoreScheduledMessages().catch(err => { document.getElementById('schedule-list').textContent = 'Planning local indisponible : ' + err.message; });
    document.getElementById('mobile-members-export').addEventListener('click', exportGroupMembers);
    renderStoredMembers().catch(err => { document.getElementById('mobile-groups-feedback').textContent = 'Historique des extractions indisponible : ' + err.message; });
    renderHelp(''); renderReports(); renderProspects();
  });
  window.CyrusParity = { renderGroups, renderMembers, renderCommunityDirectory, renderCommunityJobs, handleCommunitySearch, handleCommunityPeopleSearch, handleCommunityOperation, handleScheduledSendResult };
})();
