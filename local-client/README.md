# Client local CYRUS (package PC installable, on-premise)

Projet **indépendant** du backend racine et de `server/` : son propre
`package.json`, jamais construit ni déployé sur le VPS. Chaque PC client
exécute sa propre instance : session WhatsApp (`whatsapp-web.js`/Puppeteer)
et base SQLite locale (`%APPDATA%\CyrusLocalClient\local.db`, via
`node:sqlite` — aucune compilation native requise).

**Décision du 2026-09-10 (demande explicite) : Firebase est la voie
PRINCIPALE pour tout ce qui n'est pas WhatsApp/données locales — licence, IA
(texte/image/vidéo), mise à jour — le VPS n'est plus qu'un repli optionnel
pour la licence/le texte/l'image (aucun repli VPS pour la vidéo ni la mise à
jour, jamais exposées côté VPS à ce client). Objectif : que ce client
continue de fonctionner intégralement même si le VPS disparaît
(impayé/résiliation).**

- **Licence** (`lib/license.js`) : Firebase (`verifyLicenseOffline`) en
  premier, VPS (`POST /api/auth/verify-key`) en repli si Firebase injoignable
  (panne réseau, pas un refus métier).
- **IA texte/image** (`lib/aiGateway.js`) : Firebase
  (`generateTextFallback`/`generateImageFallback`, cascade
  Groq/Gemini/OpenRouter/Hugging Face/Pollinations pour le texte,
  fal.ai/Pollinations pour l'image) en premier, VPS en repli.
- **IA vidéo** (image-to-video, `lib/aiGateway.js#startVideo`/`pollVideo`) :
  Firebase UNIQUEMENT (`startVideoFallback`/`pollVideoFallback`, job
  asynchrone persisté dans Firestore) — aucun équivalent VPS.
- **Mise à jour** (`lib/updateCheck.js`, `launcher.js`) : Firebase
  (`checkUpdateOffline`) en premier, VPS (`GET /api/check-update`) en repli.

Sans les variables `FIREBASE_*` configurées (voir `.env.example`), chaque
fonctionnalité retombe sur son seul comportement VPS historique — jamais de
plantage, juste moins de résilience.

Voir `../firebase-functions/README.md` pour la mise en place complète du
projet Firebase (nécessite un compte Google, je ne peux pas le faire à votre
place).

Aucun secret serveur (mots de passe admin, jetons GitHub, clés IA) n'entre
dans ce dossier — condition pour packager ce projet en `.exe` distribué à
des clients sans risque de fuite.

## Démarrage (développement)

```bash
cd local-client
npm install
cp .env.example .env   # renseignez LICENSE_KEY et VPS_BASE_URL (voir .env.example)
npm start
```

Le terminal affiche le QR code WhatsApp à scanner, et le navigateur par
défaut s'ouvre automatiquement sur `http://localhost:4100` (onglets Statut
/ Contacts / Campagnes).

## État actuel — ce qui marche déjà (testé en production le 2026-09-10)

