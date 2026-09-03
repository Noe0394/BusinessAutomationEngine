const crypto = require('crypto');
const { Readable } = require('stream');
const axios = require('axios');
const { google } = require('googleapis');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Adaptateur unifié de publication vidéo (YouTube Shorts, Instagram Reels,
 * TikTok), basé exclusivement sur les API officielles de chaque plateforme —
 * aucune automatisation non-officielle ici, contrairement à WhatsApp/Telegram.
 *
 * Chaque plateforme attend une autorisation obtenue au préalable "à la main"
 * (flux OAuth de consentement) : ce module ne fait PAS ce flux interactif,
 * il consomme des jetons déjà émis, fournis via variables d'environnement :
 *   - YouTube  : GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, YOUTUBE_REFRESH_TOKEN
 *                (obtenus via Google Cloud Console + consentement OAuth une
 *                fois, scope https://www.googleapis.com/auth/youtube.upload)
 *   - Instagram: IG_ACCESS_TOKEN (jeton Page/Utilisateur avec la permission
 *                instagram_content_publish), IG_USER_ID (Instagram Business
 *                Account ID)
 *   - TikTok   : TIKTOK_ACCESS_TOKEN (obtenu via TikTok Login Kit, scope
 *                video.publish) — tant que l'app TikTok n'est pas auditée par
 *                TikTok, l'API Content Posting force les publications en
 *                privé ("SELF_ONLY"), visibles uniquement par le compte
 *                développeur connecté.
 *
 * Instagram exige que la vidéo soit accessible via une URL PUBLIQUE (Meta la
 * télécharge lui-même) : registerTempVideo()/getTempVideo() gèrent un
 * stockage temporaire en mémoire, exposé par une route HTTP publique dans
 * index.js (GET /api/media/temp/:token), qui nécessite PUBLIC_BASE_URL
 * (l'URL HTTPS publique de ce serveur, ex: https://mon-app.onrender.com).
 */
class MediaPublisherAdapter {
  constructor() {
    this.googleClientId = process.env.GOOGLE_CLIENT_ID || null;
    this.googleClientSecret = process.env.GOOGLE_CLIENT_SECRET || null;
    this.youtubeRefreshToken = process.env.YOUTUBE_REFRESH_TOKEN || null;

    this.igAccessToken = process.env.IG_ACCESS_TOKEN || null;
    this.igUserId = process.env.IG_USER_ID || null;

    this.tiktokAccessToken = process.env.TIKTOK_ACCESS_TOKEN || null;

    this.publicBaseUrl = process.env.PUBLIC_BASE_URL || null;

    this.tempVideos = new Map();

    if (!this.isYoutubeConfigured()) {
      console.warn('YouTube non configuré (GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET/YOUTUBE_REFRESH_TOKEN manquants).');
    }
    if (!this.isInstagramConfigured()) {
      console.warn('Instagram non configuré (IG_ACCESS_TOKEN/IG_USER_ID manquants).');
    }
    if (!this.isTikTokConfigured()) {
      console.warn('TikTok non configuré (TIKTOK_ACCESS_TOKEN manquant).');
    }
    if (!this.publicBaseUrl) {
      console.warn(
        'PUBLIC_BASE_URL non défini : la publication Instagram (qui exige une URL vidéo publique) échouera. ' +
        'Définissez-la avec l\'URL HTTPS publique de ce serveur (ex: https://mon-app.onrender.com).',
      );
    }
  }

  isYoutubeConfigured() {
    return Boolean(this.googleClientId && this.googleClientSecret && this.youtubeRefreshToken);
  }

  isInstagramConfigured() {
    return Boolean(this.igAccessToken && this.igUserId);
  }

  isTikTokConfigured() {
    return Boolean(this.tiktokAccessToken);
  }

  // ---------- Stockage temporaire public (nécessaire pour Instagram) ----------
  registerTempVideo(buffer, mimetype) {
    this.purgeExpiredTempVideos();
    const token = crypto.randomBytes(16).toString('hex');
    this.tempVideos.set(token, { buffer, mimetype, expiresAt: Date.now() + 30 * 60 * 1000 });
    return token;
  }

  getTempVideo(token) {
    const entry = this.tempVideos.get(token);
    if (!entry) return null;
    if (entry.expiresAt < Date.now()) {
      this.tempVideos.delete(token);
      return null;
    }
    return entry;
  }

  purgeExpiredTempVideos() {
    const now = Date.now();
    for (const [token, entry] of this.tempVideos.entries()) {
      if (entry.expiresAt < now) {
        this.tempVideos.delete(token);
      }
    }
  }

  getPublicVideoUrl(token) {
    if (!this.publicBaseUrl) {
      throw new Error('PUBLIC_BASE_URL_NOT_CONFIGURED');
    }
    return `${this.publicBaseUrl.replace(/\/$/, '')}/api/media/temp/${token}`;
  }

  // ---------- YouTube Shorts ----------
  async publishYouTubeShort({ buffer, title, description, scheduleAt }, onStatus) {
    if (!this.isYoutubeConfigured()) {
      throw new Error('YOUTUBE_NOT_CONFIGURED');
    }

    onStatus('Authentification Google...');
    const oauth2Client = new google.auth.OAuth2(this.googleClientId, this.googleClientSecret);
    oauth2Client.setCredentials({ refresh_token: this.youtubeRefreshToken });
    const youtube = google.youtube({ version: 'v3', auth: oauth2Client });

    // Astuce reconnue par YouTube pour favoriser le classement "Shorts" :
    // le hashtag #Shorts dans le titre/la description, en plus du format
    // vidéo (9:16, < 60s) qui reste de la responsabilité de l'appelant —
    // ce module ne vérifie pas la durée/le ratio (pas de ffmpeg embarqué).
    const finalDescription = /#shorts/i.test(description || '')
      ? description
      : `${description || ''}\n#Shorts`.trim();

    const status = { selfDeclaredMadeForKids: false };
    if (scheduleAt) {
      status.privacyStatus = 'private';
      status.publishAt = new Date(scheduleAt).toISOString();
    } else {
      status.privacyStatus = 'public';
    }

    onStatus('Envoi de la vidéo à YouTube...');
    const res = await youtube.videos.insert({
      part: 'snippet,status',
      requestBody: {
        snippet: { title, description: finalDescription },
        status,
      },
      media: {
        mimeType: 'video/mp4',
        body: Readable.from(buffer),
      },
    });

    onStatus(scheduleAt ? 'Short programmé sur YouTube.' : 'Short publié sur YouTube !');
    return { videoId: res.data.id, url: `https://youtube.com/shorts/${res.data.id}` };
  }

  // ---------- Instagram Reels (flux en 3 étapes) ----------
  async publishInstagramReel({ token, caption, scheduleAt }, onStatus) {
    if (!this.isInstagramConfigured()) {
      throw new Error('INSTAGRAM_NOT_CONFIGURED');
    }

    if (scheduleAt) {
      const delayMs = new Date(scheduleAt).getTime() - Date.now();
      if (delayMs > 0) {
        onStatus('En attente de la date programmée...');
        await sleep(delayMs);
      }
    }

    const videoUrl = this.getPublicVideoUrl(token);
    const base = 'https://graph.facebook.com/v19.0';

    onStatus('Création du conteneur média (Container)...');
    const createRes = await axios.post(`${base}/${this.igUserId}/media`, null, {
      params: {
        media_type: 'REELS',
        video_url: videoUrl,
        caption,
        access_token: this.igAccessToken,
      },
    });
    const creationId = createRes.data.id;

    onStatus('Rendu en cours (Container OK)...');
    let statusCode = 'IN_PROGRESS';
    let attempts = 0;

    while (statusCode === 'IN_PROGRESS' && attempts < 36) {
      await sleep(5000);
      attempts += 1;
      const statusRes = await axios.get(`${base}/${creationId}`, {
        params: { fields: 'status_code', access_token: this.igAccessToken },
      });
      statusCode = statusRes.data.status_code;
      onStatus(`Rendu en cours (${statusCode})...`);
    }

    if (statusCode !== 'FINISHED') {
      throw new Error(`INSTAGRAM_RENDER_FAILED_${statusCode}`);
    }

    onStatus('Publication du Reel...');
    const publishRes = await axios.post(`${base}/${this.igUserId}/media_publish`, null, {
      params: { creation_id: creationId, access_token: this.igAccessToken },
    });

    onStatus('Reel publié sur Instagram !');
    return { mediaId: publishRes.data.id };
  }

  // ---------- TikTok Content Posting API ----------
  async publishTikTokVideo({ buffer, title, scheduleAt }, onStatus) {
    if (!this.isTikTokConfigured()) {
      throw new Error('TIKTOK_NOT_CONFIGURED');
    }

    if (scheduleAt) {
      const delayMs = new Date(scheduleAt).getTime() - Date.now();
      if (delayMs > 0) {
        onStatus('En attente de la date programmée...');
        await sleep(delayMs);
      }
    }

    const base = 'https://open.tiktokapis.com';
    const headers = {
      Authorization: `Bearer ${this.tiktokAccessToken}`,
      'Content-Type': 'application/json',
    };

    onStatus('Initialisation du transfert TikTok...');
    const initRes = await axios.post(`${base}/v2/post/publish/video/init/`, {
      post_info: {
        title,
        privacy_level: 'SELF_ONLY',
        disable_duet: false,
        disable_comment: false,
        disable_stitch: false,
      },
      source_info: {
        source: 'FILE_UPLOAD',
        video_size: buffer.length,
        chunk_size: buffer.length,
        total_chunk_count: 1,
      },
    }, { headers });

    const { publish_id: publishId, upload_url: uploadUrl } = initRes.data.data;

    onStatus('Transfert de la vidéo en cours...');
    await axios.put(uploadUrl, buffer, {
      headers: {
        'Content-Type': 'video/mp4',
        'Content-Range': `bytes 0-${buffer.length - 1}/${buffer.length}`,
      },
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });

    onStatus('Transféré ! Vérification du statut de publication...');
    let publishStatus = 'PROCESSING_UPLOAD';
    let attempts = 0;

    while ((publishStatus === 'PROCESSING_UPLOAD' || publishStatus === 'PROCESSING_DOWNLOAD') && attempts < 36) {
      await sleep(5000);
      attempts += 1;
      const statusRes = await axios.post(`${base}/v2/post/publish/status/fetch/`, {
        publish_id: publishId,
      }, { headers });
      publishStatus = statusRes.data.data.status;
      onStatus(`Statut TikTok : ${publishStatus}...`);
    }

    if (publishStatus !== 'PUBLISH_COMPLETE') {
      throw new Error(`TIKTOK_PUBLISH_FAILED_${publishStatus}`);
    }

    onStatus('Vidéo transférée et publiée sur TikTok !');
    return { publishId };
  }
}

module.exports = MediaPublisherAdapter;
