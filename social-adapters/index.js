// SOCIAL ADAPTERS — assembleur de la couche sociale (TikTok / YouTube / Facebook)
// --------------------------------------------------------------------------------
// Point d'entrée : crée un runtime social complet consommable par le registre
// d'actions de la couche intelligence (lib/intelligence/action-executor.js) —
// les clés replyComment / generateVideo / publishVideo attendues par les actions
// REPLY_COMMENT / GENERATE_VIDEO / SEND_CAMPAIGN (canal vidéo).
//
// GARANTIE ZÉRO-EFFET PAR DÉFAUT : sans adaptateur réseau injecté, les méthodes
// renvoient { ok:false, error:'RUNTIME_MISSING:...' } (jamais d'envoi réel).
// Le branchement réseau se fait par injection de publishers (voir README.md).
'use strict';

const replier = require('./comment-replier.js');
const { createPublishers } = require('./publishers.js');

function createSocialAdapters(deps) {
  const d = deps || {};
  const humanContext = d.humanContext || null;
  const publishers = d.publishers || createPublishers(d);

  return {
    // Actions consommées par l'Automation Engine (action-executor.js).
    replyComment: (channel, commentId, text, payload) =>
      replier.replyComment(channel, commentId, Object.assign({}, payload, { comment: text }), { publisher: publishers, humanContext }),
    listComments: (postId, opts) => publishers.listComments(postId, opts),
    publishVideo: (video, opts) => publishers.publishVideo((opts && opts.channel) || 'TIKTOK', video, opts),
    analyzeComments: (list, opts) => replier.analyzeComments(list, { humanContext }),
    buildReplyText: (comment, opts) => replier.buildReplyText(comment, { humanContext }),
  };
}

module.exports = { createSocialAdapters };