// COMMENT REPLIER — réponses à un commentaire social (TikTok / YouTube / Facebook)
// ---------------------------------------------------------------------------------
// Couche "intelligence" des réponses aux commentaires : analyse émotionnelle du
// commentaire, choix d'une réponse (remerciement, levée d'objection, CTA,
// engagement), puis livraison. Réutilise la couche Human & Context Intelligence
// (lib/intelligence/human-context-engine.js) pour la tonalité.
//
// GARANTIE ZÉRO-EFFET : ce module ne fait JAMAIS d'appel réseau par lui-même.
// L'envoi réel est délégué à un pont réseau FOURNI en paramètre (voir
// publishers.js). Sans pont, les réponses sont générées puis renvoyées
// { ok:false, error:'RUNTIME_MISSING:...' } — cohérent avec le registre
// d'actions de lib/intelligence/action-executor.js (REPLY_COMMENT).
//
// Canal à canal :
//   FACEBOOK -> pont facebook.replyToComment(commentId, message) [API réelle]
//   YOUTUBE  -> pont youtube.reply  (API Data v3, si token Google configuré)
//   TIKTOK   -> aucune API publique de réponse commentaire : repli documenté
//               sur une réponse manuelle (lien wa/tg = Mode Manuel Express).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.CommentReplier = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const NO_REPLY_CHANNELS = { TIKTOK: true }; // pas d'API publique

  // Communauté de réponses adaptées à la situation émotionnelle.
  const REPLIES = {
    neutral_question: ['Bonne question {name} ! Je t\'explique vite fait : {answer} — dis-moi si tu veux que je détaille.',
      'Très bonne question {name}, merci ! {answer}. Tu veux qu\'on en parle en privé ?'],
    positive_enthusiasm: ['Merci {name} 🔥 je suis content que ça te parle. Envoie-moi un message privé si tu veux en profiter.',
      'Content que ça te plaise {name} ! Si tu veux, je t\'envoie les détails par message.'],
    price_objection: ['Bien vu pour le prix {name} — c\'est justement ça l\'offre du moment. Je t\'écris les détails en privé ?',
      'Le prix me semble élevé, je te comprends {name}. On en parle en message privé ?'],
    trust_objection: ['Tu fais bien de demander des garanties {name} ! Je te réponds en privé avec tous les retours clients.',
      'Courage légitime {name}. Dis-moi par message et je t\'apporte les preuves.'],
    time_objection: ['On est tous pressés {name} 😄 2 minutes suffisent pour tout savoir. Tu veux qu\'on en parle ?'],
    default: ['Merci pour ton commentaire {name} ! Si tu veux plus d\'infos, écris-moi en privé.',
      '{name}, merci ! Je réponds à toutes les questions par message privé.'],
  };

  const CHANNELS = ['FACEBOOK', 'YOUTUBE', 'TIKTOK', 'WHATSAPP', 'TELEGRAM'];

  // Analyse du commentaire + sélection de la réponse adaptée.
  function buildReplyText(comment, opts) {
    const optsObj = opts || {};
    const humanContext = optsObj.humanContext || null;
    const text = (typeof comment === 'string') ? comment : (comment && (comment.message || comment.text || '')) || '';
    const name = (comment && (comment.from && comment.from.name)) || optsObj.name || '{name}';
    const answer = optsObj.answer || '';

    let key = 'default';
    if (text && humanContext && typeof humanContext.analyzeMessage === 'function') {
      const a = humanContext.analyzeMessage(text);
      const objections = (a && a.likely_objections) || [];
      const sentiment = (a && a.sentiment) || 'neutral';
      if (a && a.uncertainty_level >= 0.5) key = 'trust_objection';
      else if (objections.indexOf('PRICE') !== -1) key = 'price_objection';
      else if (objections.indexOf('TIME') !== -1) key = 'time_objection';
      else if (objections.indexOf('TRUST') !== -1) key = 'trust_objection';
      else if (sentiment === 'positive' && (a.dominant_emotion === 'enthusiasm' || a.purchase_probability >= 0.6)) key = 'positive_enthusiasm';
      else if (/(question|combien|comment|quand|peux)/.test(text.toLowerCase())) key = 'neutral_question';
    } else if (/(combien|prix|cher|tarif)/i.test(text)) key = 'price_objection';

    const pool = REPLIES[key] || REPLIES.default;
    const variant = pool[Math.floor(Math.random() * pool.length)];
    const filled = (variant || '').replace(/\{name\}/g, name || '').replace(/\{answer\}/g, answer || '');
    return { key, text: filled, analysis: humanContext && text ? humanContext.analyzeMessage(text) : null };
  }

  // Livraison : toujours via un pont réseau injecté (jamais d'effet de bord).
  async function replyComment(channel, commentId, opts, deps) {
    const d = deps || {};
    const publisher = d.publisher || null;
    const ch = String(channel || 'FACEBOOK').toUpperCase();
    if (CHANNELS.indexOf(ch) === -1) return { ok: false, error: 'CHANNEL_INCONNU:' + ch };

    const built = buildReplyText((opts && opts.comment) || '', {
      humanContext: d.humanContext || null,
      answer: opts && opts.answer,
      name: opts && opts.name,
    });
    if (publisher && typeof publisher.replyComment === 'function') {
      try {
        const r = await publisher.replyComment(ch, commentId, built.text, opts || {});
        return { ok: r.ok !== false, error: (!r || r.ok === false) ? ((r && r.error) || 'replyComment failed') : null, result: (r && r.result) || r, reply: built };
      } catch (e) {
        return { ok: false, error: String(e && e.message || e), reply: built };
      }
    }
    if (NO_REPLY_CHANNELS[ch]) {
      return { ok: false, error: 'NO_PUBLIC_REPLY_API:' + ch, reply: built, suggestion: 'Répondre manuellement sur le canal (Mode Manuel Express / liens wa.me, t.me).' };
    }
    return { ok: false, error: 'RUNTIME_MISSING:replyComment', reply: built };
  }

  // Analyse d'un lot de commentaires (pour la file REPLY_COMMENT agrégée).
  function analyzeComments(list, opts) {
    const humanContext = (opts && opts.humanContext) || null;
    return (list || []).map((c) => {
      const text = (typeof c === 'string') ? c : (c && (c.message || c.text)) || '';
      const built = buildReplyText(c, { humanContext });
      return {
        id: (c && (c.id || c.commentId)) || null,
        text,
        tone: built.key,
        suggestedReply: built.text,
        analysis: built.analysis,
      };
    });
  }

  return { buildReplyText, replyComment, analyzeComments, CHANNELS, REPLIES };
});