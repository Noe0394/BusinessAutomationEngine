# Migration Google Cloud → Render — contrôle avant déploiement

**État au 25 septembre 2026 : `c93949e0d6bd6c440fbf9dccfa15d9b405dd34d5`
est Live sur Render et correspond à `HEAD`/`origin/main`. L'utilisateur a
confirmé Render comme seule cible; l'ancienne VM Google est inactive et hors
périmètre. La clé Anthropic est enregistrée sur Render sans redéploiement. Un
nouveau déploiement est demandé et attend le contrôle final du remote `main`.**

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

- Le commit vérifié juste avant cette livraison est
  `c93949e0d6bd6c440fbf9dccfa15d9b405dd34d5` (`Add Render natural language
  community controls`); il correspond à `HEAD`, `origin/main` et au commit
  Render `Live`. La lecture de l'historique Render confirme que l'ajout de la
  variable Anthropic n'a déclenché aucun déploiement.
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
  à `2026-09-24T16:26:47Z`, deux minutes après le déploiement Live. Le contrôle
  pré-déploiement du 25 septembre retourne aussi `/api/admin/storage-status` en
  HTTP 200 : le stockage licences est activé et son dernier fetch a réussi
  (`2026-09-25T11:20:14Z`), sans erreur; WhatsApp indique un push réussi à
  `2026-09-25T13:20:18Z`; Telegram indique `lastPushOk=true`, sans horodatage
  exposé et sans erreur. Aucun statut de push en échec n'est présent.

## Écarts non résolus — bloquent la confirmation de parité intégrale

1. **Parité exacte de l'ancienne VM Google.** Son SHA exact et d'éventuelles
   modifications hors Git ne sont pas enregistrés. Cette vérification est hors
   périmètre de cette livraison Render; aucune donnée ni session ne sera copiée
   depuis cette VM.
2. **Données et sessions.** Render utilise un disque éphémère. Le dépôt GitHub
   de données est distinct du dépôt de code et a reçu une mise à jour après le
   déploiement. Une autre branche, `origin/backups`, contient aussi des
   instantanés applicatifs jusqu'au 20 septembre, mais elle n'est pas le dépôt
   branché sur le service Render. Ces preuves ne confirment pas que chaque
   session ou fichier VM a été sauvegardé jusqu'à l'arrêt. Ne pas copier les
   sessions ou états utilisateur dans `main`.
3. **Réplication par module.** Le statut a été récupéré par l'endpoint
   administratif en lecture seule. Le stockage des licences lit le dépôt avec
   succès; WhatsApp et Telegram ne signalent aucun push en échec. L'absence
   d'horodatage de push pour les licences et Telegram est documentée et ne vaut
   pas un échec.

## Porte de contrôle avant l'unique déploiement

- Actualiser `origin/main` juste avant le push et vérifier qu'il correspond au
  commit de base `c93949e`; arrêter si le remote a avancé.
- Vérifier la date et la couverture des sauvegardes disponibles. Si les sessions
  WhatsApp/Telegram doivent être réutilisées, les restaurer via le stockage
  dédié approprié; sinon prévoir un nouvel appairage. Ne pas placer de secrets
  de session dans le dépôt de code.
- Dans Render, contrôler `PUBLIC_BASE_URL`, `DASHBOARD_ORIGIN`, le dépôt et la
  branche de données GitHub, ainsi que les secrets des modules utilisés. Ne pas
  remplacer le dépôt de données par le dépôt de code.
- `/api/admin/storage-status` a été relevé : aucun push n'est signalé en échec;
  les résultats et horodatages disponibles figurent ci-dessus.
- Si le statut admin indique un échec, retrouver le dernier snapshot Google
  disponible avant d'envisager une restauration; ne pas écraser le dépôt de
  données sans comparer son état.
- Confirmer que l'API Render et le dashboard Vercel répondent et que le
  dashboard charge bien `public/config.js`.
- Le commit `c93949e` est déjà `Live`. Pour cette livraison, créer un seul
  commit complet, le pousser sur `main`, puis contrôler le nouveau SHA `Live`,
  `/health` et les statuts de sauvegarde.

## État de l'action

Avant le push, le commit Live était `c93949e`. Le statut Render et les
sauvegardes ont été contrôlés le 25 septembre; aucun état utilisateur n'a été
copié dans le dépôt de code. La prochaine étape est le déploiement unique du
commit préparé, puis la vérification de son SHA et de `/health`.
