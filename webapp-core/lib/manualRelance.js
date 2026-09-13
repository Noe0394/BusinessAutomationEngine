// Moteur (sans DOM) de la Relance Manuelle Express — version CONTRAT
// (webapp-core, mode navigateur). Port de mobile/webapp/www/lib/manualRelance.js
// adapté au format canonique de campagne du contrat window.CyrusStore
// (recipients:[{to,name,status}] avec status ∈ pending|sent|failed) au lieu du
// format mobile brut (campaign.sent / campaign.failed).
//
// Différence structurante : AUCUN accès direct à window.Cyrus.db — tout passe
// par window.CyrusStore (voir adapters/CONTRACT.md). Le même moteur peut donc
// tourner sur n'importe quel adaptateur (navigateur aujourd'hui, mobile/desktop
// demain) sans réécriture.
//
// Le composant visuel (relance-core.js) ne fait que lire/appeler cet objet.
(function () {
  const store = window.CyrusStore;
  const smartTextGenerator = window.Cyrus.smartTextGenerator;

  const RELANCE_DEDUP_WINDOW_MS = 48 * 60 * 60 * 1000;

  const state = {
    channel: 'whatsapp',
    items: [],
    cursor: 0,
    source: 'campaign', // 'campaign' | 'import'
    campaign: null, // référence à la campagne d'origine (source 'campaign')
    sessionStartAt: null,
    sentCount: 0,
  };

  function isPhoneIdentifier(channel, identifier) {
    return channel === 'whatsapp' ? true : /^\d+$/.test(identifier);
  }

  function makeItem(channel, contact, index, status, message) {
    const isPhone = isPhoneIdentifier(channel, contact.identifier);
    return {
      index: index,
      identifier: contact.identifier,
      name: contact.name || '',
      isPhone: isPhone,
      phone: isPhone ? contact.identifier : null,
      username: isPhone ? null : contact.identifier.replace(/^@/, ''),
      status: status,
      message: message || '',
      renderedMessage: null,
    };
  }

  // Reprend les destinataires du canal encore 'pending'/'failed' de la dernière
  // campagne connue (équivalent local de GET /api/messages/manual-queue).
  async function loadQueue(channel) {
    const campaign = await store.getLatestCampaign(channel);
    const recipients = (campaign && campaign.recipients) || [];
    const template = (campaign && campaign.text) || '';

    // Un destinataire encore 'pending'/'failed' n'a pas (encore) été envoyé.
    const remaining = recipients.filter(function (r) { return r.status !== 'sent'; });
    const asContacts = remaining.map(function (r) {
      return { identifier: r.to, name: r.name || '', status: r.status };
    });

    // Un contact ajouté à la liste noire APRÈS le lancement de la campagne ne
    // doit plus jamais réapparaître dans une relance — voir store.filterBlocked.
    const unblocked = await store.filterBlocked(channel, asContacts);

    state.channel = channel;
    state.items = unblocked.map(function (c, idx) {
      return makeItem(channel, c, idx, c.status === 'failed' ? 'failed' : 'pending', template);
    });
    state.cursor = 0;
    state.source = 'campaign';
    state.campaign = campaign;
    startRhythmSession();
    return state.items;
  }

  // Import direct d'un fichier Excel/CSV, sans jamais créer/démarrer de campagne
  // automatique — même anti-doublons 48h que POST /api/messages/manual-import
  // côté VPS, appliqué localement via store.wasSentRecently (journal alimenté
  // par recordSent), et même filtrage liste noire que campaigns-core.js.
  async function importContactsFile(channel, file, template) {
    const parsed = await window.Cyrus.contactsImport.parseContactsFile(file);
    const unblocked = await store.filterBlocked(channel, parsed);
    const dupFlags = await Promise.all(unblocked.map(function (c) {
      return store.wasSentRecently(channel, c.identifier, RELANCE_DEDUP_WINDOW_MS);
    }));
    const kept = unblocked.filter(function (c, i) { return !dupFlags[i]; });
    const skippedDuplicates = parsed.length - kept.length;

    state.channel = channel;
    state.items = kept.map(function (c, idx) { return makeItem(channel, c, idx, 'pending', template); });
    state.cursor = 0;
    state.source = 'import';
    state.campaign = null;
    startRhythmSession();
    return { items: state.items, skippedDuplicates: skippedDuplicates };
  }

  // Calcul PUR et synchrone du message d'un contact (variantes A/B/C en rotation
  // si fournies, sinon intention via SmartTextGenerator, sinon message de la
  // campagne d'origine).
  function computeMessageForItem(item, index, opts) {
    const variants = (opts && opts.variants) || [];
    const intention = (opts && opts.intention) || '';
    if (variants.length) return variants[index % variants.length];
    if (intention) return smartTextGenerator.generateVariant(intention, 'private', item.name);
    return item.message || '';
  }

  function prerenderAll(opts) {
    state.items.forEach(function (item, index) {
      item.renderedMessage = computeMessageForItem(item, index, opts);
    });
  }

  function current() {
    return state.cursor < state.items.length ? state.items[state.cursor] : null;
  }

  function buildDeepLink(item, text) {
    const encodedText = encodeURIComponent(text || '');
    if (state.channel === 'telegram') {
      // Telegram ne pré-remplit jamais le texte : relance-core.js copie donc
      // aussi le message dans le presse-papiers avant d'ouvrir ce lien.
      if (item.isPhone) return 'https://t.me/+' + item.phone;
      return 'https://t.me/' + item.username;
    }
    return 'https://wa.me/' + String(item.phone).replace(/^\+/, '') + '?text=' + encodedText;
  }

  // Skip local UNIQUEMENT (aucune écriture) — un contact sauté réapparaît au
  // prochain rechargement tant qu'il reste pending/failed.
  function skipCurrent() {
    if (state.cursor >= state.items.length) return;
    state.cursor += 1;
  }

  // Trace l'envoi (journal + mise à jour de la campagne d'origine si
  // source==='campaign') et avance le curseur.
  async function markCurrentSent() {
    const item = current();
    if (!item) return;

    await store.recordSent(state.channel, item.identifier, 'manual');

    if (state.source === 'campaign' && state.campaign) {
      await store.markManualSent(state.channel, state.campaign.id, item.identifier);
    }

    state.sentCount += 1;
    state.cursor += 1;
  }

  function startRhythmSession() {
    state.sessionStartAt = state.items.length > 0 ? Date.now() : null;
    state.sentCount = 0;
  }

  window.Cyrus = window.Cyrus || {};
  window.Cyrus.manualRelance = {
    state: state,
    loadQueue: loadQueue,
    importContactsFile: importContactsFile,
    computeMessageForItem: computeMessageForItem,
    prerenderAll: prerenderAll,
    current: current,
    buildDeepLink: buildDeepLink,
    skipCurrent: skipCurrent,
    markCurrentSent: markCurrentSent,
  };
})();
