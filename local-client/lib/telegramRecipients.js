// Equivalent Telegram de lib/whatsappRecipients.js#normalizeRecipientEntry -
// un identifiant Telegram n'est jamais suffixe (contrairement au JID
// WhatsApp) : soit un "@username", soit un numero de telephone brut (resolu
// plus tard par lib/telegram.js#resolveRecipient au moment de l'envoi, pas
// ici - la resolution necessite une session connectee).
const { buildPersonalizationVars } = require('./personalization');

function normalizeTelegramId(identifier) {
  const raw = String(identifier || '').trim();
  if (raw.startsWith('@')) return raw;
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
