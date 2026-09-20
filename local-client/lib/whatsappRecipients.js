// Petites fonctions pures partagées entre index.js (envoi immédiat côté
// requête HTTP) et queues/campaignEngine.js (moteur de campagne persistant) —
// extraites ici pour éviter la duplication et toute dépendance circulaire
// entre les deux.

// replaceVariables (avec son fallback "orphelin propre") vit désormais dans
// lib/personalization.js, partagé avec Telegram — réexporté ici pour ne pas
// casser les appelants existants qui l'importent depuis ce module.
const { replaceVariables, buildPersonalizationVars } = require('./personalization');

function normalizeJid(telephone) {
  const raw = String(telephone).trim();
  if (raw.includes('@')) {
    return raw;
  }
  const digits = raw.replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

// Format E.164 (ex: +2250700000000) à partir d'un JID TÉLÉPHONIQUE WhatsApp
// (2250700000000@s.whatsapp.net) — utilisé pour l'export Excel. Un JID au format
// @lid (identité anonyme de WhatsApp) ne porte PAS de numéro de téléphone : les
// chiffres qui précèdent "@lid" ne sont qu'un identifiant technique. On renvoie
// alors une chaîne vide (numéro non disponible) plutôt que de fabriquer un faux
// numéro (voir ai-engine/contactIdentity.js : JID/LID ≠ numéro de téléphone).
function jidToE164(jid) {
  const m = String(jid || '').match(/^(\d{6,15})(?::\d+)?@(?:s\.whatsapp\.net|c\.us)$/i);
  return m ? `+${m[1]}` : '';
}

// Représentation normalisée d'un destinataire WhatsApp pour l'envoi : un JID
// résolu ("to"), un nom de personnalisation ("nom", jamais undefined/null,
// conservé pour compatibilité) et le jeu complet de variables dynamiques
// ("vars" — {first_name}, {name}, {username}, alias {nom}/{prenom}, voir
// lib/personalization.js#buildPersonalizationVars) prêt à l'emploi pour
// personaliser un message. Accepte soit un identifiant simple (chaîne —
// résolution de groupe, ou liste importée à l'ancien format), soit un contact
// enrichi { telephone, nom } (liste importée avec colonne "nom", voir
// /api/contacts/import) — {username} est alors alimenté par la colonne
// identifiant (telephone) elle-même, WhatsApp n'ayant pas de notion de
// username. Dans le premier cas, on retombe sur le cache opportuniste de noms
// publics (pushName/notify) constitué par l'instance WhatsApp du tenant au
// fil des messages/contacts vus — qui peut rester vide si ce contact n'a
// jamais été "rencontré" (ou si son profil est masqué), auquel cas
// buildPersonalizationVars retombe proprement sur des variables vides (voir
// replaceVariables).
function normalizeRecipientEntry(recipient, getContactName) {
  if (recipient && typeof recipient === 'object') {
    const telephone = recipient.telephone || recipient.to || recipient.phone || '';
    const to = normalizeJid(telephone);
    const nom = recipient.nom || recipient.prenom || getContactName(to) || '';
    return { to, nom, vars: buildPersonalizationVars(nom, telephone || jidToE164(to)) };
  }
  const to = normalizeJid(recipient);
  const nom = getContactName(to) || '';
  return { to, nom, vars: buildPersonalizationVars(nom, jidToE164(to)) };
}

module.exports = {
  replaceVariables,
  buildPersonalizationVars,
  normalizeJid,
  jidToE164,
  normalizeRecipientEntry,
};
