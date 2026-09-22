// ANTI-BOUCLE ENTRE COMPTES CYRUS — ai-engine/botSignature.js
// ---------------------------------------------------------------------------
// Deux comptes Cyrus qui s'écrivent (deux numéros du même propriétaire connectés chacun à un compte, par exemple) se répondaient à l'infini.
// Deux protections indépendantes, appliquées AVANT toute génération de réponse :
//   1) SIGNATURE invisible ajoutée à chaque message AUTOMATIQUE de Cyrus (réponses, relances) : un message qui la porte vient d'un assistant
//      automatique → on ne lui répond jamais automatiquement (aucune boucle possible, même entre deux serveurs).
//   2) Numéro d'un AUTRE compte Cyrus connecté sur ce serveur : au plus UNE réponse automatique par fenêtre (un humain qui teste avec son second
//      numéro reçoit bien une réponse ; une boucle est coupée dès le second tour).
const SIG = '\u2063\u2062\u2063'; // séparateur invisible + multiplication invisible + séparateur invisible (rien n'est affiché)
const PEER_WINDOW_MS = 10 * 60 * 1000;
const lastPeerReply = new Map();

const sign = (text) => { const t = String(text == null ? '' : text); return t.includes(SIG) ? t : t + SIG; };
const isSigned = (text) => String(text || '').includes(SIG);
const strip = (text) => String(text == null ? '' : text).split(SIG).join('');

// Numéro (chiffres) d'un identifiant WhatsApp « 22670000000@s.whatsapp.net » ; null pour un LID / groupe / autre.
const digitsOf = (from) => { const m = String(from || '').match(/^(\d{6,15})(?::\d+)?@s\.whatsapp\.net$/); return m ? m[1] : null; };

// Renvoie null (répondre normalement) ou { reason } (ne pas répondre).
function detectPeer({ tenantId, channel, from, text, now }) {
  if (isSigned(text)) return { reason: 'SIGNED_BY_ASSISTANT' };
  if (String(channel).toUpperCase() !== 'WHATSAPP') return null;
  const d = digitsOf(from); if (!d) return null;
  // ADAPTATEUR local-client : adapters/whatsappManager (multi-tenant, VPS) n'existe pas ici — un seul compte
  // local par canal, donc aucun "autre tenant sur ce serveur" possible ; le require() échoue et le catch
  // dégrade proprement vers `other = false` (comportement déjà correct pour le mono-compte, sans modification).
  let other = false;
  try { other = require('../adapters/whatsappManager').isNumberOfOtherTenant(d, tenantId); } catch (e) { other = false; }
  if (!other) return null;
  const key = `${tenantId}:${d}`; const t = now || Date.now(); const last = lastPeerReply.get(key) || 0;
  if (t - last < PEER_WINDOW_MS) return { reason: 'PEER_CYRUS_ACCOUNT_LOOP_GUARD' };
  lastPeerReply.set(key, t); // première réponse autorisée dans la fenêtre
  if (lastPeerReply.size > 500) lastPeerReply.delete(lastPeerReply.keys().next().value);
  return null;
}

module.exports = { SIG, sign, isSigned, strip, digitsOf, detectPeer, _reset: () => lastPeerReply.clear() };
