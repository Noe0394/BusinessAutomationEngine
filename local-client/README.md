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
- **Packaging `.exe` en UN SEUL binaire** (voir "Mise à jour silencieuse"
  ci-dessous) : `npm run build:exe` — testé, build réussi (~160 Mo).

## Mise à jour silencieuse (lib/selfUpdate.js)

Un exécutable Windows ne peut **jamais** être remplacé pendant qu'il tourne
(fichier verrouillé). **Un seul exécutable est distribué** (pas de second
programme à installer, sur retour explicite de l'utilisateur) : l'app se
met à jour ELLE-MÊME en s'appuyant sur un script système jetable — généré
à la volée dans un dossier temporaire, exécuté une fois, jamais distribué —
plutôt qu'un second binaire compilé et installé séparément :

1. Tout en tout début de démarrage (`index.js#main`, avant même la
   vérification de licence), `checkAndSelfUpdate()` interroge
   `checkUpdateOffline` (Firestore `config/local-client`) et compare à sa
   propre version (`package.json`).
2. Si une version plus récente existe : téléchargement dans
   `<chemin-de-l'exe>.new`, vérification SHA-256 (si fournie).
3. Un script `.bat` jetable est généré dans le dossier temporaire système,
   puis lancé en arrière-plan (détaché) : il attend que CE process libère
   le verrou sur son propre fichier exe (`move` réessayé jusqu'à 20 fois,
   ~1s d'intervalle), le remplace, relance l'app à jour, puis se supprime
   lui-même.
4. Le process courant appelle `process.exit(0)` juste après avoir lancé ce
   script — l'utilisateur voit l'app se refermer puis se rouvrir
   immédiatement (quelques secondes), sans jamais avoir à retélécharger ou
   réinstaller quoi que ce soit lui-même.
5. Toute panne à n'importe quelle étape (réseau coupé, Firebase ET VPS
   injoignables, téléchargement interrompu, somme de contrôle invalide) ne
   bloque JAMAIS le démarrage — l'app continue avec sa version actuelle.
6. **Ne s'active qu'en exécutable packagé** (`process.pkg`, injecté par
   `pkg`) — en développement (`node index.js`), remplacer
   `process.execPath` remplacerait le binaire `node` lui-même : un simple
   avertissement informatif s'affiche à la place, sans jamais rien
   télécharger ni remplacer.

**Limite acceptée** : la mise à jour n'est vérifiée qu'AU DÉMARRAGE, jamais
en cours de session — une session laissée ouverte plusieurs jours n'est mise
à jour qu'au prochain redémarrage (comportement standard, comparable à VS
Code/Discord/etc.).

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
aucune action de leur part, et rien à installer en plus de l'exe qu'ils ont
déjà.

## Ce qu'il reste à faire

1. **Distribuer `cyrus-local-client.exe`** aux premiers clients (canal à
   définir — ce n'est pas encore fait, seul le mécanisme est construit).
2. **Interface plus complète** — import CSV réel (fichier, pas juste
   copier-coller), historique des messages par contact dans le dashboard,
   bouton dédié pour la génération de livre PDF (actuellement accessible
   uniquement via `POST /api/ebook/generate`, pas encore dans l'UI).
