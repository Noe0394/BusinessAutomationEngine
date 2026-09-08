# Micro-service Baileys (WhatsApp) — pour Koyeb

Connecteur WhatsApp autonome, **mono-tenant** (un seul compte par
déploiement), pensé pour un hébergeur H24 à ressources limitées (Koyeb free
tier : 0.1 vCPU / 512 Mo RAM). Reprend la logique de connexion/reconnexion
déjà éprouvée en production dans `adapters/whatsapp.js` à la racine du
dépôt (backoff exponentiel, gestion des sessions révoquées, timeout de QR à
120s) — voir les commentaires dans `index.js` pour le détail de chaque
choix.

Ce dossier est **indépendant** du reste du dépôt : son propre
`package.json`, son propre `Dockerfile`, aucune dépendance sur `index.js` à
la racine. Il ne connaît rien des licences/tenants du backend principal —
il expose juste WhatsApp par HTTP, et relaie les événements (message reçu,
QR, connexion) vers `WEBHOOK_URL`.

## Déploiement sur Koyeb (intégration GitHub native, sans jeton API)

1. Sur [app.koyeb.com](https://app.koyeb.com) → **Create Service** → onglet
   **GitHub** → sélectionner le dépôt `Noe0394/BusinessAutomationEngine`,
   branche `main`.
2. **Répertoire racine du build** : renseigner `server` (sinon Koyeb tente
   de builder tout le dépôt, y compris le backend principal beaucoup plus
   lourd — ffmpeg, Telegram, etc. — inutile ici).
3. **Builder** : Dockerfile (auto-détecté une fois le répertoire `server`
   choisi).
4. **Port** : `8000` (ou toute autre valeur, à condition de définir la
   variable d'environnement `PORT` en conséquence).
5. **Variables d'environnement** : voir `.env.example` dans ce dossier —
   `SHARED_SECRET` (obligatoire), `WEBHOOK_URL`, et si possible
   `GITHUB_TOKEN`/`GITHUB_DATA_REPO`/`GITHUB_DATA_BRANCH` (sauvegarde de
   session, indispensable sur le plan gratuit sans disque persistant).
6. **Type d'instance** : `Free`.
7. Déployer. Chaque nouveau push sur `main` redéclenche automatiquement un
   déploiement (comportement natif de l'intégration GitHub de Koyeb).

## API HTTP exposée

Toutes les routes sauf `/health` exigent l'en-tête `x-shared-secret`
(valeur = `SHARED_SECRET`) une fois celui-ci défini.

- `GET /health` — vérification de vie, jamais protégée.
- `GET /status` — `{ connected, hasQR, storage }`.
- `GET /qr` — `{ qr, dataUrl }` (QR code en data URL PNG) si un appairage
  est en attente, 404 sinon.
- `POST /pairing-code` — `{ phoneNumber }` → `{ code }` (code d'association
  à 4 groupes de 4 chiffres, alternative au QR).
- `POST /send` — `{ to, text }` → `{ ok, id }`.
- `POST /send-media` — `{ to, base64, mimetype, filename?, caption? }` →
  `{ ok, id }`.
- `POST /logout` — déconnecte et purge la session locale + distante
  (GitHub), pour ré-appairer un nouveau compte.

## Événements sortants (`WEBHOOK_URL`)

Une requête `POST` est envoyée à `WEBHOOK_URL` (avec le même en-tête
`x-shared-secret` si défini) à chaque événement :
`{ "event": "message" | "qr" | "connection-open" | "account-reset", "payload": {...} }`.
`payload` pour `"message"` est l'objet message brut Baileys ; pour `"qr"`,
`{ qr }` (chaîne brute, à convertir en image côté récepteur si besoin) ;
pour `"connection-open"` et `"account-reset"`, un objet vide (le simple
événement suffit).

## Ce que ce service NE fait PAS (hors périmètre volontaire)

Pas de multi-tenant, pas de gestion de licences, pas de cache de noms de
contacts, pas d'envoi de groupes/campagnes — tout cela reste dans
`adapters/whatsapp.js` côté backend principal. L'intégration complète (le
backend principal appelant ce micro-service au lieu de gérer Baileys
lui-même) est une étape ultérieure, non faite ici.
