# Migration Google Cloud → Render — contrôle avant déploiement

**État au 24 septembre 2026 : le dernier commit `main` est déjà Live sur Render.
Je n'ai déclenché aucun déploiement. La parité exacte avec la VM et l'intégrité
complète des données restent à confirmer.**

## Architecture cible

- **Vercel reste l'interface principale.** Le dashboard statique appelle
  `https://business-automation-engine.onrender.com`, configuré dans
  `public/config.js`.
- **Render héberge l'API Node.js.** Le Dockerfile racine inclut le build du
  dashboard backend et démarre `index.js`; la configuration de dépôt indique la
  branche `main`.
- **Google Cloud n'est plus la cible.** L'utilisateur indique que la VM est
  inactive faute de paiement. Ne pas utiliser les anciennes instructions SSH
  comme chemin de déploiement.

## Ce qui est confirmé dans le dépôt

- Le point de départ vérifié est `bbee8e59ee8531811451fcc4f7aa9c96525bb5b2`,
  daté du 24 septembre 2026; il correspond à `origin/main` et au commit Render
  `Live`. Le déploiement automatique a été créé à `2026-09-24T16:24:49Z` avant
  cet audit.
- `public/config.js` pointe déjà vers l'API Render. Le fichier `.env` local,
  ignoré par Git, avait encore l'ancienne URL Google dans `PUBLIC_BASE_URL`; sa
  valeur a été basculée vers l'URL Render. Cette modification locale ne change
  pas les variables enregistrées dans le service Render.
- Avant le déploiement actuel, le dernier déploiement Render documenté était le
  commit `11652f9f34dcdd7c6125d85b73ab59e72e936606` du 8 septembre. Depuis,
  `origin/main` contient 163 commits et 1 146 chemins modifiés; les changements
  comprennent du backend, du dashboard et des composants PC/mobile.
- Le dernier commit de `origin/main` antérieur au 15 septembre est
  `338abd662ab8b02325b5e8b7ffa3933d2e256118` (14 septembre, 21:35 UTC+1).
  L'historique de déploiement Google confirme une mise à jour le 14 septembre,
  mais n'enregistre pas le SHA exact réellement déployé.
- Render est actif sur la branche `main` et `/health` renvoie `200` avec
  `{"status":"ok"}`. Le `config.js` réellement servi par Vercel renvoie `200`
  et définit l'API Render. `PUBLIC_BASE_URL` et `DASHBOARD_ORIGIN` côté Render
  correspondent à ces URL. Les variables de Facebook, Google OAuth, TikTok,
  Telegram, IA, licences et médias sont présentes; `GITHUB_TOKEN` et
  `GITHUB_DATA_REPO` aussi. Le dépôt de données est distinct du dépôt de code;
  `GITHUB_DATA_BRANCH` n'est pas défini, donc `githubStore.js` utilise `main`.
  Cette branche de données a reçu un commit `531c5ff40edddc8f1961ab77deecbf9ebf8e8de0`
  à `2026-09-24T16:26:47Z`, deux minutes après le déploiement Live. Cela
  confirme une activité récente du dépôt de données, pas l'intégrité de chaque
  fichier de session.

## Écarts non résolus — bloquent la confirmation de parité intégrale

1. **Parité exacte du code VM.** Le SHA exact installé sur Google Cloud et
   d'éventuelles modifications faites hors Git ne sont pas enregistrés. Le
   dépôt actuel contient les changements versionnés connus, mais il ne permet
   pas de prouver l'absence de modifications locales sur la VM.
2. **Données et sessions.** Render utilise un disque éphémère. Le dépôt GitHub
   de données est distinct du dépôt de code et a reçu une mise à jour après le
   déploiement. Une autre branche, `origin/backups`, contient aussi des
   instantanés applicatifs jusqu'au 20 septembre, mais elle n'est pas le dépôt
   branché sur le service Render. Ces preuves ne confirment pas que chaque
   session ou fichier VM a été sauvegardé jusqu'à l'arrêt. Ne pas copier les
   sessions ou états utilisateur dans `main`.
3. **Réplication par module.** Le statut des dernières lectures/écritures de
   licences et sessions n'a pas pu être récupéré : `/api/admin/storage-status`
   exige le mot de passe admin et aucune valeur `ADMIN_PASSWORD` n'est
   configurée dans Render. Aucun mot de passe n'a été deviné.

## Porte de contrôle avant l'unique déploiement

- Récupérer ou confirmer le dernier SHA de la VM et comparer les changements
  applicatifs à `origin/main`; documenter toute modification hors Git.
- Vérifier la date et la couverture des sauvegardes disponibles. Si les sessions
  WhatsApp/Telegram doivent être réutilisées, les restaurer via le stockage
  dédié approprié; sinon prévoir un nouvel appairage. Ne pas placer de secrets
  de session dans le dépôt de code.
- Dans Render, contrôler `PUBLIC_BASE_URL`, `DASHBOARD_ORIGIN`, le dépôt et la
  branche de données GitHub, ainsi que les secrets des modules utilisés. Ne pas
  remplacer le dépôt de données par le dépôt de code.
- Depuis le compte administrateur, relever `/api/admin/storage-status` et
  confirmer que les dernières sauvegardes des licences et sessions ont réussi.
- Si le statut admin indique un échec, retrouver le dernier snapshot Google
  disponible avant d'envisager une restauration; ne pas écraser le dépôt de
  données sans comparer son état.
- Confirmer que l'API Render et le dashboard Vercel répondent et que le
  dashboard charge bien `public/config.js`.
- Le commit `bbee8e5` étant déjà `Live`, ne pas le redéployer. Si un correctif
  de code est requis après ces contrôles, préparer le commit complet puis ne
  déclencher qu'un seul nouveau déploiement; contrôler son SHA `Live`, `/health`
  et les statuts de sauvegarde.

## État de l'action

Aucun push, redémarrage ou déploiement supplémentaire n'a été effectué pendant
cet audit. Render avait déjà publié automatiquement le commit `bbee8e5` avant
son commencement. Aucun nouveau build n'est nécessaire pour ce commit; la
confirmation de parité intégrale reste suspendue jusqu'à la vérification du SHA
Google et des sauvegardes de données.
