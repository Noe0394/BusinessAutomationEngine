// Import de contacts depuis un fichier .xlsx/.csv choisi par l'utilisateur -
// utilise SheetJS (lib/xlsx.full.min.js, vendu localement, aucun reseau
// necessaire). Reconnait une colonne d'identifiant (numero WhatsApp/Telegram
// ou @username) sous plusieurs noms de colonne courants, et une colonne nom
// optionnelle - meme tolerance que local-client (voir POST /api/contacts/import
// historique), pour accepter des fichiers exportes de sources variees
// (Google Contacts, autre CRM, export manuel) sans forcer un format strict.
(function () {
  const IDENTIFIER_HEADERS = ['identifier', 'numero', 'number', 'phone', 'telephone', 'username', 'id'];
  const NAME_HEADERS = ['name', 'nom', 'prenom', 'first_name', 'fullname'];

  function findHeader(headers, candidates) {
    const lower = headers.map(function (h) { return String(h || '').trim().toLowerCase(); });
    for (const candidate of candidates) {
      const idx = lower.indexOf(candidate);
      if (idx !== -1) return headers[idx];
    }
    return null;
  }

  // file : un objet File (input[type=file]). Retourne
  // Promise<{identifier, name}[]>, identifiants dedupliques et nettoyes.
  function parseContactsFile(file) {
    return file.arrayBuffer().then(function (buffer) {
      const workbook = XLSX.read(buffer, { type: 'array' });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
      if (rows.length === 0) return [];

      const headers = Object.keys(rows[0]);
      const identifierHeader = findHeader(headers, IDENTIFIER_HEADERS) || headers[0];
      const nameHeader = findHeader(headers, NAME_HEADERS);

      const seen = new Set();
      const contacts = [];
      rows.forEach(function (row) {
        const rawIdentifier = String(row[identifierHeader] || '').trim();
        if (!rawIdentifier) return;
        // Numero -> chiffres seuls (comme le reste du projet, voir
        // WhatsAppWebEngine.tsx normalizeWid) ; @username -> conserve tel quel.
        const identifier = rawIdentifier.startsWith('@')
          ? rawIdentifier
          : rawIdentifier.replace(/\D/g, '');
        if (!identifier || seen.has(identifier)) return;
        seen.add(identifier);
        contacts.push({ identifier: identifier, name: nameHeader ? String(row[nameHeader] || '').trim() : '' });
      });
      return contacts;
    });
  }

  window.Cyrus = window.Cyrus || {};
  window.Cyrus.contactsImport = { parseContactsFile: parseContactsFile };
})();
