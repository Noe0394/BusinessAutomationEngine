const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');
const FormData = require('form-data');
const oauthConfig = require('../oauth_config');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

function readJsonFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function writeJsonFile(filePath, data) {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

const FACEBOOK_TOKEN_PATH = process.env.FB_TOKEN_PATH || path.join(__dirname, '..', 'facebook_token.json');
const FACEBOOK_GROUPS_PATH = process.env.FB_GROUPS_PATH || path.join(__dirname, '..', 'facebook_groups.json');

/**
 * Adaptateur Facebook Messenger basé sur l'API officielle Meta Messenger
 * Platform (Graph API) pour une Page Facebook. Deux façons d'obtenir le
 * jeton de Page : le bouton "Se connecter avec Facebook" (OAuth officiel,
 * getAuthUrl/handleOAuthCallback, jeton stocké dans facebook_token.json), ou
 * FB_PAGE_ACCESS_TOKEN en variable d'environnement pour un réglage manuel.
 *
 * Contrairement à adapters/whatsapp.js (protocole WhatsApp Web non-officiel
 * via Baileys, applicable à un compte personnel), Meta n'expose aucune API
 * légitime pour lister les "groupes" ou automatiser un compte Messenger
 * personnel : seules les conversations d'une Page avec ses utilisateurs sont
 * accessibles, via l'API officielle. "getConversations" retourne donc les
 * fils de discussion de la Page, pas des groupes de discussion Messenger.
 *
 * Limite importante côté Meta : en dehors de la fenêtre de 24h suivant le
 * dernier message d'un utilisateur, l'envoi (messaging_type "RESPONSE")
 * peut être refusé par l'API sauf à utiliser un tag de message approuvé
 * (ex: CONFIRMED_EVENT_UPDATE) pour un cas d'usage validé par Meta. Cet
 * adaptateur ne contourne pas cette règle — il ne fait qu'appliquer un
 * régulateur de débit côté client pour rester sous les limites de l'API.
 */
class FacebookMessengerAdapter {
  constructor() {
    this.apiVersion = process.env.FB_GRAPH_API_VERSION || 'v19.0';
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
    this.pageId = null;
    this.pageName = null;

    if (!process.env.FB_PAGE_ACCESS_TOKEN && !readJsonFile(FACEBOOK_TOKEN_PATH)?.pageAccessToken) {
      console.warn(
        'Facebook non connecté : utilisez le bouton "Se connecter avec Facebook" dans l\'onglet Connexions ' +
        '(après avoir renseigné l\'App ID/App Secret dans le portail admin, ou via FB_APP_ID/FB_APP_SECRET).',
      );
    }
  }

  // App ID/Secret identifient l'application (ce dashboard) auprès de Meta —
  // l'équivalent du "Client ID" derrière tout bouton "Se connecter avec
  // Facebook" sur le web. Réglage unique fait une fois par l'exploitant,
  // soit via variable d'environnement, soit collé dans le portail admin
  // (oauth_config.js) — les utilisateurs de la licence ne voient jamais ça.
  getAppId() {
    // FACEBOOK_APP_ID est acceptée en alias de FB_APP_ID (nom historique
    // utilisé partout ailleurs dans ce module) pour coller au nommage du
    // cahier des charges (CLAUDE.md) sans casser les déploiements existants.
    return process.env.FB_APP_ID || process.env.FACEBOOK_APP_ID || oauthConfig.get('facebook')?.appId || null;
  }

  getAppSecret() {
    return process.env.FB_APP_SECRET || process.env.FACEBOOK_APP_SECRET || oauthConfig.get('facebook')?.appSecret || null;
  }

  isConnectAvailable() {
    return Boolean(this.getAppId() && this.getAppSecret());
  }

  getStoredToken() {
    return readJsonFile(FACEBOOK_TOKEN_PATH);
  }

  getPageAccessToken() {
    return process.env.FB_PAGE_ACCESS_TOKEN || process.env.FACEBOOK_PAGE_ACCESS_TOKEN
      || this.getStoredToken()?.pageAccessToken || null;
  }

  // Voir le commentaire dans handleOAuthCallback : les publications dans des
  // Groupes utilisent ce jeton utilisateur, jamais le jeton de Page.
  getUserAccessToken() {
    return process.env.FB_USER_ACCESS_TOKEN || this.getStoredToken()?.userAccessToken || null;
  }

  isConfigured() {
    return Boolean(this.getPageAccessToken());
  }

  async ensurePageId() {
    const stored = this.getStoredToken();
    if (stored?.pageId) {
      this.pageId = stored.pageId;
      this.pageName = stored.pageName;
      return this.pageId;
    }
    if (this.pageId) {
      return this.pageId;
    }
    const res = await axios.get(`${this.baseUrl}/me`, {
      params: { fields: 'id,name', access_token: this.getPageAccessToken() },
    });
    this.pageId = res.data.id;
    this.pageName = res.data.name;
    return this.pageId;
  }

  // Contrairement à WhatsApp/Telegram, il n'y a pas de session persistante à
  // proprement parler ici : "connecté" signifie que le jeton configuré est
  // valide et résout bien une Page (vérifié à la demande, pas mis en cache
  // au-delà de pageId/pageName).
  async checkConnection() {
    if (!this.isConfigured()) {
      return { connected: false };
    }
    try {
      await this.ensurePageId();
      return { connected: true, pageName: this.pageName };
    } catch (err) {
      this.pageId = null;
      return { connected: false };
    }
  }

  // ---------- Connexion Facebook (OAuth officiel "Se connecter avec Facebook") ----------
  getAuthUrl(redirectUri, state) {
    const params = new URLSearchParams({
      client_id: this.getAppId(),
      redirect_uri: redirectUri,
      state,
      // publish_to_groups est une permission historique, aujourd'hui restreinte par
      // Meta (App Review au cas par cas) : la demander ici est nécessaire pour que
      // publishToGroup/publishToManagedGroups fonctionnent, mais Meta peut la
      // retirer du consentement même si l'app ne l'a pas (encore) obtenue.
      scope: 'pages_show_list,pages_messaging,pages_read_engagement,pages_manage_posts,pages_manage_engagement,instagram_basic,instagram_content_publish,publish_to_groups',
      // Force Facebook à réafficher l'écran de sélection de Page à chaque
      // reconnexion (utile si l'utilisateur veut changer de Page, ex. RIEA
      // AFRIQUE), plutôt que de réutiliser silencieusement une autorisation
      // déjà accordée.
      auth_type: 'rerequest',
    });
    return `https://www.facebook.com/${this.apiVersion}/dialog/oauth?${params.toString()}`;
  }

  /**
   * Échange le code contre un jeton utilisateur, l'étend en jeton longue
   * durée, récupère la première Page gérée par l'utilisateur (et son compte
   * Instagram professionnel lié s'il existe), puis stocke tout sur disque.
   * Sélection de la première Page uniquement : pas d'interface de choix
   * multi-pages dans cette version.
   */
  async handleOAuthCallback(code, redirectUri) {
    const shortLivedRes = await axios.get(`${this.baseUrl}/oauth/access_token`, {
      params: {
        client_id: this.getAppId(),
        client_secret: this.getAppSecret(),
        redirect_uri: redirectUri,
        code,
      },
    });

    const longLivedRes = await axios.get(`${this.baseUrl}/oauth/access_token`, {
      params: {
        grant_type: 'fb_exchange_token',
        client_id: this.getAppId(),
        client_secret: this.getAppSecret(),
        fb_exchange_token: shortLivedRes.data.access_token,
      },
    });

    const pagesRes = await axios.get(`${this.baseUrl}/me/accounts`, {
      params: { access_token: longLivedRes.data.access_token },
    });

    const page = (pagesRes.data.data || [])[0];
    if (!page) {
      throw new Error('NO_PAGE_FOUND');
    }

    let igUserId = null;
    try {
      const igRes = await axios.get(`${this.baseUrl}/${page.id}`, {
        params: { fields: 'instagram_business_account', access_token: page.access_token },
      });
      igUserId = igRes.data.instagram_business_account?.id || null;
    } catch (err) {
      // Pas de compte Instagram professionnel lié à cette Page — Messenger
      // reste utilisable, seul le Studio (Instagram) restera indisponible.
    }

    writeJsonFile(FACEBOOK_TOKEN_PATH, {
      pageAccessToken: page.access_token,
      pageId: page.id,
      pageName: page.name,
      igUserId,
      // Jeton utilisateur longue durée : nécessaire pour publier dans des
      // Groupes Facebook (POST /{group-id}/feed|photos|videos), qui exigent
      // un jeton utilisateur avec la permission publish_to_groups — le jeton
      // de Page ci-dessus ne fonctionne pas pour ces endpoints.
      userAccessToken: longLivedRes.data.access_token,
      connectedAt: new Date().toISOString(),
    });

    this.pageId = page.id;
    this.pageName = page.name;
  }

  // ---------- Publication sur la Page (feed) ----------
  /**
   * Publie un statut texte, un lien, ou une photo sur la Page officielle
   * (API Graph officielle — /me/feed ou /me/photos), avec publication
   * programmée optionnelle (scheduledPublishTime, doit être 10 min à 75
   * jours dans le futur côté Meta).
   */
  async publishPost({ message, link, photoBuffer, photoMimetype, scheduledPublishTime }) {
    if (!this.isConfigured()) {
      throw new Error('FB_NOT_CONFIGURED');
    }
    await this.ensurePageId();

    const scheduledUnix = scheduledPublishTime
      ? Math.floor(new Date(scheduledPublishTime).getTime() / 1000)
      : null;

    if (photoBuffer) {
      const form = new FormData();
      form.append('caption', message || '');
      form.append('source', photoBuffer, {
        filename: 'photo.jpg',
        contentType: photoMimetype || 'image/jpeg',
      });
      form.append('access_token', this.getPageAccessToken());
      if (scheduledUnix) {
        form.append('published', 'false');
        form.append('scheduled_publish_time', String(scheduledUnix));
      }

      const res = await axios.post(`${this.baseUrl}/${this.pageId}/photos`, form, {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      return res.data;
    }

    const params = { message, access_token: this.getPageAccessToken() };
    if (link) params.link = link;
    if (scheduledUnix) {
      params.published = false;
      params.scheduled_publish_time = scheduledUnix;
    }

    const res = await axios.post(`${this.baseUrl}/${this.pageId}/feed`, null, { params });
    return res.data;
  }

  // ---------- Publication sur les Groupes Facebook gérés ----------
  /**
   * Contrairement à la Page (un identifiant unique connu via l'OAuth), il
   * n'existe aucun endpoint Graph API listant "les Groupes associés à une
   * Page" — les Groupes Facebook sont des entités indépendantes des Pages,
   * rattachées à des comptes utilisateur qui en sont membres/admin. La seule
   * façon fiable de les cibler est donc que l'exploitant renseigne
   * lui-même la liste des Groupes à administrer (ID + nom), un peu comme il
   * renseigne son App ID/App Secret. Cette liste est persistée ici, à côté
   * du jeton, plutôt que redemandée à chaque publication.
   */
  getManagedGroups() {
    const stored = readJsonFile(FACEBOOK_GROUPS_PATH);
    return Array.isArray(stored?.groups) ? stored.groups : [];
  }

  addManagedGroup(groupId, name) {
    const id = String(groupId || '').trim();
    if (!id) {
      throw new Error('GROUP_ID_REQUIRED');
    }
    const groups = this.getManagedGroups().filter((g) => g.id !== id);
    groups.push({ id, name: String(name || '').trim() || id, addedAt: new Date().toISOString() });
    writeJsonFile(FACEBOOK_GROUPS_PATH, { groups });
    return groups;
  }

  removeManagedGroup(groupId) {
    const groups = this.getManagedGroups().filter((g) => g.id !== String(groupId || '').trim());
    writeJsonFile(FACEBOOK_GROUPS_PATH, { groups });
    return groups;
  }

  /**
   * Publie dans un Groupe précis. Nécessite un jeton utilisateur (voir
   * getUserAccessToken) muni de la permission publish_to_groups, accordée
   * par Meta uniquement après App Review pour ce cas d'usage précis — et
   * l'utilisateur propriétaire du jeton doit être membre/admin du Groupe
   * ciblé. Ce n'est pas une contrainte technique de ce module : c'est une
   * restriction imposée par la plateforme Meta elle-même.
   *
   * Contrairement à Messenger (voir sendMedia), l'API Graph n'expose aucun
   * endpoint de dépôt de document (PDF) sur un Groupe : seuls texte/lien,
   * photo et vidéo sont supportés nativement. Pour un PDF, la solution est
   * d'héberger le fichier ailleurs et de partager son lien dans le message.
   */
  async publishToGroup(groupId, { message, mediaBuffer, mediaMimetype, mediaFilename } = {}) {
    const userAccessToken = this.getUserAccessToken();
    if (!userAccessToken) {
      throw new Error('FB_USER_TOKEN_MISSING');
    }
    if (!message && !mediaBuffer) {
      throw new Error('EMPTY_POST');
    }

    if (mediaMimetype === 'application/pdf') {
      throw new Error('GROUP_PDF_UPLOAD_UNSUPPORTED');
    }

    if (mediaBuffer) {
      const isVideo = (mediaMimetype || '').startsWith('video/');
      const form = new FormData();
      form.append(isVideo ? 'description' : 'caption', message || '');
      form.append('source', mediaBuffer, {
        filename: mediaFilename || (isVideo ? 'video.mp4' : 'photo.jpg'),
        contentType: mediaMimetype || (isVideo ? 'video/mp4' : 'image/jpeg'),
      });
      form.append('access_token', userAccessToken);

      const res = await axios.post(`${this.baseUrl}/${groupId}/${isVideo ? 'videos' : 'photos'}`, form, {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      });
      return res.data;
    }

    const res = await axios.post(`${this.baseUrl}/${groupId}/feed`, null, {
      params: { message, access_token: userAccessToken },
    });
    return res.data;
  }

  /**
   * Diffuse la même publication (texte + média optionnel) sur tous les
   * Groupes gérés, avec une pause aléatoire entre chaque diffusion (5 à 10s
   * par défaut, paramétrable) pour respecter les quotas de l'API Meta —
   * même régulateur de débit que sendBulk() pour Messenger.
   */
  async publishToManagedGroups({ message, mediaBuffer, mediaMimetype, mediaFilename, minDelaySeconds = 5, maxDelaySeconds = 10, onProgress } = {}) {
    const groups = this.getManagedGroups();
    if (groups.length === 0) {
      throw new Error('NO_MANAGED_GROUPS');
    }

    const results = [];
    for (let i = 0; i < groups.length; i += 1) {
      const group = groups[i];
      let status = 'failed';
      let errorReason = null;

      try {
        await this.publishToGroup(group.id, { message, mediaBuffer, mediaMimetype, mediaFilename });
        status = 'published';
      } catch (err) {
        errorReason = err?.response?.data?.error?.message || err.message;
        console.error(`Facebook: échec de la publication sur le groupe ${group.name} (${group.id}):`, errorReason);
      }

      results.push({ groupId: group.id, groupName: group.name, status, error: errorReason, timestamp: new Date().toISOString() });

      if (typeof onProgress === 'function') {
        onProgress({ sent: results.length, total: groups.length, status });
      }

      if (i < groups.length - 1) {
        await sleep(randomDelay(minDelaySeconds * 1000, maxDelaySeconds * 1000));
      }
    }

    return results;
  }

  // ---------- Gestion des commentaires (modération) ----------
  async getPostComments(postId, { limit = 50 } = {}) {
    if (!this.isConfigured()) {
      throw new Error('FB_NOT_CONFIGURED');
    }
    const res = await axios.get(`${this.baseUrl}/${postId}/comments`, {
      params: {
        fields: 'id,message,from,created_time,like_count,is_hidden',
        limit,
        access_token: this.getPageAccessToken(),
      },
    });
    return res.data.data || [];
  }

  async replyToComment(commentId, message) {
    if (!this.isConfigured()) {
      throw new Error('FB_NOT_CONFIGURED');
    }
    const res = await axios.post(`${this.baseUrl}/${commentId}/comments`, null, {
      params: { message, access_token: this.getPageAccessToken() },
    });
    return res.data;
  }

  // is_hidden=true masque le commentaire (réversible) sans le supprimer —
  // préférable à deleteComment() pour la modération courante.
  async moderateComment(commentId, { hide }) {
    if (!this.isConfigured()) {
      throw new Error('FB_NOT_CONFIGURED');
    }
    const res = await axios.post(`${this.baseUrl}/${commentId}`, null, {
      params: { is_hidden: Boolean(hide), access_token: this.getPageAccessToken() },
    });
    return res.data;
  }

  async deleteComment(commentId) {
    if (!this.isConfigured()) {
      throw new Error('FB_NOT_CONFIGURED');
    }
    const res = await axios.delete(`${this.baseUrl}/${commentId}`, {
      params: { access_token: this.getPageAccessToken() },
    });
    return res.data;
  }

  // ---------- Webhooks (validation + intégrité des évènements reçus) ----------
  // Meta signe chaque notification webhook avec HMAC-SHA256 sur le corps brut
  // de la requête, via l'App Secret. À vérifier avant de faire confiance à
  // tout payload reçu sur POST /api/facebook/webhook (voir index.js).
  verifyWebhookSignature(rawBody, signatureHeader) {
    const appSecret = this.getAppSecret();
    if (!appSecret || !signatureHeader || !rawBody) {
      return false;
    }
    const expected = `sha256=${crypto.createHmac('sha256', appSecret).update(rawBody).digest('hex')}`;
    const expectedBuf = Buffer.from(expected);
    const receivedBuf = Buffer.from(signatureHeader);
    if (expectedBuf.length !== receivedBuf.length) {
      return false;
    }
    return crypto.timingSafeEqual(expectedBuf, receivedBuf);
  }

  /**
   * Fait correspondre une liste de contacts importés (CSV/Excel : colonnes
   * psid et/ou nom) aux conversations Messenger déjà existantes sur la Page.
   * L'API Graph n'expose aucun moyen d'envoyer un premier message à un
   * inconnu à partir d'un simple email/téléphone importé : seuls les PSID
   * (Page-Scoped ID) d'utilisateurs ayant déjà engagé la conversation avec la
   * Page sont des destinataires valides pour /me/messages (cf. règle des 24h
   * documentée plus haut). Cette fonction ne contourne pas cette règle, elle
   * se contente d'identifier, parmi les contacts importés, ceux qui sont
   * effectivement joignables.
   */
  async resolveRecipientsFromConversations(importedContacts) {
    const conversations = await this.getConversations();
    const byId = new Map(conversations.map((c) => [String(c.recipientId), c.recipientId]));
    const byName = new Map(
      conversations
        .filter((c) => c.name)
        .map((c) => [c.name.trim().toLowerCase(), c.recipientId]),
    );

    return importedContacts.map((contact) => {
      const providedId = contact.psid || contact.recipientId || contact.id;
      if (providedId && byId.has(String(providedId))) {
        return { ...contact, recipientId: String(providedId), matched: true };
      }

      const key = String(contact.name || '').trim().toLowerCase();
      const matchedId = key ? byName.get(key) : null;
      return { ...contact, recipientId: matchedId || null, matched: Boolean(matchedId) };
    });
  }

  async getConversations() {
    if (!this.isConfigured()) {
      throw new Error('FB_NOT_CONFIGURED');
    }

    await this.ensurePageId();

    const res = await axios.get(`${this.baseUrl}/me/conversations`, {
      params: {
        fields: 'id,snippet,updated_time,participants',
        access_token: this.getPageAccessToken(),
      },
    });

    const conversations = res.data.data || [];

    return conversations.map((c) => {
      const participants = (c.participants && c.participants.data) || [];
      const other = participants.find((p) => p.id !== this.pageId) || participants[0] || null;

      return {
        id: c.id,
        name: (other && other.name) || c.snippet || c.id,
        recipientId: other ? other.id : null,
        snippet: c.snippet || '',
        updatedTime: c.updated_time || null,
      };
    });
  }

  async sendMessage(recipientId, text) {
    if (!this.isConfigured()) {
      throw new Error('FB_NOT_CONFIGURED');
    }

    const res = await axios.post(
      `${this.baseUrl}/me/messages`,
      {
        recipient: { id: recipientId },
        message: { text },
        messaging_type: 'RESPONSE',
      },
      { params: { access_token: this.getPageAccessToken() } },
    );

    return res.data;
  }

  async sendMedia(recipientId, { buffer, mimetype, filename }) {
    if (!this.isConfigured()) {
      throw new Error('FB_NOT_CONFIGURED');
    }

    const type = mimetype && mimetype.startsWith('video/')
      ? 'video'
      : mimetype === 'application/pdf'
        ? 'file'
        : 'image';

    const form = new FormData();
    form.append('recipient', JSON.stringify({ id: recipientId }));
    form.append('message', JSON.stringify({ attachment: { type, payload: { is_reusable: false } } }));
    form.append('messaging_type', 'RESPONSE');
    form.append('filedata', buffer, {
      filename: filename || 'fichier',
      contentType: mimetype || 'application/octet-stream',
    });

    const res = await axios.post(`${this.baseUrl}/me/messages`, form, {
      params: { access_token: this.getPageAccessToken() },
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    return res.data;
  }

  /**
   * Envoi en masse avec régulateur de débit : délai (fixe ou 10-15s
   * aléatoire par défaut) entre chaque envoi, et pause de sécurité triplée
   * toutes les `batchSize` messages pour ne pas saturer l'API.
   */
  async sendBulk(recipientIds, message, options = {}) {
    const { delaySeconds, minDelaySeconds, maxDelaySeconds, batchSize, media, onProgress } = options;
    const batch = Number.isInteger(batchSize) && batchSize > 0 ? batchSize : recipientIds.length;
    const results = [];

    for (let i = 0; i < recipientIds.length; i += 1) {
      const recipientId = recipientIds[i];
      let status = 'failed';

      try {
        if (media) {
          await this.sendMedia(recipientId, media);
          if (message) {
            await this.sendMessage(recipientId, message);
          }
        } else {
          await this.sendMessage(recipientId, message);
        }
        status = 'delivered';
      } catch (err) {
        console.error(`Facebook Messenger: échec de l'envoi à ${recipientId}:`, err?.response?.data || err.message);
      }

      results.push({ to: recipientId, status, timestamp: new Date().toISOString() });

      if (typeof onProgress === 'function') {
        onProgress({ sent: results.length, total: recipientIds.length, status });
      }

      if (i < recipientIds.length - 1) {
        const baseDelayMs = delaySeconds
          ? delaySeconds * 1000
          : (minDelaySeconds && maxDelaySeconds)
            ? randomDelay(minDelaySeconds * 1000, maxDelaySeconds * 1000)
            : randomDelay(10000, 15000);
        const endOfBatch = (i + 1) % batch === 0;
        const delayMs = endOfBatch ? baseDelayMs * 3 : baseDelayMs;
        await sleep(delayMs);
      }
    }

    return results;
  }
}

module.exports = FacebookMessengerAdapter;
