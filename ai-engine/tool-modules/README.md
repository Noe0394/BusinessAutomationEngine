# Modules d’outils Cyrus

Déposer ici un fichier JavaScript par domaine de fonctionnalité. Au démarrage,
`toolRegistry` découvre les fichiers `*.js`, enregistre leurs outils et publie
leurs descriptions dans le catalogue reçu par le routeur naturel commun du Chat
Intelligent, du Self WhatsApp et du Self Telegram.

Chaque outil doit déclarer `feature`, `capabilities`, `description` et
`execute(args, ctx)`. Ajouter aussi `inputSchema` pour les arguments attendus,
`permission` pour les droits requis, un niveau `risk` et `verify(result, args,
ctx)` pour toute action dont l’exécution doit être confirmée. Les contrôles du
principal, du tenant, des pièces jointes, des permissions et de la confirmation
restent ceux du registre central.

```js
module.exports = {
  findInvoices: {
    feature: 'billing',
    capabilities: ['search', 'read'],
    description: 'Recherche les factures réelles du compte.',
    permission: null,
    risk: 'READ',
    inputSchema: { query: { type: 'string', required: true } },
    async execute(args, ctx) {
      const invoices = await billingService.search(ctx.tenant, args.query);
      return { ok: true, result: { count: invoices.length, invoices } };
    },
  },
};
```

Ne pas ajouter de route dédiée au Chat ou aux canaux. Pour exposer une nouvelle
fonctionnalité, l’enregistrer ici et redémarrer le service Render pour charger
le module. Un outil sensible doit retourner un résultat vérifiable et ne jamais
déclarer `SUCCESS` sans preuve réelle.
