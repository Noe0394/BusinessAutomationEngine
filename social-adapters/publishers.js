// SOCIAL PUBLISHERS — pont réseau réel vers les adapteurs existants
// -----------------------------------------------------------------------------
// Réutilise (jamais duplique) :
//   - adapters/facebook.js       (FacebookMessengerAdapter) : getPostComments,
//                                 replyToComment, moderateComment, deleteComment
//   - adapters/media_publisher.js (MediaPublisherAdapter)  : publishTikTokVideo,
//                                 publishYouTubeShort, publishInstagramReel
// Un fournisseur non configuré (token absent) → erreur claire du même type que
// celles levées par les adapteurs eux-mêmes (FB_NOT_CONFIGURED / YT / TikTok).
// Aucun effet de bord tant qu'on ne fournit pas ces instances.
'use strict';

function createPublishers(deps) {
  const d = deps || {};
  const facebook = d.facebook || null;       // instance FacebookMessengerAdapter
  const media = d.media || null;             // instance MediaPublisherAdapter
  const youtubeReply = d.youtubeReply || null; // { reply(commentId, text) } optionnel

  function configured(what) { return what === 'facebook' ? !!(facebook && facebook.isConfigured && facebook.isConfigured()) : !!(media); }

  // Réponse à un commentaire selon le canal.
  async function replyComment(channel, commentId, text, opts) {
    const ch = String(channel || '').toUpperCase();
    if (ch === 'FACEBOOK') {
      if (!facebook) return { ok: false, error: 'RUNTIME_MISSING:facebook' };
      try {
        const res = await facebook.replyToComment(commentId, text);
        return { ok: true, result: { id: res && res.id, reples: res } };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e) };
      }
    }
    if (ch === 'YOUTUBE') {
      if (!youtubeReply) return { ok: false, error: 'RUNTIME_MISSING:youtubeReply (token Google / API Data v3 non fourni)' };
      try { const res = await youtubeReply.reply(commentId, text); return { ok: true, result: res }; }
      catch (e) { return { ok: false, error: String(e && e.message || e) }; }
    }
    if (ch === 'TIKTOK') {
      return { ok: false, error: 'NO_PUBLIC_REPLY_API:TIKTOK' };
    }
    return { ok: false, error: 'CHANNEL_INCONNU:' + ch };
  }

  // Liste des commentaires d'un post (Facebook uniquement, API réelle).
  async function listComments(postId, opts) {
    if (!facebook) return { ok: false, error: 'RUNTIME_MISSING:facebook' };
    try {
      const comments = await facebook.getPostComments(postId, { limit: (opts && opts.limit) || 50 });
      return { ok: true, result: comments };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  // Publication vidéo — délègue au MediaPublisher existant.
  async function publishVideo(channel, video, opts) {
    const ch = String(channel || '').toUpperCase();
    if (!media) return { ok: false, error: 'RUNTIME_MISSING:mediaPublisher' };
    const onStatus = (opts && opts.onStatus) || (() => {});
    try {
      if (ch === 'TIKTOK') return { ok: true, result: await media.publishTikTokVideo({ buffer: video.buffer, title: video.title, scheduleAt: video.scheduleAt || null }, onStatus) };
      if (ch === 'YOUTUBE') return { ok: true, result: await media.publishYouTubeShort({ buffer: video.buffer, title: video.title, description: video.description || '', scheduleAt: video.scheduleAt || null }, onStatus) };
      if (ch === 'INSTAGRAM') return { ok: true, result: await media.publishInstagramReel({ token: video.token || null, caption: video.caption || video.title || '', scheduleAt: video.scheduleAt || null }, onStatus) };
      return { ok: false, error: 'CHANNEL_INCONNU:' + ch };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e) };
    }
  }

  // Portrait complet pour un runtime d'actions.
  return {
    replyComment,
    listComments,
    publishVideo,
    configured,
    _load: () => {
      // Instanciation paresseuse des adapteurs réels si non fournis (désactivée
      // par défaut : mieux vaut injecter les instances du VPS pour partager la
      // config OAuth déjà en place).
      return { facebook: !!facebook, media: !!media, youtubeReply: !!youtubeReply };
    },
  };
}

module.exports = { createPublishers };