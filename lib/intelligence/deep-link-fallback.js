// DEEP-LINK FALLBACK — repli automatique en Mode Manuel Express (cooldown/pause)
// -------------------------------------------------------------------------------
// TEST 4 de la mission : quand une tâche d'envoi (SEND_CAMPAIGN / FOLLOW_UP)
// vise un canal dont la session est indisponible (FLOOD_WAIT, session évincée
// ou « en pause » par le régulateur adapters/sessionRegulator.js), la couche
// intelligence bascule automatiquement vers un deep link wa.me / t.me au lieu
// d'échouer — et documente l'attache média autonome du payload (le message à
// envoyer) pour l'envoi réel au prochain créneau disponible.
//
// Décision 100% locale (aucun réseau) : le « sender » est injecté par le
// runtime d'actions ; s'il n'est pas fourni, le canal est considéré disponible
// (comportement inchangé — parité de non-effet par défaut).
//
// UMD : Node et navigateur (préparé pour la parité webapp Zero-VPS).
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DeepLinkFallback = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const COOLDOWN_REASONS = ['FLOOD_WAIT', 'SESSION_EVICTED', 'SESSION_PAUSED', 'PAUSED', 'COOLING', 'DISPOSED', 'NOT_CONNECTED'];

  // Décide du mode de livraison pour un envoi.
  // sender = { ok:boolean, reason?:string } fourni par le runtime ; absent =>
  // canal disponible (DIRECT). mode DEEP_LINK si indisponible.
  function resolveDelivery(channel, target, text, opts) {
    const o = opts || {};
    const sender = o.sender || { ok: true };
    const ch = String(channel || 'WHATSAPP').toUpperCase();
    const mediaUrl = o.mediaUrl || o.media || null;

    // Session visiblement disponible (ou sender absent = défaut non-effet) ->
    // livraison directe inchangée.
    if (sender.ok !== false) {
      return { mode: 'DIRECT', channel: ch, senderAvailable: true };
    }

    // Session indisponible : bascule automatique en mode manuel (deep link).
    // Une raison inconnue est traitée comme SESSION_UNAVAILABLE par prudence :
    // jamais on ne tente un envoi que le régulateur a signalé comme impossible.
    const link = buildDeepLink(ch, target, text, o);
    const reason = sender.reason && COOLDOWN_REASONS.some((r) => r === sender.reason) ? sender.reason : 'SESSION_UNAVAILABLE';
    return {
      mode: 'DEEP_LINK',
      channel: ch,
      senderAvailable: false,
      reason,
      url: link.url,
      note: link.note || null,
      mediaUrl: mediaUrl || null,
      // Le message à envoyer est attaché au lien : l'ouverture manuelle du lien
      // affiche déjà le texte pré-rempli dans l'app cible (Mode Manuel Express).
      payload: { to: target, text: text || null, mediaUrl: mediaUrl || null },
    };
  }

  // Construction du lien.
  function buildDeepLink(channel, target, text, opts) {
    const o = opts || {};
    const ch = String(channel || 'WHATSAPP').toUpperCase();
    const encoded = encodeURIComponent(text || o.prefill || '');
    if (ch === 'WHATSAPP') {
      const number = String(target || '').replace(/[^0-9]/g, '');
      return { url: 'https://wa.me/' + number + (encoded ? '?text=' + encoded : ''), target: number };
    }
    if (ch === 'TELEGRAM') {
      // Sans texte si pas de username exploitable : tg:/// protocol leaké via
      // l'URL web (aucune clé API requise) ; le texte est pré-rempli seulement
      // quand un identifiant public est dispo (identifiants numériques CIDs ne
      // sont pas pré-remplissables via t.me).
      const uname = String(target || '').replace(/^@/, '');
      const free = !/^\d+$/.test(uname);
      if (free) return { url: 'https://t.me/' + uname + (encoded ? '?text=' + encoded : ''), target: uname };
      return { url: 'https://t.me/' + uname, target: uname, note: 'identifiant numérique : texte pré-rempli non supporté, attache manuelle conseillée' };
    }
    return { url: null, target: target || null };
  }

  function isCooldownReason(reason) {
    return !!reason && COOLDOWN_REASONS.some((r) => r === reason);
  }

  return { resolveDelivery, buildDeepLink, isCooldownReason, COOLDOWN_REASONS };
});