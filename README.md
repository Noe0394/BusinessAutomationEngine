# CYRUS SUPER ASSISTANT — Backend

Backend Node.js/Express (WhatsApp/Baileys, Telegram MTProto, Facebook Graph API,
YouTube/TikTok, Studio IA et licences). Le tableau de bord est servi séparément
par Vercel et contacte l'API configurée dans `public/config.js`.

## Hébergement actuel

Le backend est hébergé sur Render : <https://business-automation-engine.onrender.com>.
Le service Render utilise le `Dockerfile` à la racine et se déploie depuis la
branche `main` de GitHub à chaque mise à jour publiée sur cette branche. La
configuration du dashboard Vercel pointe également vers ce backend.

Les variables d'environnement de production se gèrent dans Render, jamais dans
Git. `PUBLIC_BASE_URL` doit être l'URL Render et `DASHBOARD_ORIGIN` les origines
Vercel autorisées. Pour les clés d'API, consulter `.env.example` et
`.env.SECRETS-INDEX.md`; ne pas copier aveuglément le `.env` local, qui contient
aussi des paramètres réservés aux outils locaux et aux déploiements distincts.

Le plan Render actuel utilise un système de fichiers éphémère. La persistance
des licences, sessions et autres états dépend donc des sauvegardes externes
configurées par module (`GITHUB_TOKEN` et `GITHUB_DATA_REPO`, ou un stockage
persistant compatible). Vérifier les statuts de synchronisation depuis les
fonctions d'administration après tout redéploiement.

## Déploiement et vérification

Publier les changements validés sur `main`. Render lance alors le build Docker
et le déploiement. Vérifier l'état du déploiement dans Render puis l'endpoint
`/health` du service. Le guide opérationnel est dans
[`docs/DEPLOIEMENT-JARVIS.md`](docs/DEPLOIEMENT-JARVIS.md).

## Ancienne infrastructure Google Cloud

La VM Google Cloud et son reverse proxy Caddy ne sont plus la cible de
déploiement. `setup-vps.sh`, `deploy.sh`, `docker-compose.yml`, `Caddyfile` et
[`docs/VPS-SSH.md`](docs/VPS-SSH.md) sont conservés comme historique; ne pas les
utiliser pour publier les mises à jour actuelles.

## Dossier `server/`

`server/` est un micro-service Baileys autonome et optionnel. Le backend
principal gère déjà WhatsApp via `adapters/whatsapp.js`; le service séparé n'est
utile que si l'architecture est explicitement déplacée vers un worker dédié.
