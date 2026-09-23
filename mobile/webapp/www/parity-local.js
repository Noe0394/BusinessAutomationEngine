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
      const [wa, tg, campaigns, allSent, blockedWa, blockedTg, services] = await Promise.all([
        Cyrus.db.getContacts('whatsapp'), Cyrus.db.getContacts('telegram'), Cyrus.db.getCampaigns(), Cyrus.db.getSentLog(null),
        Cyrus.db.getBlocklist('whatsapp'), Cyrus.db.getBlocklist('telegram'), Cyrus.db.getBusinessServices(),
      ]);
      const fromText = document.getElementById('mobile-report-from').value;
      const toText = document.getElementById('mobile-report-to').value;
      const from = fromText ? new Date(fromText + 'T00:00:00').getTime() : 0;
      const to = toText ? new Date(toText + 'T00:00:00').getTime() + 86400000 : Infinity;
      const sent = allSent.filter(e => Number(e.sentAt) >= from && Number(e.sentAt) < to);
      const datedCampaigns = campaigns.filter(c => !c.updatedAt || (Number(c.updatedAt) >= from && Number(c.updatedAt) < to));
      const waSent = sent.filter(e => e.channel === 'whatsapp').length;
      const tgSent = sent.filter(e => e.channel === 'telegram').length;
      const failed = datedCampaigns.reduce((n, c) => n + (c.failed || []).length, 0);
      const campaignSent = datedCampaigns.reduce((n, c) => n + (c.sent || []).length, 0);
      const totalReported = campaignSent + failed;
      const successRate = totalReported ? Math.round(campaignSent * 100 / totalReported) + '%' : '—';
      reportSnapshot = { wa, tg, campaigns: datedCampaigns, sent, blockedWa, blockedTg, services, failed, campaignSent, successRate };
      const metrics = [
        ['Contacts WhatsApp', wa.length], ['Contacts Telegram', tg.length], ['Campagnes dans la période', datedCampaigns.length],
        ['Envois journalisés', sent.length], ['WhatsApp envoyés', waSent], ['Telegram envoyés', tgSent],
        ['Échecs de campagne', failed], ['Taux de réussite des campagnes mises à jour', successRate],
        ['Désinscriptions / blocages', blockedWa.length + blockedTg.length], ['Services Métiers', services.length],
      ];
      metrics.forEach(([label, value]) => { const card = document.createElement('div'); card.className = 'card'; const b = document.createElement('b'); b.textContent = String(value); const p = document.createElement('p'); p.textContent = label; card.append(b, p); host.appendChild(card); });
      const title = document.createElement('h3'); title.textContent = 'Derniers envois de la période'; host.appendChild(title);
      if (!sent.length) { const empty = document.createElement('p'); empty.textContent = 'Aucun envoi journalisé pour cette période.'; host.appendChild(empty); }
      sent.slice(0, 100).forEach(e => { const row = document.createElement('p'); row.textContent = new Date(e.sentAt).toLocaleString() + ' · ' + e.channel + ' · ' + e.identifier + (e.source ? ' · ' + e.source : ''); host.appendChild(row); });
      const campaignTitle = document.createElement('h3'); campaignTitle.textContent = 'Campagnes'; host.appendChild(campaignTitle);
      datedCampaigns.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 50).forEach(c => {
        const row = document.createElement('p'); row.textContent = (c.channel || '') + ' · ' + (c.status || 'inconnu') + ' · ' + (c.sent || []).length + ' envoyés · ' + (c.failed || []).length + ' échecs · ' + (c.message || c.id); host.appendChild(row);
      });
    } catch (err) { host.textContent = 'Les données locales ne sont pas disponibles : ' + err.message; }
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
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(s.wa.concat(s.tg).map(c => ({ Canal: c.channel, Nom: c.name || '', Identifiant: c.identifier }))), 'Contacts');
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
          lastSent: activity ? new Date(activity.sentAt).toLocaleString() : '', source: 'Import local (origine publicitaire inconnue)' };
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
  }  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('mobile-help-search').addEventListener('input', e => renderHelp(e.target.value));
    document.getElementById('mobile-report-refresh').addEventListener('click', renderReports);
    document.getElementById('mobile-report-export').addEventListener('click', exportReports);
    document.getElementById('mobile-report-from').addEventListener('change', renderReports);
    document.getElementById('mobile-report-to').addEventListener('change', renderReports);
    document.getElementById('mobile-prospects-refresh').addEventListener('click', renderProspects);
    document.getElementById('mobile-prospects-export').addEventListener('click', exportProspects);
    document.getElementById('mobile-groups-wa').addEventListener('click', () => window.Capacitor.Plugins.EmbeddedWebView.evaluate({ id: 'whatsapp', script: 'window.__cyrusGetGroups && window.__cyrusGetGroups()' }));
    document.getElementById('mobile-groups-tg').addEventListener('click', () => window.Capacitor.Plugins.EmbeddedWebView.evaluate({ id: 'telegram', script: 'window.__cyrusTgGetGroups && window.__cyrusTgGetGroups()' }));
    document.getElementById('mobile-members-export').addEventListener('click', exportGroupMembers);
    renderStoredMembers().catch(err => { document.getElementById('mobile-groups-feedback').textContent = 'Historique des extractions indisponible : ' + err.message; });
    renderHelp(''); renderReports(); renderProspects();
  });
  window.CyrusParity = { renderGroups, renderMembers };
})();
