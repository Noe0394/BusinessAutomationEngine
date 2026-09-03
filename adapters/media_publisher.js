const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Readable } = require('stream');
const axios = require('axios');
const { google } = require('googleapis');
const oauthConfig = require('../oauth_config');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

const YOUTUBE_TOKEN_PATH = process.env.YOUTUBE_TOKEN_PATH || path.join(__dirname, '..', 'youtube_token.json');
const TIKTOK_TOKEN_PATH = process.env.TIKTOK_TOKEN_PATH || path.join(__dirname, '..', 'tiktok_token.json');
// Même fichier que celui utilisé par adapters/facebook.js : la connexion
// Facebook (OAuth) déverrouille aussi Instagram Reels, car les deux passent
// par le même jeton de Page issue de "Se connecter avec Facebook".
const FACEBOOK_TOKEN_PATH = process.env.FB_TOKEN_PATH || path.join(__dirname, '..', 'facebook_token.json');

/**
 * Adaptateur unifié de publication vidéo (YouTube Shorts, Instagram Reels,
 * TikTok), basé exclusivement sur les API officielles de chaque plateforme —
 * aucune automatisation non-officielle ici, contrairement à WhatsApp/Telegram.
 *
 * Deux façons d'obtenir les identifiants d'application (Client ID/Secret) :
 * en variable d'environnement (GOOGLE_CLIENT_ID/SECRET, TIKTOK_CLIENT_KEY/
 * SECRET), ou collés une fois dans le portail admin (voir oauth_config.js) —
 * dans les deux cas c'est un réglage unique fait par l'exploitant, jamais vu
 * par les utilisateurs de la licence, qui cliquent juste sur "Se connecter"
 * (getYoutubeAuthUrl/handleYoutubeCallback, getTiktokAuthUrl/
 * handleTiktokCallback) et valident sur l'écran officiel du fournisseur.
 * Les jetons obtenus sont stockés dans youtube_token.json/tiktok_token.json.
 * Instagram réutilise directement la connexion Facebook (facebook_token.json)
 * — pas de connexion séparée.
 *
 * Instagram exige que la vidéo soit accessible via une URL PUBLIQUE (Meta la
 * télécharge lui-même) : registerTempVideo()/getTempVideo() gèrent un
 * stockage temporaire en mémoire, exposé par une route HTTP publique dans
 * index.js (GET /api/media/temp/:token), qui nécessite PUBLIC_BASE_URL
 * (l'URL HTTPS publique de ce serveur, ex: https://mon-app.onrender.com).
 */
class MediaPublisherAdapter {
  constructor() {
    // Même valeur de repli que PUBLIC_BASE_URL dans index.js (pas un secret,
    // juste l'URL publique du déploiement) — sans ça, ce module ignorait le
    // repli défini côté index.js et bloquait à tort isYoutubeConnectAvailable/
    // isTikTokConnectAvailable même quand les identifiants étaient présents.
    this.publicBaseUrl = process.env.PUBLIC_BASE_URL || 'https://business-automation-engine.onrender.com';
    this.tempVideos = new Map();

    if (!this.getGoogleClientId() || !this.getGoogleClientSecret()) {
      console.warn(
        'Google non configuré : le bouton "Se connecter avec Google" pour YouTube restera inactif tant que ' +
        'GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET ne sont pas renseignés (variable d\'environnement, ou collés dans ' +
        'le portail admin — réglage unique fait par l\'exploitant, jamais vu par les utilisateurs de la licence).',
      );
    }
    if (!this.getTiktokClientKey() || !this.getTiktokClientSecret()) {
      console.warn(
        'TikTok non configuré : le bouton "Se connecter avec TikTok" restera inactif tant que ' +
        'TIKTOK_CLIENT_KEY/TIKTOK_CLIENT_SECRET ne sont pas renseignés (variable d\'environnement, ou collés ' +
        'dans le portail admin).',
      );
    }
    if (!this.publicBaseUrl) {
      console.warn(
        'PUBLIC_BASE_URL non défini : les flux de connexion OAuth (Google, TikTok) et la publication Instagram ' +
        '(URL vidéo publique) échoueront. Définissez-la avec l\'URL HTTPS publique de ce serveur.',
      );
    }
  }

  // Identifiants d'application (pas un utilisateur) — l'équivalent du
  // "Client ID" derrière tout bouton "Se connecter avec Google/TikTok" sur le
  // web. Réglage unique fait par l'exploitant, soit en variable
  // d'environnement, soit collé dans le portail admin (oauth_config.js) — les
  // utilisateurs de la licence ne voient jamais ça, ils cliquent juste sur
  // "Se connecter" et valident sur l'écran officiel du fournisseur.
  getGoogleClientId() {
    return process.env.GOOGLE_CLIENT_ID || oauthConfig.get('google')?.clientId || null;
  }

  getGoogleClientSecret() {
    return process.env.GOOGLE_CLIENT_SECRET || oauthConfig.get('google')?.clientSecret || null;
  }

  getTiktokClientKey() {
    return process.env.TIKTOK_CLIENT_KEY || oauthConfig.get('tiktok')?.clientKey || null;
  }

  getTiktokClientSecret() {
    return process.env.TIKTOK_CLIENT_SECRET || oauthConfig.get('tiktok')?.clientSecret || null;
  }

  isYoutubeConfigured() {
    return Boolean(process.env.YOUTUBE_REFRESH_TOKEN || readJsonFile(YOUTUBE_TOKEN_PATH)?.refresh_token);
  }

