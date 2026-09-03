const axios = require('axios');
const FormData = require('form-data');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelay(minMs, maxMs) {
  return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/**
 * Adaptateur Facebook Messenger basé sur l'API officielle Meta Messenger
 * Platform (Graph API) pour une Page Facebook — via FB_PAGE_ACCESS_TOKEN.
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
    this.pageAccessToken = process.env.FB_PAGE_ACCESS_TOKEN || null;
    this.apiVersion = process.env.FB_GRAPH_API_VERSION || 'v19.0';
    this.baseUrl = `https://graph.facebook.com/${this.apiVersion}`;
    this.pageId = null;

    if (!this.pageAccessToken) {
      console.warn(
        'FB_PAGE_ACCESS_TOKEN non défini : le module Facebook Messenger est inactif ' +
        '(GET /api/facebook/groups et POST /api/facebook/queue renverront une erreur 503).',
      );
    }
  }

  isConfigured() {
    return Boolean(this.pageAccessToken);
  }

  async ensurePageId() {
    if (this.pageId) {
      return this.pageId;
    }
    const res = await axios.get(`${this.baseUrl}/me`, {
      params: { fields: 'id,name', access_token: this.pageAccessToken },
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

  async getConversations() {
    if (!this.isConfigured()) {
      throw new Error('FB_NOT_CONFIGURED');
    }

    await this.ensurePageId();

    const res = await axios.get(`${this.baseUrl}/me/conversations`, {
      params: {
        fields: 'id,snippet,updated_time,participants',
        access_token: this.pageAccessToken,
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
      { params: { access_token: this.pageAccessToken } },
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
      params: { access_token: this.pageAccessToken },
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
    const { delaySeconds, batchSize, media, onProgress } = options;
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
        const baseDelayMs = delaySeconds ? delaySeconds * 1000 : randomDelay(10000, 15000);
        const endOfBatch = (i + 1) % batch === 0;
        const delayMs = endOfBatch ? baseDelayMs * 3 : baseDelayMs;
        await sleep(delayMs);
      }
    }

    return results;
  }
}

module.exports = FacebookMessengerAdapter;
