// Registre local des contacts issus des campagnes d'entree.
(function () {
  let contacts = [];
  const columns = [
    ['label', 'Nom'], ['phoneDisplay', 'Téléphone'], ['channel', 'Canal'],
    ['campaignName', 'Campagne'], ['platform', 'Plateforme'], ['sourceVerified', 'Source'], ['firstSeenAt', 'Premier contact'],
  ];
  function date(value) {
    const n = Number(value);
    return n ? new Date(n).toLocaleString() : '';
  }
  async function load() {
    const feedback = document.getElementById('ad-contacts-feedback');
    const body = document.getElementById('ad-contacts-body');
    feedback.textContent = 'Chargement…';
    try {
      const response = await fetch('/api/ad-campaigns/new-contacts');
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Registre indisponible');
      contacts = data.contacts || [];
      body.replaceChildren();
      if (!contacts.length) {
        const row = body.insertRow(); const cell = row.insertCell(); cell.colSpan = 7; cell.textContent = 'Aucun contact publicitaire enregistré.';
      } else contacts.forEach((contact) => {
        const row = body.insertRow();
        columns.forEach(([key]) => {
          const cell = row.insertCell();
          cell.textContent = key === 'sourceVerified' ? (contact.sourceVerified ? 'Vérifiée' : 'Déduite du message')
            : key === 'firstSeenAt' ? date(contact.firstSeenAt || contact.contactedAt)
              : String(contact[key] == null ? '' : contact[key]);
        });
      });
      feedback.textContent = contacts.length + ' contact(s).';
    } catch (error) { feedback.textContent = 'Erreur : ' + error.message; }
  }
  function exportExcel() {
    if (!contacts.length) { document.getElementById('ad-contacts-feedback').textContent = 'Aucun contact à exporter.'; return; }
    const rows = contacts.map((c) => ({
      Nom: c.label || c.name || '', Téléphone: c.phoneDisplay || '', Identifiant: c.from || '', Canal: c.channel || '',
      Campagne: c.campaignName || '', 'Produit / service': c.productName || '', Plateforme: c.platform || '',
      'Origine vérifiée': c.sourceVerified ? 'Oui' : 'Non, déduite du message', 'Message d’entrée': c.entryText || '',
      Statut: c.statusLabel || 'En attente', 'Premier contact': date(c.firstSeenAt || c.contactedAt),
    }));
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Prospects');
    XLSX.writeFile(workbook, 'prospects-publicitaires.xlsx');
  }
  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('ad-contacts-refresh').addEventListener('click', load);
    document.getElementById('ad-contacts-export').addEventListener('click', exportExcel);
  });
  window.adContactsInit = load;
})();
