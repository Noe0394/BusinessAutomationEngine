// Equivalent Telegram de lib/whatsappRecipients.js#normalizeRecipientEntry -
// un identifiant Telegram n'est jamais suffixe (contrairement au JID
// WhatsApp) : soit un "@username", soit un numero de telephone brut (resolu
// plus tard par lib/telegram.js#resolveRecipient au moment de l'envoi, pas
// ici - la resolution necessite une session connectee).
const { buildPersonalizationVars } = require('./personalization');

// Un identifiant de groupe/canal Telegram (diffusion, pas DM individuel) est
// un entier NÉGATIF (ex: -1001234567890, format supergroupe/canal) - le
// signe doit être préservé, contrairement à un numéro de téléphone (toujours
// positif) où seuls les chiffres comptent.
function normalizeTelegramId(identifier) {
  const raw = String(identifier || '').trim();
  if (raw.startsWith('@')) return raw;
  if (raw.startsWith('-')) return '-' + raw.slice(1).replace(/\D/g, '');
  return raw.replace(/\D/g, '');
}

function normalizeRecipientEntry(recipient, getContactName) {
  if (recipient && typeof recipient === 'object') {
    const identifier = recipient.telephone || recipient.to || recipient.identifiant || recipient.username || '';
    const to = normalizeTelegramId(identifier);
    const nom = recipient.nom || recipient.prenom || getContactName(to) || '';
    return { to, nom, vars: buildPersonalizationVars(nom, to) };
  }
  const to = normalizeTelegramId(recipient);
  const nom = getContactName(to) || '';
  return { to, nom, vars: buildPersonalizationVars(nom, to) };
}

module.exports = { normalizeTelegramId, normalizeRecipientEntry };
