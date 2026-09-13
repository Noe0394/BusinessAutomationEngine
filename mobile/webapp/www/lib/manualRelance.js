// Moteur (sans DOM) de la Relance Manuelle Express - port 100% local de la
// logique de public/dashboard.html (relanceLoadQueue/relanceComputeMessageForItem/
// relanceBuildDeepLink/relanceLaunchCurrent, voir ce fichier pour les
// commentaires d'origine). Les deux endpoints serveur historiques
// (/api/messages/manual-queue, /api/messages/manual-import) sont remplaces
// par une lecture directe d'IndexedDB (lib/db.js) : la file "pending/failed
// de la derniere campagne" devient "contacts du canal absents de
// campaign.sent", et l'anti-doublons 48h de l'import direct devient
// db.wasSentRecently(). Le composant visuel (relance.js, a la racine de
// www/) ne fait plus que lire/appeler cet objet.
(function () {
  const db = window.Cyrus.db;
  const smartTextGenerator = window.Cyrus.smartTextGenerator;

  const RELANCE_DEDUP_WINDOW_MS = 48 * 60 * 60 * 1000;

  const state = {
    channel: 'whatsapp',
    items: [],
    cursor: 0,
    source: 'campaign', // 'campaign' | 'import'
    campaign: null, // reference a l'objet campagne (source 'campaign') pour mise a jour de sent/failed
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

  // Reprend les contacts du canal encore 'pending'/'failed' de la derniere
  // campagne connue (equivalent local de GET /api/messages/manual-queue).
  async function loadQueue(channel) {
    const [campaign, contacts] = await Promise.all([db.getLatestCampaign(channel), db.getContacts(channel)]);
    const sentSet = new Set((campaign && campaign.sent) || []);
    const failedSet = new Set((campaign && campaign.failed) || []);
    const template = (campaign && campaign.message) || '';

    // Un contact ajoute a la liste noire APRES le lancement de la campagne
    // (ex: demande d'arret suite a une plainte) ne doit plus jamais
    // reapparaitre dans une relance, meme s'il reste 'pending'/'failed' cote
    // campagne - voir db.filterBlocked.
    const unblocked = await db.filterBlocked(channel, contacts.filter(function (c) { return !sentSet.has(c.identifier); }));

    state.channel = channel;
    state.items = unblocked.map(function (c, idx) { return makeItem(channel, c, idx, failedSet.has(c.identifier) ? 'failed' : 'pending', template); });
    state.cursor = 0;
    state.source = 'campaign';
    state.campaign = campaign;
    startRhythmSession();
    return state.items;
  }

  // Import direct d'un fichier Excel/CSV, sans jamais creer/demarrer de
  // campagne automatique - meme anti-doublons 48h que POST
  // /api/messages/manual-import cote VPS, applique localement via
  // db.wasSentRecently (journal alimente par recordSent, voir lib/db.js), et
  // meme filtrage liste noire que campaign.js (voir db.filterBlocked).
  async function importContactsFile(channel, file, template) {
    const parsed = await window.Cyrus.contactsImport.parseContactsFile(file);
    const unblocked = await db.filterBlocked(channel, parsed);
    const dupFlags = await Promise.all(unblocked.map(function (c) {
      return db.wasSentRecently(channel, c.identifier, RELANCE_DEDUP_WINDOW_MS);
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

  // Calcul PUR et synchrone du message d'un contact (variantes A/B/C en
  // rotation si fournies, sinon intention via SmartTextGenerator, sinon
  // message de la campagne d'origine) - voir relanceComputeMessageForItem.
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
      // tg://resolve pre-remplit jamais le texte - voir relance.js, qui copie
      // aussi le texte dans le presse-papiers avant d'ouvrir ce lien.
      if (item.isPhone) return 'https://t.me/+' + item.phone;
      return 'https://t.me/' + item.username;
    }
    return 'https://wa.me/' + String(item.phone).replace(/^\+/, '') + '?text=' + encodedText;
  }

  // Skip local UNIQUEMENT (aucune ecriture DB) - un contact saute reapparait
  // au prochain rechargement tant qu'il reste pending/failed.
  function skipCurrent() {
    if (state.cursor >= state.items.length) return;
    state.cursor += 1;
  }

  // Trace l'envoi (journal + mise a jour de la campagne d'origine si
  // source==='campaign') et avance le curseur - equivalent local de
  // POST .../manual-queue/:index/sent et .../manual-import/sent.
  async function markCurrentSent() {
    const item = current();
    if (!item) return;

    await db.recordSent(state.channel, item.identifier, 'manual');

    if (state.source === 'campaign' && state.campaign) {
      const sent = new Set(state.campaign.sent || []);
      const failed = new Set(state.campaign.failed || []);
      sent.add(item.identifier);
      failed.delete(item.identifier);
      state.campaign.sent = Array.from(sent);
      state.campaign.failed = Array.from(failed);
      state.campaign.updatedAt = Date.now();
      await db.saveCampaign(state.campaign);
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
