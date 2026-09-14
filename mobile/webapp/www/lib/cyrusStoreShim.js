// Pont minimal window.CyrusStore -> window.Cyrus.db (lib/db.js), pour que
// chat-core.js (copié tel quel depuis webapp-core/, jamais modifié - voir ce
// fichier pour le détail) puisse tourner ici sans réécriture. Ce projet
// mobile n'implémente PAS le contrat complet CyrusEngine/CyrusStore
// (adapters/CONTRACT.md, webapp-core) - seules les 3 fonctions que
// chat-core.js appelle réellement (getContacts, filterBlocked,
// createCampaign) sont fournies ici, pas plus.
//
// Point d'attention : le schéma de campagne de CE projet diffère de la
// forme canonique du contrat (recipients:[{to,name,status}]) - voir
// campaign.js/lib/manualRelance.js, qui dérivent les contacts "en attente"
// en comparant TOUS les contacts stockés (db.getContacts) aux identifiants
// déjà dans campaign.sent/campaign.failed, plutôt que de lire une liste
// recipients dédiée. createCampaign() écrit donc dans CE schéma natif (sent/
// failed/message/total), pas celui du contrat.
(function () {
  const db = window.Cyrus.db;

  async function createCampaign(channel, opts) {
    const recipients = opts.recipients || [];
    // Les destinataires doivent exister comme contacts persistés : c'est sur
    // eux que manualRelance.js calcule la file "en attente" (getContacts
    // moins sent/failed), jamais sur un champ recipients dédié.
    await db.putAllContacts(channel, recipients.map((r) => ({ identifier: r.to, name: r.name || '' })));

    const campaign = {
      id: 'camp-' + Date.now(),
      channel: channel,
      total: recipients.length,
      message: opts.text || '',
      sent: [],
      failed: [],
      updatedAt: Date.now(),
      // JAMAIS 'running' ici : campaign.js proposerait une "reprise
      // automatique" au prochain démarrage de l'app pour une campagne que
      // l'utilisateur n'a pourtant jamais lancée lui-même.
      status: 'draft',
    };
    await db.saveCampaign(campaign);
    return campaign;
  }

  window.CyrusStore = {
    getContacts: (channel) => db.getContacts(channel),
    filterBlocked: (channel, contacts) => db.filterBlocked(channel, contacts),
    createCampaign: createCampaign,
  };
})();
