// Export de donnees (contacts extraits, membres de groupe) en fichier
// CSV/XLSX reellement enregistre sur l'appareil (dossier Documents de l'app
// via le plugin Capacitor Filesystem), puis propose au partage (plugin
// Share - permet d'envoyer le fichier vers Drive/email/autre app, seul moyen
// pour l'utilisateur d'en faire quelque chose depuis le stockage prive de
// l'app). SheetJS gere aussi bien la generation CSV que XLSX.
(function () {
  const Filesystem = window.Capacitor.Plugins.Filesystem;
  const Share = window.Capacitor.Plugins.Share;

  // rows : tableau d'objets {colonne: valeur} - la premiere ligne devient
  // l'entete. format : 'csv' | 'xlsx'.
  async function exportRows(rows, filename, format) {
    const sheet = XLSX.utils.json_to_sheet(rows);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Export');

    const isXlsx = format === 'xlsx';
    const data = XLSX.write(workbook, {
      type: 'base64',
      bookType: isXlsx ? 'xlsx' : 'csv',
    });
    const fullFilename = filename + (isXlsx ? '.xlsx' : '.csv');

    // Le CSV genere par SheetJS en base64 encode en realite le texte CSV
    // brut (charset simple) - Filesystem.writeFile accepte du base64 pour
    // toute donnee binaire ou texte de la meme facon, aucune distinction a
    // faire ici entre CSV et XLSX cote ecriture.
    const result = await Filesystem.writeFile({
      path: fullFilename,
      data: data,
      directory: 'DOCUMENTS',
    });

    await Share.share({
      title: fullFilename,
      url: result.uri,
    });

    return result.uri;
  }

  window.Cyrus = window.Cyrus || {};
  window.Cyrus.fileExport = { exportRows: exportRows };
})();
