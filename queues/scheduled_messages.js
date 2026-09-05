const fs = require('fs');
const path = require('path');

// Persistance simple par fichier JSON, sur le même principe que
// facebook_groups.json/facebook_token.json (adapters/facebook.js) : pas de
// base de données dans ce projet, un fichier suffit pour ce volume de
// données et reste cohérent avec le reste du code. Sur Render, ce fichier
// est effacé à chaque redéploiement sauf disque persistant monté sur ce
// chemin (même limite documentée pour les autres fichiers *_token.json).
const STORE_PATH = process.env.SCHEDULED_MESSAGES_PATH || path.join(__dirname, '..', 'scheduled_messages.json');

const STATUSES = ['pending', 'sending', 'sent', 'failed', 'cancelled'];
const MAX_ATTEMPTS = 5;

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'));
  } catch (err) {
    return [];
  }
}

function writeAll(list) {
  fs.writeFileSync(STORE_PATH, JSON.stringify(list, null, 2), 'utf8');
}

function list({ channel } = {}) {
  let all = readAll().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  if (channel) {
    all = all.filter((m) => m.channel === channel);
  }
  return all;
}

function get(id) {
  return readAll().find((m) => m.id === id) || null;
}

/**
 * "Modèle" ScheduledMessage : canal, destinataires, contenu, média,
 * planification et statut, comme décrit au cahier des charges — avec en
 * plus mediaMimetype/mediaFilename (déduits à la création, réutilisés à
 * l'envoi sans devoir re-deviner le type du média) et recipientType, qui
 * précise comment interpréter "recipients" selon le canal :
 *   - telegram/whatsapp : 'groups' (identifiants de groupes/canaux déjà
 *     résolus) ou 'contacts' (identifiants importés à résoudre à l'envoi) ;
 *   - facebook_page : toujours les identifiants d'un sous-ensemble des
 *     Groupes gérés (voir adapters/facebook.js) à qui diffuser en plus de
 *     la Page elle-même ; peut être vide (Page uniquement).
 *
 * "media" (tableau) porte une ou plusieurs pièces jointes — WhatsApp est
 * aujourd'hui le seul canal à les envoyer toutes (image + vidéo + PDF
 * combinés en une action, voir dispatchScheduledWhatsapp dans index.js) ;
 * Telegram/Facebook n'utilisent que la première. "mediaUrl"/"mediaMimetype"/
 * "mediaFilename" restent en plus, dérivés de ce premier élément, pour tout
 * appelant qui lit encore ces champs singuliers directement (rétrocompat).
 */
function create({ channel, recipientType, recipients, message, mediaUrl, mediaMimetype, mediaFilename, media, scheduledAt, keyword }) {
  const normalizedMedia = Array.isArray(media) && media.length > 0
    ? media
    : (mediaUrl ? [{ mediaUrl, mediaMimetype: mediaMimetype || null, mediaFilename: mediaFilename || null }] : []);
  const primary = normalizedMedia[0] || null;

  const entry = {
    id: `sched_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    channel,
    recipientType: recipientType || null,
    recipients: Array.isArray(recipients) ? recipients : [],
    message: message || '',
    media: normalizedMedia,
    mediaUrl: primary ? primary.mediaUrl : null,
    mediaMimetype: primary ? primary.mediaMimetype : null,
    mediaFilename: primary ? primary.mediaFilename : null,
    // Étiquette purement informative (ex : "RECETTE") pour repérer un post
    // programmé dans le tableau récapitulatif — contrairement aux mots-clés
    // du module de Capture de Prospects (models/keyword_rules.js), celle-ci
    // ne déclenche aucune action automatique : c'est un contenu sortant
    // qu'on programme, pas un texte entrant qu'on filtre.
    keyword: keyword || null,
    scheduledAt,
    status: 'pending',
    attempts: 0,
    lastError: null,
    result: null,
    createdAt: new Date().toISOString(),
    sentAt: null,
  };
  const all = readAll();
  all.push(entry);
  writeAll(all);
  return entry;
}

function update(id, patch) {
  const all = readAll();
  const idx = all.findIndex((m) => m.id === id);
  if (idx === -1) return null;
  all[idx] = { ...all[idx], ...patch };
  writeAll(all);
  return all[idx];
}

function cancel(id) {
  const entry = get(id);
  if (!entry) return null;
  if (entry.status !== 'pending') {
    throw new Error('ONLY_PENDING_CAN_BE_CANCELLED');
  }
  return update(id, { status: 'cancelled' });
}

function getDuePending(now = new Date()) {
  return readAll().filter(
    (m) => m.status === 'pending' && new Date(m.scheduledAt).getTime() <= now.getTime(),
  );
}

module.exports = { STATUSES, MAX_ATTEMPTS, list, get, create, update, cancel, getDuePending };
