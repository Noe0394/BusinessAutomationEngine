'use strict';

// Adaptateur de migration pour les opérations encore détenues par l'ancien
// action-executor. Elles sont désormais visibles et exécutées par le registre
// commun; l'exécuteur historique reste le moteur métier, pas un second routeur.
function action(ctx, name, args) {
  const executor = ctx.runtime && ctx.runtime.actionExecutor;
  if (!executor || typeof executor.execute !== 'function') return Promise.resolve({ ok: false, error: 'RUNTIME_MISSING:actionExecutor' });
  return executor.execute(name, Object.assign({}, args, { tenantId: ctx.tenant }), { tenantId: ctx.tenant });
}

function failed(out) {
  if (!out || out.ok !== true) return { ok: false, error: out && out.error || 'ACTION_FAILED' };
  return { ok: true, result: Object.assign({}, out.result || {}, { localFallback: out.fallback === true }) };
}

const TOOLS = {
  providePaymentInstructions: {
    feature: 'business_services', capabilities: ['payment-instructions', 'read-configured-payment-methods'],
    description: 'Prépare des instructions de paiement manuelles à partir des moyens réellement configurés par le vendeur. Retourne le montant, le produit, les coordonnées configurées et une référence; n’envoie rien au client et ne crée pas de lien de paiement.',
    risk: 'READ', permission: null,
    inputSchema: { amount: { type: 'number', required: true }, currency: { type: 'string' }, product: { type: 'string' } },
    async execute(args, ctx) { return failed(await action(ctx, 'PROVIDE_PAYMENT_INSTRUCTIONS', args)); },
    async verify(result) { return { verified: !!(result && result.reference && result.message && Array.isArray(result.operators) && result.operators.length) }; },
  },
  calculateDiscount: {
    feature: 'business_services', capabilities: ['calculate', 'discount-policy'],
    description: 'Calcule une remise selon le plafond configuré côté serveur. Renvoie le prix initial, le pourcentage autorisé, le prix final et la devise; ne modifie aucun prix ni dossier client.',
    risk: 'READ', permission: null,
    inputSchema: { price: { type: 'number', required: true }, requestedPercent: { type: 'number' }, currency: { type: 'string' } },
    async execute(args, ctx) { return failed(await action(ctx, 'NEGOTIATE_DISCOUNT', args)); },
    async verify(result) { return { verified: !!result && Number.isFinite(Number(result.finalPrice)) && Number.isFinite(Number(result.appliedPercent)) }; },
  },
  createStudentAccount: {
    feature: 'business_services', capabilities: ['create-account', 'issue-access-key'],
    description: 'Crée un compte élève après vente confirmée et demande une clé d’accès à la passerelle Cyrus. Un repli local en attente de synchronisation est signalé comme non vérifié, jamais comme compte créé sur la plateforme.',
    risk: 'SENSITIVE', permission: null,
    inputSchema: {
      phone: { type: 'string', description: 'Téléphone du client.' }, email: { type: 'string', description: 'Email du client.' },
      studentName: { type: 'string' }, sku: { type: 'string' }, amount: { type: 'number' }, currency: { type: 'string' },
    },
    async execute(args, ctx) {
      if (!args.phone && !args.email) return { ok: false, error: { code: 'MISSING_INPUT', fields: ['phone or email'] } };
      return failed(await action(ctx, 'CREATE_USER_ACCOUNT', args));
    },
    async verify(result) {
      return { verified: !!result && result.localFallback !== true && /^cloudflare-worker:/.test(String(result.provider || ''))
        && !!result.studentId && !!result.accessKey && !/AWAITING_SYNC/i.test(String(result.status || '')) };
    },
  },
  grantStudentModuleAccess: {
    feature: 'business_services', capabilities: ['grant-course-access', 'update-account'],
    description: 'Accorde un module à un élève existant via la passerelle Cyrus. Requiert un identifiant élève et la clé exacte du module.',
    risk: 'SENSITIVE', permission: null,
    inputSchema: {
      studentId: { type: 'string' }, phone: { type: 'string' }, email: { type: 'string' },
      moduleKey: { type: 'string', required: true },
    },
    async execute(args, ctx) {
      if (!args.studentId && !args.phone && !args.email) return { ok: false, error: { code: 'MISSING_INPUT', fields: ['studentId, phone or email'] } };
      return failed(await action(ctx, 'GRANT_MODULE_ACCESS', args));
    },
    async verify(result) {
      return { verified: !!result && result.localFallback !== true && /^cloudflare-worker:/.test(String(result.provider || ''))
        && !!result.moduleKey && !/AWAITING_SYNC/i.test(String(result.status || '')) };
    },
  },
};

module.exports = { TOOLS };
