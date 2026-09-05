// Petites fonctions pures partagées entre index.js (envoi immédiat côté
// requête HTTP) et queues/campaignEngine.js (moteur de campagne persistant) —
// extraites ici pour éviter la duplication et toute dépendance circulaire
// entre les deux.

// Variables de personnalisation ({nom}, etc.) : une clé absente ou nulle est
// remplacée par une chaîne vide plutôt que de laisser le texte "{nom}" tel
// quel ou d'y insérer le mot "null" — un message "Bonjour {nom}," sans nom
// connu doit devenir "Bonjour," et non un texte visiblement cassé.
function replaceVariables(template, row) {
  return String(template).replace(/{(\w+)}/g, (match, key) => {
    const value = row[key];
    return value !== undefined && value !== null ? String(value) : '';
  });
}

function normalizeJid(telephone) {
  const raw = String(telephone).trim();
  if (raw.includes('@')) {
    return raw;
  }
  const digits = raw.replace(/\D/g, '');
  return `${digits}@s.whatsapp.net`;
}

// Format E.164 (ex: +2250700000000) à partir d'un JID WhatsApp
// (2250700000000@s.whatsapp.net) — utilisé pour l'export Excel. Les JID au
// format @lid (identité anonyme récente de WhatsApp, sans numéro réel
// exploitable) ne portent pas un vrai numéro : les chiffres qui précèdent
// "@lid" ne sont pas un numéro de téléphone valide, mais on les renvoie quand
// même préfixés d'un "+" plutôt que de faire échouer l'export pour ces
// quelques participants.
function jidToE164(jid) {
  const digits = String(jid || '').split('@')[0].replace(/\D/g, '');
  return digits ? `+${digits}` : '';
}

// Représentation normalisée d'un destinataire WhatsApp pour l'envoi : un JID
// résolu ("to") et un nom de personnalisation ("nom", jamais undefined/null).
// Accepte soit un identifiant simple (chaîne — résolution de groupe, ou liste
// importée à l'ancien format), soit un contact enrichi { telephone, nom }
// (liste importée avec colonne "nom", voir /api/contacts/import). Dans le
// premier cas, on retombe sur le cache opportuniste de noms publics
// (pushName/notify) constitué par l'instance WhatsApp du tenant au fil des
// messages/contacts vus — qui peut rester vide si ce contact n'a jamais été
// "rencontré". getContactName est celle de LA session WhatsApp du tenant
// courant (jamais partagée entre tenants, voir adapters/whatsapp.js).
function normalizeRecipientEntry(recipient, getContactName) {
  if (recipient && typeof recipient === 'object') {
    const telephone = recipient.telephone || recipient.to || recipient.phone || '';
    const to = normalizeJid(telephone);
    return { to, nom: recipient.nom || recipient.prenom || getContactName(to) || '' };
  }
  const to = normalizeJid(recipient);
  return { to, nom: getContactName(to) || '' };
}

module.exports = {
  replaceVariables,
  normalizeJid,
  jidToE164,
  normalizeRecipientEntry,
};
