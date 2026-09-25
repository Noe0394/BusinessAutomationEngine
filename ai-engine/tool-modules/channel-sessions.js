'use strict';

const whatsappManager = require('../../adapters/whatsappManager');
const telegramManager = require('../../adapters/telegramManager');

function sessionInfo(entry, channel) {
  if (!entry || !entry.session) return { channel, sessionPresent: false, connected: false, paired: false };
  const s = entry.session;
  const connected = typeof s.isConnected === 'function' ? !!s.isConnected() : false;
  const paired = typeof s.isPaired === 'function' ? !!s.isPaired() : connected;
  const out = { channel, sessionPresent: true, connected, paired };
  if (channel === 'WHATSAPP' && typeof s.getConnectedNumber === 'function') out.connectedNumber = s.getConnectedNumber() || null;
  if (typeof s.getLoginError === 'function') out.loginError = s.getLoginError() || null;
  return out;
}

module.exports = {
  getWhatsAppSessionStatus: {
    feature: 'whatsapp_sessions', capabilities: ['read', 'status'], requiredModule: 'whatsapp',
    roles: ['OWNER', 'ADMIN'], permission: null, risk: 'READ',
    description: 'Vérifie l’état réel de la session WhatsApp du compte : connectée, appairée et numéro connecté si disponible.',
    inputSchema: {}, resultSchema: { connected: 'boolean', paired: 'boolean' },
    async execute(args, ctx) { return { ok: true, result: sessionInfo(whatsappManager.peek(ctx.tenant), 'WHATSAPP') }; },
  },
  getTelegramSessionStatus: {
    feature: 'telegram_sessions', capabilities: ['read', 'status'], requiredModule: 'telegram',
    roles: ['OWNER', 'ADMIN'], permission: null, risk: 'READ',
    description: 'Vérifie l’état réel de la session Telegram du compte : connectée, appairée et erreur de connexion éventuelle.',
    inputSchema: {}, resultSchema: { connected: 'boolean', paired: 'boolean' },
    async execute(args, ctx) { return { ok: true, result: sessionInfo(telegramManager.peek(ctx.tenant), 'TELEGRAM') }; },
  },
  logoutWhatsAppSession: {
    feature: 'whatsapp_sessions', capabilities: ['control'], requiredModule: 'whatsapp',
    roles: ['OWNER', 'ADMIN'], permission: null, risk: 'SENSITIVE',
    description: 'Déconnecte la session WhatsApp du compte connecté. La session n’est déclarée déconnectée qu’après vérification réelle.',
    inputSchema: {}, resultSchema: { loggedOut: 'boolean' },
    async execute(args, ctx) {
      const entry = whatsappManager.peek(ctx.tenant);
      if (!entry || !entry.session || typeof entry.session.logout !== 'function') return { ok: false, error: { code: 'SESSION_NOT_AVAILABLE' } };
      await entry.session.logout();
      return { ok: true, result: { loggedOut: true, channel: 'WHATSAPP' } };
    },
    async verify(result, args, ctx) {
      const entry = whatsappManager.peek(ctx.tenant);
      const s = entry && entry.session;
      return { verified: !!result && result.loggedOut === true && (!s || ((typeof s.isConnected !== 'function' || !s.isConnected()) && (typeof s.isPaired !== 'function' || !s.isPaired()))) };
    },
  },
  logoutTelegramSession: {
    feature: 'telegram_sessions', capabilities: ['control'], requiredModule: 'telegram',
    roles: ['OWNER', 'ADMIN'], permission: null, risk: 'SENSITIVE',
    description: 'Déconnecte la session Telegram du compte connecté. La session n’est déclarée déconnectée qu’après vérification réelle.',
    inputSchema: {}, resultSchema: { loggedOut: 'boolean' },
    async execute(args, ctx) {
      const entry = telegramManager.peek(ctx.tenant);
      if (!entry || !entry.session || typeof entry.session.logout !== 'function') return { ok: false, error: { code: 'SESSION_NOT_AVAILABLE' } };
      await entry.session.logout();
      return { ok: true, result: { loggedOut: true, channel: 'TELEGRAM' } };
    },
    async verify(result, args, ctx) {
      const entry = telegramManager.peek(ctx.tenant);
      const s = entry && entry.session;
      return { verified: !!result && result.loggedOut === true && (!s || ((typeof s.isConnected !== 'function' || !s.isConnected()) && (typeof s.isPaired !== 'function' || !s.isPaired()))) };
    },
  },
};
