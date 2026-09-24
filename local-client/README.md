# Client local CYRUS pour PC

Cette application fonctionne sur le PC de l’utilisateur. WhatsApp, Telegram,
les contacts, les campagnes et la base SQLite restent sur cet appareil. Le
client ne dépend ni de Firebase/Firestore ni du VPS central.

Le Worker Cloudflare gère la vérification de licence et les passerelles IA de
génération utilisées par l’interface (texte, image et vidéo). Le Chat
Intelligent Node conserve sa cascade locale de fournisseurs facultatifs,
configurés dans le fichier `.env`. Les services métier, les rapports, les
historiques et les campagnes sont stockés localement.

## Démarrage

Prérequis : Node.js 22.5 ou version supérieure.

```powershell
cd local-client
npm install
Copy-Item .env.example .env
```

Renseignez `LICENSE_KEY`. `CLOUDFLARE_LICENSE_URL` est déjà prérempli avec le
Worker par défaut. Les identifiants Telegram (`TELEGRAM_API_ID` et
`TELEGRAM_API_HASH`) sont facultatifs pour démarrer, mais nécessaires à cette
intégration. Les clés IA, vocales, plateforme et System.io sont facultatives.

```powershell
npm start
```

Le serveur local écoute sur `127.0.0.1` et ouvre le tableau de bord dans le
navigateur. Les sessions WhatsApp et Telegram sont appairées depuis les écrans
de connexion.

## Fonctions locales

- Conversations WhatsApp et Telegram, carnet de contacts, import de listes,
  campagnes avec reprise, temporisation et rapports.
- Chat Intelligent, commandes, services métier, FAQ/réponse automatique,
  communautés et programmation locale des relances.
- Studio média, génération d’ebooks PDF, prospects, rapports et partage
  Facebook assisté.
- Interface Facebook/Messenger PC avec OAuth Meta, appels Page autorisés,
  conversations, commentaires, file de relance, capture locale des commentaires
  des 20 publications récentes et règles de mots-clés. La capture doit être
  activée dans l'écran Facebook; elle vérifie les commentaires toutes les
  5 minutes et conserve les prospects dans SQLite. Les réponses privées par
  règle restent désactivées jusqu'à activation explicite. Cette partie exige
  une application Meta correctement configurée et des permissions approuvées.
- Licence Cloudflare avec jeton signé pour un démarrage hors ligne temporaire.

Les sessions de messagerie et les données ne sont pas transférées au VPS. Les
actions qui nécessitent une API externe n’aboutissent que si le service et les
identifiants correspondants sont configurés.

## Générer l’exécutable

```powershell
npm run build:exe
```

La sortie est `dist/cyrus-local-client.exe`. Le contrôle de mise à jour au
démarrage lit les métadonnées Cloudflare (`/checkUpdateOffline`), puis télécharge
le binaire depuis l’URL HTTPS publiée et vérifie son SHA-256. Le Worker sait
publier les métadonnées via `/publishUpdateOffline`; l’hébergement HTTPS du
binaire et la configuration de production du Worker doivent être prêts avant
de distribuer une mise à jour automatique.

Ne placez jamais de secret administrateur Cloudflare, clé Meta App Secret ou
secret fournisseur dans un exécutable distribué. Les clés d’intégration
personnelles se gardent dans le `.env` local, qui n’est pas committé.

## Limites de validation

Les appels réels exigent des comptes WhatsApp, Telegram et Meta autorisés.
L’interface reflète les confirmations reçues des plateformes; elle ne prétend
pas qu’un partage manuel Facebook ou une opération non confirmée a réussi.
Le build `.exe`, les comptes réels et le parcours complet de mise à jour doivent
être validés sur la machine de distribution avant diffusion.
