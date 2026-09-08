# CYRUS SUPER ASSISTANT — backend H24

Backend Node.js/Express complet (WhatsApp/Baileys, Telegram MTProto,
Facebook Graph API, YouTube/TikTok, Studio IA, licences) — voir `index.js`
et `lib/`. L'interface (`public/dashboard.html`) est déployée séparément
(actuellement Vercel) et lui parle en cross-origin via `public/config.js`
(`window.CYRUS_API_BASE`, voir `public/config.example.js`).

**Hébergement actuel : Koyeb (free tier), en attendant un retour sur
Render** une fois la facturation régularisée — voir la note en bas de page.
Aucune différence de code entre les deux : même `Dockerfile`, mêmes
variables d'environnement (`.env.example`).

## Déploiement sur Koyeb (intégration GitHub native)

Koyeb ne propose plus la création manuelle de jeton API — le déploiement se
fait via son intégration GitHub (déjà liée sur le compte utilisé), depuis
[app.koyeb.com](https://app.koyeb.com) :

1. **Create Service** → onglet **GitHub** → dépôt
   `Noe0394/BusinessAutomationEngine`, branche `main`.
2. **Répertoire racine du build** : laisser vide / `.` (racine du dépôt —
   à ne pas confondre avec `server/`, qui est un micro-service Baileys
   séparé et optionnel, voir plus bas).
3. **Builder** : Dockerfile (auto-détecté).
4. **Port** : `10000` (déjà l'`EXPOSE` du `Dockerfile`).
5. **Variables d'environnement** : toutes celles de `.env.example`
   (`GROQ_API_KEY`, `GEMINI_API_KEY`, `HUGGINGFACE_API_KEY`,
   `OPENROUTER_API_KEY`, `FAL_KEY`, `REPLICATE_API_TOKEN`, `GITHUB_TOKEN`,
   `GITHUB_DATA_REPO`, `GITHUB_DATA_BRANCH`, `ADMIN_PASSWORD`, etc.), plus
   obligatoirement :
   - `PUBLIC_BASE_URL` : l'URL publique que Koyeb attribue à ce service
     (`https://<nom-du-service>-<org>.koyeb.app`, visible dans l'onglet
     Domains dès la création, avant même le premier déploiement terminé).
   - `DASHBOARD_ORIGIN` : l'origine du frontend Vercel autorisée en CORS
     (voir `lockCorsToOfficialDashboard` dans `index.js`) — plusieurs
     origines séparées par des virgules si besoin.
6. **Type d'instance** : `Free`.
7. Déployer. Chaque nouveau push sur `main` redéclenche automatiquement un
   déploiement (comportement natif de l'intégration GitHub de Koyeb).

Une fois l'URL Koyeb connue, mettre à jour `public/config.js`
(`window.CYRUS_API_BASE`) avec cette URL et redéployer Vercel.

Le stockage disque de ce service est **éphémère** par défaut (comme sur
Render en plan gratuit) — la sauvegarde de secours GitHub
(`githubStore.js`, déjà en place) reste donc nécessaire pour ne pas perdre
sessions/licences entre deux redémarrages.

## Le dossier `server/`

`server/` est un micro-service Baileys (WhatsApp) autonome et **optionnel**
— voir `server/README.md`. Il n'est PAS nécessaire tant que ce backend
principal gère lui-même WhatsApp (`adapters/whatsapp.js`, déjà fonctionnel).
Il devient utile seulement si l'instance Koyeb gratuite ci-dessus s'avère
trop limitée (0.1 vCPU / 512 Mo RAM) pour tenir la charge combinée
WhatsApp + ffmpeg + Studio IA, auquel cas WhatsApp pourrait être déplacé
vers ce second service Koyeb dédié.

## Retour prévu vers Render

Render reste l'hébergement cible à terme, une fois la suspension pour
facturation levée par l'utilisateur (aucune action possible depuis le code
ou cette session) — voir l'historique de commits pour le contexte complet
de cet incident. Le retour vers Render ne nécessitera aucun changement de
code : même `Dockerfile`, mêmes variables d'environnement.