  isInstagramConfigured() {
    if (process.env.IG_ACCESS_TOKEN && process.env.IG_USER_ID) return true;
    const stored = readJsonFile(FACEBOOK_TOKEN_PATH);
    return Boolean(stored?.pageAccessToken && stored?.igUserId);
  }

  isTikTokConfigured() {
    return Boolean(process.env.TIKTOK_ACCESS_TOKEN || readJsonFile(TIKTOK_TOKEN_PATH)?.access_token);
  }

  getYoutubeRefreshToken() {
    return process.env.YOUTUBE_REFRESH_TOKEN || readJsonFile(YOUTUBE_TOKEN_PATH)?.refresh_token || null;
  }

  getInstagramCredentials() {
    if (process.env.IG_ACCESS_TOKEN && process.env.IG_USER_ID) {
      return { accessToken: process.env.IG_ACCESS_TOKEN, userId: process.env.IG_USER_ID };
    }
    const stored = readJsonFile(FACEBOOK_TOKEN_PATH);
    if (stored?.pageAccessToken && stored?.igUserId) {
      return { accessToken: stored.pageAccessToken, userId: stored.igUserId };
    }
    return null;
  }

  getTikTokAccessToken() {
    if (process.env.TIKTOK_ACCESS_TOKEN) return process.env.TIKTOK_ACCESS_TOKEN;
    return readJsonFile(TIKTOK_TOKEN_PATH)?.access_token || null;
  }

  // ---------- Connexion Google/YouTube (OAuth officiel, bouton "Se connecter") ----------
  isYoutubeConnectAvailable() {
    return Boolean(this.getGoogleClientId() && this.getGoogleClientSecret() && this.publicBaseUrl);
  }

  buildGoogleOAuthClient(redirectUri) {
    return new google.auth.OAuth2(this.getGoogleClientId(), this.getGoogleClientSecret(), redirectUri);
  }

  getYoutubeAuthUrl(redirectUri, state) {
    const client = this.buildGoogleOAuthClient(redirectUri);
    return client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: ['https://www.googleapis.com/auth/youtube.upload'],
      state,
    });
  }

  async handleYoutubeCallback(code, redirectUri) {
    const client = this.buildGoogleOAuthClient(redirectUri);
    const { tokens } = await client.getToken(code);
    if (!tokens.refresh_token) {
      // Google ne renvoie un refresh_token que sur le tout premier
      // consentement (ou si prompt=consent, déjà forcé ci-dessus) ; sans lui
      // on ne peut pas publier hors ligne plus tard.
      throw new Error('NO_REFRESH_TOKEN_RETURNED');
    }
    writeJsonFile(YOUTUBE_TOKEN_PATH, { refresh_token: tokens.refresh_token, connectedAt: new Date().toISOString() });
  }

  // ---------- Connexion TikTok (OAuth officiel Login Kit) ----------
  isTikTokConnectAvailable() {
    return Boolean(this.getTiktokClientKey() && this.getTiktokClientSecret() && this.publicBaseUrl);
  }

  getTiktokAuthUrl(redirectUri, state) {
    const params = new URLSearchParams({
      client_key: this.getTiktokClientKey(),
      scope: 'video.publish',
      response_type: 'code',
      redirect_uri: redirectUri,
      state,
    });
    return `https://www.tiktok.com/v2/auth/authorize/?${params.toString()}`;
  }

  async handleTiktokCallback(code, redirectUri) {
    const body = new URLSearchParams({
      client_key: this.getTiktokClientKey(),
      client_secret: this.getTiktokClientSecret(),
      code,
      grant_type: 'authorization_code',
      redirect_uri: redirectUri,
    });

    const res = await axios.post('https://open.tiktokapis.com/v2/oauth/token/', body.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    const { access_token: accessToken, refresh_token: refreshToken, expires_in: expiresIn } = res.data;
    writeJsonFile(TIKTOK_TOKEN_PATH, {
      access_token: accessToken,
      refresh_token: refreshToken,
      expiresAt: Date.now() + (expiresIn || 0) * 1000,
      connectedAt: new Date().toISOString(),
    });
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
    const oauth2Client = new google.auth.OAuth2(this.getGoogleClientId(), this.getGoogleClientSecret());
    oauth2Client.setCredentials({ refresh_token: this.getYoutubeRefreshToken() });
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

    const { accessToken: igAccessToken, userId: igUserId } = this.getInstagramCredentials();
    const videoUrl = this.getPublicVideoUrl(token);
    const base = 'https://graph.facebook.com/v19.0';

    onStatus('Création du conteneur média (Container)...');
    const createRes = await axios.post(`${base}/${igUserId}/media`, null, {
      params: {
        media_type: 'REELS',
        video_url: videoUrl,
        caption,
        access_token: igAccessToken,
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
        params: { fields: 'status_code', access_token: igAccessToken },
      });
      statusCode = statusRes.data.status_code;
      onStatus(`Rendu en cours (${statusCode})...`);
    }

    if (statusCode !== 'FINISHED') {
      throw new Error(`INSTAGRAM_RENDER_FAILED_${statusCode}`);
    }

    onStatus('Publication du Reel...');
    const publishRes = await axios.post(`${base}/${igUserId}/media_publish`, null, {
      params: { creation_id: creationId, access_token: igAccessToken },
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
      Authorization: `Bearer ${this.getTikTokAccessToken()}`,
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
