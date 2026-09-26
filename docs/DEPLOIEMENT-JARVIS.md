# Déploiement du backend sur Render

> **Contrôle préalable obligatoire :** consulter
> [`MIGRATION-GOOGLE-RENDER.md`](MIGRATION-GOOGLE-RENDER.md). Ne pas publier sur
> `main` avant d'avoir réconcilié les mises à jour de la VM et vérifié la
> persistance Render. Une publication de `main` déclenche le déploiement.

Le service de production est `business-automation-engine` :
<https://business-automation-engine.onrender.com>. Render construit le
`Dockerfile` racine depuis la branche GitHub `main` et déploie les commits
publiés sur cette branche.

## Configuration Render

Configurer les variables dans les paramètres du service Render; ne jamais les
committer dans Git. Les valeurs secrètes proviennent du coffre local indiqué
par `.env.SECRETS-INDEX.md`. Garder les identifiants déjà présents dans Render
pour Facebook, Google, TikTok et le stockage GitHub.

Variables nécessaires au backend et à ses fonctions activées :

- `PUBLIC_BASE_URL=https://business-automation-engine.onrender.com`
- `DASHBOARD_ORIGIN` avec les origines de production Vercel
- Fournisseurs IA configurés : `GROQ_API_KEY`, `GEMINI_API_KEY`,
  `OPENROUTER_API_KEY`, `HUGGINGFACE_API_KEY`
- Génération d'images/vidéos : `FAL_KEY` et `REPLICATE_API_TOKEN`
- Persistance externe : `GITHUB_TOKEN` et `GITHUB_DATA_REPO` (préserver le dépôt
  de données déjà configuré sur Render)
- Réplication des licences : `CLOUDFLARE_LICENSE_URL` et
  `CLOUDFLARE_ADMIN_SECRET`
- Réglages Jarvis du déploiement : `AUTO_REPLY_DEBOUNCE_MS=0` et
  `JARVIS_CONFIRM_FROM=WRITE`

Ne pas recopier `RENDER_API_KEY`, `VERCEL_TOKEN` ou les clés de déploiement
Cloudflare dans l'environnement d'exécution du backend. Ne pas remplacer le
dépôt de données Render par le dépôt de code.

## Publier et contrôler

1. Publier le commit voulu sur `main`; le déploiement Render se déclenche
   automatiquement.
2. Dans Render → Deploys, vérifier que le commit attendu atteint l'état `Live`.
3. Vérifier `https://business-automation-engine.onrender.com/health` et que le
   dashboard Vercel appelle bien l'URL Render configurée dans
   `public/config.js`.
4. Contrôler les statuts de sauvegarde GitHub et de synchronisation des licences
   depuis les fonctions d'administration.

Le plan Render gratuit a un disque éphémère. Un redémarrage ou un nouveau
déploiement peut effacer les fichiers locaux qui ne sont pas sauvegardés par
leur module dans le stockage externe. La VM Google Cloud était inaccessible au
moment de la migration : toute donnée qui n'a pas été répliquée hors VM ne peut
pas être récupérée depuis ce dépôt.

## Retour arrière

Dans Render → Deploys, redéployer le dernier commit connu comme fonctionnel.
La VM Google Cloud et son ancien script `deploy.sh` ne sont plus le chemin de
déploiement de production.
