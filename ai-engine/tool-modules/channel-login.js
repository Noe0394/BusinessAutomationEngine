'use strict';

const whatsappManager = require('../../adapters/whatsappManager');
const telegramManager = require('../../adapters/telegramManager');

function fail(code, message) { return { ok: false, error: { code, message: message || code } }; }
function telegramState(session) { return typeof session.getLoginStep === 'function' ? session.getLoginStep() : 'pending'; }

module.exports = {
  startWhatsAppPairing: {
    feature: 'whatsapp_sessions', capabilities: ['connect', 'pair'], requiredModule: 'whatsapp',
    roles: ['OWNER', 'ADMIN'], permission: null, risk: 'LOW_WRITE', directOnly: true,
    description: 'Demande un code d’appairage WhatsApp pour le numéro fourni. Appel réservé au routage direct afin que le code ne parte jamais à un modèle IA.',
    inputSchema: { phoneNumber: { type: 'string', required: true, description: 'Numéro au format international.' } },
    async execute(args, ctx) {
      const entry = whatsappManager.getOrCreate(ctx.tenant);
      const session = entry.session;
      if (!session || typeof session.requestPairingCode !== 'function') return fail('SESSION_NOT_AVAILABLE');
      if ((typeof session.isConnected === 'function' && session.isConnected()) || (typeof session.isPaired === 'function' && session.isPaired())) return fail('ALREADY_PAIRED', 'Déconnectez d’abord la session WhatsApp existante.');
      const code = await session.requestPairingCode(args.phoneNumber);
      if (!code) return fail('PAIRING_CODE_MISSING');
      return { ok: true, result: { pairingCode: String(code), phoneNumber: String(args.phoneNumber), state: 'code_required' } };
    },
    async verify(result) { return { verified: !!(result && result.pairingCode && result.state === 'code_required') }; },
  },
  startTelegramLogin: {
    feature: 'telegram_sessions', capabilities: ['connect', 'login'], requiredModule: 'telegram',
    roles: ['OWNER', 'ADMIN'], permission: null, risk: 'LOW_WRITE',
    description: 'Démarre la connexion Telegram pour un numéro. Le code reste saisi dans le routage direct sécurisé; il ne doit jamais être transmis à l’IA.',
    inputSchema: { phoneNumber: { type: 'string', required: true, description: 'Numéro Telegram au format international.' } },
    async execute(args, ctx) {
      const entry = telegramManager.getOrCreate(ctx.tenant);
      const session = entry.session;
      if (!session || typeof session.startLogin !== 'function') return fail('SESSION_NOT_AVAILABLE');
      if ((typeof session.isConnected === 'function' && session.isConnected()) || (typeof session.isPaired === 'function' && session.isPaired())) return fail('ALREADY_PAIRED', 'Déconnectez d’abord la session Telegram existante.');
      const step = await session.startLogin(args.phoneNumber);
      return { ok: true, result: { channel: 'TELEGRAM', phoneNumber: String(args.phoneNumber), step: String(step || telegramState(session)) } };
    },
    async verify(result, args, ctx) {
      const entry = telegramManager.peek(ctx.tenant);
      const step = entry && entry.session ? telegramState(entry.session) : 'missing';
      return { verified: !!result && ['code_required', 'password_required', 'connected', 'pending'].includes(step), step };
    },
  },
  submitTelegramLoginCode: {
    feature: 'telegram_sessions', capabilities: ['authenticate'], requiredModule: 'telegram',
    roles: ['OWNER', 'ADMIN'], permission: null, risk: 'SENSITIVE', directOnly: true,
    description: 'Soumet un code de connexion Telegram. Outil direct-only : l’argument secret n’est jamais présenté à l’IA ni journalisé.',
    inputSchema: { code: { type: 'string', required: true, description: 'Code reçu de Telegram.' } },
    async execute(args, ctx) {
      const entry = telegramManager.peek(ctx.tenant);
      if (!entry || !entry.session || telegramState(entry.session) !== 'code_required') return fail('NO_PENDING_CODE_REQUEST');
      const step = await entry.session.submitCode(args.code);
      if (step === 'error') return fail('LOGIN_CODE_REJECTED', entry.session.getLoginError && entry.session.getLoginError());
      return { ok: true, result: { channel: 'TELEGRAM', step: String(step || telegramState(entry.session)) } };
    },
    async verify(result, args, ctx) {
      const entry = telegramManager.peek(ctx.tenant);
      const step = entry && entry.session ? telegramState(entry.session) : 'missing';
      return { verified: !!result && ['password_required', 'connected', 'code_required'].includes(step), step };
    },
  },
  submitTelegramLoginPassword: {
    feature: 'telegram_sessions', capabilities: ['authenticate'], requiredModule: 'telegram',
    roles: ['OWNER', 'ADMIN'], permission: null, risk: 'SENSITIVE', directOnly: true,
    description: 'Soumet le mot de passe 2FA Telegram. Outil direct-only : le mot de passe n’est jamais présenté à l’IA ni journalisé.',
    inputSchema: { password: { type: 'string', required: true, description: 'Mot de passe 2FA Telegram.' } },
    async execute(args, ctx) {
      const entry = telegramManager.peek(ctx.tenant);
      if (!entry || !entry.session || telegramState(entry.session) !== 'password_required') return fail('NO_PENDING_PASSWORD_REQUEST');
      const step = await entry.session.submitPassword(args.password);
      if (step === 'error') return fail('LOGIN_PASSWORD_REJECTED', entry.session.getLoginError && entry.session.getLoginError());
      return { ok: true, result: { channel: 'TELEGRAM', step: String(step || telegramState(entry.session)) } };
    },
    async verify(result, args, ctx) {
      const entry = telegramManager.peek(ctx.tenant);
      const step = entry && entry.session ? telegramState(entry.session) : 'missing';
      return { verified: !!result && ['connected', 'password_required'].includes(step), step };
    },
  },
};
