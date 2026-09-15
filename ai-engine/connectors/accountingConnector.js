// CONNECTEUR COMPTABILITÉ — ai-engine/connectors/accountingConnector.js
// ---------------------------------------------------------------------------
// Enregistre une vente et génère une entrée de facturation pour le vendeur
// (cas d'usage : comptable / commerçant qui veut un journal des ventes tenu
// automatiquement par l'agent au fil des encaissements confirmés).
//
// Choix ASSUMÉ (cohérent avec ai-engine/storageAdapter.js et CLAUDE.md) : il
// n'existe pas d'API comptable universelle, et ce dépôt n'intègre aucun
// logiciel comptable tiers précis. Ce connecteur tient donc un GRAND LIVRE
// LOCAL par tenant (persisté via storageAdapter, miroir GitHub inclus),
// exportable/consultable — plutôt que de simuler une intégration vers un SaaS
// précis qu'on ne pourrait pas honorer réellement. Le jour où un vendeur veut
// pousser vers un logiciel comptable donné (ex. via API), ce connecteur se
// spécialise en changeant `execute` sans toucher au reste du framework.
//
// Aucun outil de suppression (règle absolue, voir connectorManager.js) : une
// écriture comptable ne se supprime pas, elle se contre-passe — non couvert
// ici (hors périmètre du premier jet).

const NAMESPACE = 'ledger';

const TOOLS = [
  {
    name: 'enregistrer_vente',
    description:
      "Enregistre une vente confirmée dans le journal des ventes du vendeur (montant, devise, produit, client). Retourne l'entrée créée.",
    parameters: {
      amount: { type: 'number', required: true, description: 'Montant encaissé.' },
      currency: { type: 'string', required: false, description: 'Devise (défaut FCFA).' },
      product: { type: 'string', required: false, description: 'Produit/formation vendu.' },
      customer: { type: 'string', required: false, description: 'Identifiant du client (email/téléphone).' },
      reference: { type: 'string', required: false, description: 'Référence de paiement à rapprocher.' },
    },
    permission: 'accounting:write',
  },
  {
    name: 'generer_facture',
    description:
      "Génère une entrée de facturation numérotée pour une vente (montant, client, produit) et l'enregistre dans le journal. Retourne le numéro de facture.",
    parameters: {
      amount: { type: 'number', required: true, description: 'Montant facturé.' },
      currency: { type: 'string', required: false, description: 'Devise (défaut FCFA).' },
      product: { type: 'string', required: false, description: 'Produit/formation facturé.' },
      customer: { type: 'string', required: false, description: 'Client facturé (email/téléphone/nom).' },
    },
    permission: 'accounting:write',
  },
];

async function loadLedger(ctx) {
  if (!ctx.store) return null;
  return ctx.store.get(NAMESPACE, ctx.tenantId || 'default', { tenantId: ctx.tenantId || 'default', sales: [], invoices: [], invoiceSeq: 0 });
}

function saveLedger(ctx, ledger) {
  if (!ctx.store) return;
  ctx.store.set(NAMESPACE, ctx.tenantId || 'default', ledger);
}

async function execute(toolName, args, ctx) {
  const a = args || {};
  const ledger = await loadLedger(ctx);
  if (!ledger) return { ok: false, error: 'RUNTIME_MISSING:store' };

  const currency = a.currency || 'FCFA';
  const now = new Date().toISOString();

  if (toolName === 'enregistrer_vente') {
    if (a.amount == null) return { ok: false, error: 'MISSING_AMOUNT' };
    const entry = {
      id: 'sale_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      amount: Number(a.amount), currency,
      product: a.product || null, customer: a.customer || null, reference: a.reference || null,
      recordedAt: now,
    };
    ledger.sales = Array.isArray(ledger.sales) ? ledger.sales : [];
    ledger.sales.push(entry);
    ledger.sales = ledger.sales.slice(-2000); // garde-fou anti-croissance illimitée
    saveLedger(ctx, ledger);
    return { ok: true, result: { entry, totalSales: ledger.sales.length, provider: 'ledger-local' } };
  }

  if (toolName === 'generer_facture') {
    if (a.amount == null) return { ok: false, error: 'MISSING_AMOUNT' };
    ledger.invoiceSeq = (ledger.invoiceSeq || 0) + 1;
    const year = new Date().getFullYear();
    const number = `FCT-${year}-${String(ledger.invoiceSeq).padStart(5, '0')}`;
    const invoice = {
      number, amount: Number(a.amount), currency,
      product: a.product || null, customer: a.customer || null, issuedAt: now,
    };
    ledger.invoices = Array.isArray(ledger.invoices) ? ledger.invoices : [];
    ledger.invoices.push(invoice);
    ledger.invoices = ledger.invoices.slice(-2000);
    saveLedger(ctx, ledger);
    return { ok: true, result: { invoice, provider: 'ledger-local' } };
  }

  return { ok: false, error: 'UNKNOWN_TOOL:' + toolName };
}

module.exports = { type: 'accounting', label: 'Comptabilité (journal local)', tools: TOOLS, execute, NAMESPACE };