- Connexion WhatsApp locale + QR code (`lib/whatsapp.js`).
- Licence, IA texte/image/vidéo, mise à jour : Firebase-first partout, voir
  ci-dessus — testé de bout en bout contre les Cloud Functions réelles
  (cascade IA, job vidéo, publication + application d'une mise à jour).
- Base SQLite locale : contacts, messages, **campagnes** — création,
  démarrage/pause/annulation, envoi séquentiel avec délai aléatoire,
  reprise automatique si la session WhatsApp se reconnecte
  (`lib/campaigns.js`, `lib/db.js`).
- Génération de livre PDF (`lib/pdf/ebookGenerator.js`, `pdfkit` — aucun
  réseau requis pour le rendu lui-même, seul le texte des chapitres passe
  par la cascade IA) via `POST /api/ebook/generate`.
- Dashboard avec import de contacts (CSV simple) et gestion de campagnes
  (`public/index.html`, `public/app.js`).
- **Packaging `.exe` en DEUX binaires** (voir "Mise à jour silencieuse"
  ci-dessous) : `npm run build:all` — testé, build réussi (~160 Mo pour
  l'app, ~320 Mo pour le lanceur — voir la note sur la taille plus bas).

## Mise à jour silencieuse (launcher.js)

Un exécutable Windows ne peut **jamais** être remplacé pendant qu'il tourne
(fichier verrouillé) — la solution retenue est un **lanceur séparé**
(`CyrusLauncher.exe`) que l'utilisateur installe/épingle/lance au quotidien,
et qui gère l'app réelle (`cyrus-local-client.exe`) comme un fichier qu'il
peut librement remplacer AVANT de la démarrer :

1. Au lancement, `CyrusLauncher.exe` interroge `checkUpdateOffline`
   (Firestore `config/local-client`) et compare à la version actuellement
   installée dans `%APPDATA%\CyrusLocalClient\app\version.txt`.
2. Si une version plus récente existe : téléchargement dans un fichier
   temporaire, vérification SHA-256 (si fournie), puis remplacement
   atomique (`fs.renameSync`, même volume) — jamais d'exe à moitié écrit en
   cas de coupure réseau.
3. Le lanceur démarre ensuite l'app (à jour ou non selon le résultat), avec
   sa console héritée (`stdio: 'inherit'`) — invisible dans le flux pour
   l'utilisateur, pas une étape perceptible en plus.
4. Toute panne à n'importe quelle étape (réseau coupé, Firebase ET VPS
   injoignables, téléchargement interrompu, somme de contrôle invalide) ne
   bloque JAMAIS le démarrage — l'app existante démarre telle quelle.

**Limite acceptée** : la mise à jour n'est vérifiée qu'AU LANCEMENT, jamais
en cours de session — une session laissée ouverte plusieurs jours n'est mise
à jour qu'au prochain redémarrage (comportement standard, comparable à VS
Code/Discord/etc.).

**Le lanceur lui-même n'est jamais auto-mis-à-jour** (seule l'app qu'il gère
l'est) — changer sa propre logique doit rester rare, et publier une nouvelle
version du lanceur nécessite de redistribuer manuellement
`CyrusLauncher.exe` aux clients existants.

### Publier une nouvelle version de l'app

```bash
cd local-client
# 1. Incrémenter "version" dans package.json (ex: 1.0.0 -> 1.1.0)
npm run build:exe   # régénère dist/cyrus-local-client.exe

# 2. Calculer la somme de contrôle (PowerShell) :
#    Get-FileHash dist\cyrus-local-client.exe -Algorithm SHA256

# 3. Uploader l'exe dans Firebase Storage (chemin libre, mais gardez le
#    préfixe "local-client-releases/" par convention) :
gcloud storage cp dist/cyrus-local-client.exe \
  gs://rien-afrique.firebasestorage.app/local-client-releases/cyrus-local-client-v1.1.0.exe \
  --project=rien-afrique

# 4. Publier les métadonnées (ADMIN_SECRET requis, voir
#    firebase functions:secrets:access ADMIN_SECRET) :
curl -X POST https://us-central1-rien-afrique.cloudfunctions.net/publishUpdateOffline \
  -H "Content-Type: application/json" -H "x-admin-secret: <ADMIN_SECRET>" \
  -d '{"version":"1.1.0","storagePath":"local-client-releases/cyrus-local-client-v1.1.0.exe","notes":"...","sha256":"<hash de l'\''étape 2>"}'
```

Chaque client déjà installé récupère automatiquement cette version au
prochain lancement — aucune recompilation ni redéploiement de leur côté,
aucune action de leur part.

**Note taille** : `CyrusLauncher.exe` (~320 Mo) embarque actuellement
l'intégralité de `node_modules` (whatsapp-web.js/puppeteer compris) au lieu
de se limiter à ses propres dépendances (axios/dotenv) — `pkg` ne fait pas
de tree-shaking par point d'entrée à partir d'un `package.json` partagé.
Sans impact fonctionnel (le lanceur marche correctement), mais un chantier
futur légitime serait de l'isoler dans son propre `package.json` minimal
(sous-dossier dédié) pour un lanceur réellement léger.

## Ce qu'il reste à faire

1. **Distribuer `CyrusLauncher.exe`** aux premiers clients (canal à définir
   — ce n'est pas encore fait, seul le mécanisme est construit et testé).
2. **Alléger `CyrusLauncher.exe`** (voir note taille ci-dessus) — cosmétique,
   pas bloquant.
3. **Interface plus complète** — import CSV réel (fichier, pas juste
   copier-coller), historique des messages par contact dans le dashboard,
   bouton dédié pour la génération de livre PDF (actuellement accessible
   uniquement via `POST /api/ebook/generate`, pas encore dans l'UI).
