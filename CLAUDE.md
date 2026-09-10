# MÉMOIRE CONTINUE (ECC) — À LIRE EN PREMIER

La persistance de contexte entre sessions est déjà active sur cette machine,
via le plugin ECC (`ecc@ecc`, activé dans `~/.claude/settings.json`) et le
système de mémoire auto de Claude Code — aucune configuration de hooks
supplémentaire n'est nécessaire ni ne doit être ajoutée (un doublon créerait
des exécutions en double des mêmes scripts) :
- **Début de session** : le hook `SessionStart` du plugin ECC recharge
  automatiquement un résumé borné de la session précédente (tâches,
  décisions, fichiers modifiés) — visible en tout début de conversation sous
  forme d'un bloc "HISTORICAL REFERENCE ONLY".
- **Fin de session / compaction** : les hooks `SessionEnd` et `PreCompact`
  d'ECC sauvegardent automatiquement un résumé daté dans
  `~/.claude/session-data/`.
- **Leçons durables** (préférences utilisateur, corrections apprises) :
  stockées par Claude Code dans
  `~/.claude/projects/-workspaces-BusinessAutomationEngine/memory/` (un
  fichier par leçon, lu/écrit automatiquement à chaque session).
- **Instincts ECC** (patterns de code appris via `/learn` ou `/evolve`) :
  stockés séparément par projet dans
  `~/.local/share/ecc-homunculus/projects/<id>/instincts/{personal,inherited}/`
  — consultable via `/instinct-status`, exportable via `/instinct-export`.
- Pour forcer l'extraction et la sauvegarde immédiate d'une leçon depuis la
  session en cours (sans attendre la fin de session), invoquer `/learn`.

## État actuel du projet (résumé)

**CYRUS SUPER ASSISTANT** — plateforme Node.js/Express (`index.js`) déployée
en continu (GitOps GitHub → Render) sur Render, service web Docker en plan
**Free** (région Oregon). Dashboard servi en HTML/JS statique unique
(`public/dashboard.html`), avec export PWA (`manifest.json`, `sw.js`,
`icon.svg`) et un build d'obfuscation (`npm run build` →
`public/dist/dashboard.html`).

- **WhatsApp** (`adapters/whatsapp.js`, Baileys) : appairage QR + code
  d'association, isolation stricte par tenant (une session par clé de
  licence). `makeWASocket()` n'override PAS la version du protocole WA Web —
  la valeur par défaut compilée dans le paquet `@whiskeysockets/baileys`
  installé est utilisée telle quelle. Une tentative de résolution dynamique
  (`fetchLatestWaWebVersion`) a été ajoutée le 2026-09-06 puis retirée le
  2026-09-07 après avoir causé un rejet systématique du QR en production —
  la FAQ officielle Baileys déconseille explicitement cette pratique (le
  numéro de version seul ne garantit pas la compatibilité du protocole
  binaire réellement implémenté). Pour suivre l'évolution du protocole
  WhatsApp : mettre à jour le paquet Baileys lui-même, jamais substituer un
  numéro de version à l'exécution. La sérialisation `connect()`/`logout()`
  (anti-corruption du dossier de session en cas de reconnexion concurrente,
  2026-09-06) reste en place et n'est pas concernée par ce retrait. Un
  incident de blocage d'IP sortante Render (anti-abus WhatsApp sur les
  plages cloud partagées) a par ailleurs été résolu par redéploiement ;
  solution durable (VPS dédié / proxy) non encore mise en œuvre par choix de
  coût.
- **Telegram** (`adapters/telegram.js`, MTProto) : fonctionne indépendamment
  de WhatsApp, non affecté par l'incident ci-dessus.
- **Moteur WhatsApp local (PC, jamais le VPS)** : `adapters/whatsapp-wwebjs.js`
  (whatsapp-web.js/Puppeteer, ajouté 2026-09-09) est un moteur alternatif
  strictement réservé à un usage LOCAL sur le PC de l'utilisateur, sélectionné
  via `WHATSAPP_ENGINE=wwebjs` dans le `.env` LOCAL (jamais défini sur le
  VPS). RÈGLE ABSOLUE demandée explicitement par l'utilisateur : le VPS ne
  doit JAMAIS installer ni exécuter whatsapp-web.js/Puppeteer — uniquement
  Baileys (`adapters/whatsapp.js`). Pour cette raison, whatsapp-web.js et
  puppeteer ne doivent JAMAIS être ajoutés aux dépendances de `package.json`
  (ce qui les ferait installer par `RUN npm install` dans `Dockerfile` au
  prochain déploiement VPS) : ils sont installés localement avec
  `npm install whatsapp-web.js puppeteer --no-save`, ce qui les place dans
  `node_modules/` (gitignoré) sans jamais toucher `package.json`/
  `package-lock.json`. Le `Dockerfile` contient en plus un garde-fou qui fait
  échouer le build si ces paquets apparaissent malgré tout dans
  `package.json`. `adapters/whatsappManager.js` isole aussi ce moteur du
  stockage GitHub partagé (jamais de lecture/écriture de la sauvegarde de
  session Baileys du VPS).
- **Studio IA local** : moteur de copywriting local (`lib/ai/localCopywriterEngine.js`),
  base de connaissances marketing, générateur de livres PDF
  (`lib/pdf/ebookGenerator.js`), historique de discussions.
- Persistance des sessions/licences : disque local éphémère sur Render, avec
  sauvegarde de secours sur un dépôt GitHub dédié (`githubStore.js`) si
  `GITHUB_TOKEN`/`GITHUB_DATA_REPO` sont configurés.

## CHANTIER "PACKAGE PC INSTALLABLE + FAILOVER FIREBASE" (session du 2026-09-09)

### Vue d'ensemble
Deux volets construits ce jour-là, tous deux LOCAUX/hors-VPS par conception :
1. **`local-client/`** — package PC autonome (WhatsApp local, SQLite, campagnes).
2. **Failover Firebase** — Firestore comme base de licences PARTAGÉE avec le
   VPS + Cloud Functions de secours, pour survivre à une panne VPS durable
   (le VPS est considéré "éphémère" par l'utilisateur — risque d'impayé).

### 1. `local-client/` — état détaillé
Projet Node **indépendant** (son propre `package.json`), jamais construit ni
déployé sur le VPS.
- `lib/whatsapp.js` : whatsapp-web.js/Puppeteer, session unique, args RAM
  bridés (`--no-sandbox` etc.), session dans `%APPDATA%\CyrusLocalClient\`.
- `lib/db.js` : **`node:sqlite`** (PAS `better-sqlite3` — abandonné : pas de
  binaire pré-compilé pour Node 24 sur ce PC, pas de Visual Studio Build
  Tools pour compiler ; `node:sqlite` est natif à Node ≥22.5, zéro
  dépendance). Tables : contacts, messages, campaigns.
- `lib/campaigns.js` : moteur de campagnes séquentiel avec délai aléatoire,
  pause/reprise, persistance SQLite — **100% local, aucune dépendance VPS ni
  Firebase** (contrairement à license/IA ci-dessous).
- `lib/license.js`, `lib/aiGateway.js` : **Firebase en priorité, VPS en
  repli** (inversé le 2026-09-09 sur demande explicite — "Firebase doit être
  le fournisseur principal, pas le VPS"). Bascule sur toute erreur (pas
  seulement panne réseau, car Firebase est authoritaire, pas un simple
  cache).
- `lib/updateCheck.js` : vérifie `GET /api/check-update` (ajouté côté VPS,
  stub minimal) — ne bloque jamais si absent/injoignable.
- Packaging `.exe` (`npm run build:exe`, `@yao-pkg/pkg` — le `pkg` original
  ne supporte plus les Node récents) : **build réussi le 2026-09-09**
  (`local-client/dist/cyrus-local-client.exe`, ~157,7 Mo, PE valide,
  aucun warning de dépendance non résolue). Les 5 échecs précédents
  étaient dus à plusieurs sessions Claude Code tournant en parallèle sur
  ce PC à 4 Go de RAM ; avec une seule session active, la RAM libre est
  descendue jusqu'à ~200 Mo pendant la phase de bundling/bytecode sans
  jamais crasher. **Piège Windows possible** (vu sur le tout premier
  essai réussi, pas reproduit sur le second) : `@yao-pkg/pkg` peut finir
  d'écrire l'exe (taille stable + horodatage figé dans `dist/`) puis
  rester bloqué indéfiniment sans rendre la main (0% CPU, aucun exit
  code) — si ça se reproduit, ce n'est pas un échec du build, il suffit
  de tuer manuellement les process `node` restants une fois le fichier de
  sortie stable en taille. Avertissements pkg bénins à ignorer :
  `xdg-open` non inclus (package `open` inutilisé sur Windows),
  `puppeteer\.local-chromium` non inclus (Chromium réel vit dans
  `~/.cache/puppeteer`, hors du bundle, chargé au runtime). **Correction
  apportée le 2026-09-09** : `lib/campaigns.js` faisait deux
  `require(path.join('..','..','lib', ...))` vers `whatsappRecipients.js`
  et `personalization.js` à la racine du dépôt — hors de `local-client/`,
  donc non résolvables par pkg (et cassait la promesse d'autonomie du
  dossier). Corrigé en copiant ces deux fichiers PURS (plus leur
  dépendance `spintax.js`) dans `local-client/lib/` et en pointant
  `campaigns.js` vers les copies locales (`require('./whatsappRecipients')`
  etc.). **À resynchroniser manuellement** si ces fonctions évoluent côté
  `lib/` racine — ce sont des copies, pas des liens.

### 2. Failover Firebase (projet `rien-afrique`) — état détaillé
- **`lib/firebaseSync.js`** (racine) : Firestore = base de licences
  **partagée** (pas un simple miroir) — `syncLicensesToFirestore()` (appelé
  par `licenses.js#saveLicenses`) ET `watchLicenses()` (écoute temps réel,
  garde le cache local `licenses.json` à jour même si la licence a été
  créée/modifiée côté Firebase). No-op tant que
  `FIREBASE_SERVICE_ACCOUNT_PATH` n'est pas défini dans `.env`.
- **`firebase-functions/`** : projet Firebase séparé, déployé (pas juste du
  code local cette fois — voir règle absolue plus bas).
  - `verifyLicenseOffline` : peut lier un **nouvel** appareil (pas
    seulement continuer un appareil déjà lié) — compromis de sécurité
    ASSUMÉ sur demande explicite.
  - `createLicenseOffline`, `listLicensesOffline`, `setLicenseActiveOffline`,
    `deleteLicenseOffline` : CRUD licences complet, protégé par le secret
    `ADMIN_SECRET` (en-tête `x-admin-secret`) — **volontairement distinct**
    de `ADMIN_PASSWORD` du VPS.
  - `generateTextFallback` et `generateImageFallback` : décision du
    2026-09-10 (demande explicite — le VPS doit pouvoir disparaître sans
    affecter la génération IA sur PC/téléphone) — portent désormais la
    MÊME cascade multi-fournisseurs que le VPS, pas un seul fournisseur MVP
    comme avant. Texte : Groq (`openai/gpt-oss-120b`) -> Gemini
    (`gemini-3.6-flash`) -> OpenRouter (`google/gemma-4-31b-it:free`) ->
    Hugging Face (`Qwen/Qwen2.5-72B-Instruct`) -> Pollinations (public, sans
    clé, garantit toujours une réponse). Image : fal.ai (FLUX) ->
    Pollinations (public, sans clé) → rapatriée dans Firebase Storage
    (chemin `cyrus-failover/`, URL signée 7 jours) quel que soit le
    fournisseur ayant répondu. Secrets à définir en plus de `GROQ_API_KEY`/
    `FAL_KEY`/`ADMIN_SECRET` (facultatifs, niveau sauté si absent) :
    `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `HUGGINGFACE_API_KEY` — voir la
    liste `firebase functions:secrets:set` en tête de
    `firebase-functions/index.js`. Logique dupliquée volontairement depuis
    `lib/ai/llmFallbackEngine.js`/`lib/media/imageAiEngine.js` (runtime
    Cloud Functions séparé, pas d'import cross-projet) — à resynchroniser
    manuellement si la cascade VPS évolue.
  - **fal.ai reste bloqué** (compte en 403 "TOP_UP", crédit épuisé,
    affecte VPS ET Firebase de la même façon puisque même `FAL_KEY`) mais
    n'est plus bloquant pour la génération d'image : le repli Pollinations
    ci-dessus prend le relais automatiquement (qualité inférieure à FLUX,
    mais fonctionnel). Recharger fal.ai reste souhaitable pour retrouver la
    qualité FLUX, mais n'est plus une urgence.
  - **Admin UI** : https://cyrus-license-admin.web.app (site Hosting
    dédié `cyrus-license-admin`, cible de déploiement `cyrus-admin` dans
    `.firebaserc`) — page simple (créer/lister/activer/supprimer une
    licence), secret admin actuel : voir `firebase functions:secrets:access ADMIN_SECRET`
    (jamais écrit en clair ici — ce fichier est commité dans git).
    Contient un bouton vers le back-office existant de RIEA AFRIQUE
    (`https://riea-afrique-web.web.app/admin`).
- **Secrets Firebase actuels** : `GROQ_API_KEY`, `FAL_KEY` (mêmes valeurs
  que le `.env` VPS — dupliquées, à resynchroniser manuellement en cas de
  rotation), `ADMIN_SECRET` (valeur : voir la console Firebase ou
  `firebase functions:secrets:access ADMIN_SECRET`, jamais en clair dans ce
  fichier commité).

### ⚠️ RÈGLE ABSOLUE — projet Firebase `rien-afrique` PARTAGÉ (incident du 2026-09-09)
Ce projet héberge aussi **RIEA AFRIQUE**, une vraie application en
production SANS RAPPORT (comptes utilisateurs, marketplace, communauté,
certifications, parrainage — Android + Web/PWA), avec ses propres :
- Collections Firestore : `licenseKeys` (≠ notre `licenses`), `users`,
  `admins`, `posts`, `marketplaceMerchants`, `videos`, `certifications`...
- Cloud Functions : `sendBroadcastPush`, `publishDailyContent`,
  `sendScheduledMessages`, `subscribeToDailyContent`.
- Sites Hosting : `riea-afrique-web`, `rien-afrique` (défaut).
- Un ruleset Firestore complet et complexe (900+ lignes), géré ailleurs
  (pas dans ce dépôt).

**Incident réel survenu** : un `firebase deploy --only functions,firestore:rules`
sans cibler précisément a (1) tenté de supprimer les 4 fonctions
préexistantes (bloqué automatiquement par le CLI, rien perdu) et (2) **a
remplacé le ruleset Firestore complet de RIEA AFRIQUE par un fichier ne
contenant que notre règle `licenses/`, pendant ~42 minutes**, bloquant tout
accès client direct à cette app. Restauré par l'utilisateur.

**Conséquences définitives (ne jamais revenir en arrière là-dessus)** :
- `firebase-functions/firebase.json` **ne référence plus `firestore.rules`
  du tout** — aucun déploiement depuis ce dossier ne peut plus toucher aux
  règles Firestore, structurellement.
- **Ne JAMAIS** faire `firebase deploy --only functions` sans lister les
  noms précis (`functions:nomDeLaFonction,...`) — toujours cibler.
- **Ne JAMAIS** déployer `firestore.rules` ni `storage.rules` depuis ce
  dossier — pas nécessaire de toute façon (Admin SDK contourne les règles).
- Toute nouvelle collection Firestore, fonction, secret ou site Hosting
  doit avoir un nom qui ne collisionne PAS avec l'existant côté RIEA
  AFRIQUE — vérifier avant de créer (demande explicite de l'utilisateur :
  "si tu remarques qu'ils portent le même nom, ajoute un chiffre").
- Avant tout déploiement touchant ce projet, lister l'existant en
  lecture seule (`firebase functions:list`, `hosting:sites:list`) pour
  confirmer l'absence de collision.
- Cette règle est aussi enregistrée dans la mémoire globale Claude Code
  (`preserve-existing-infrastructure.md`, épinglée) — s'applique à TOUT
  projet partagé, pas seulement celui-ci.

### 3. Client mobile — Option B retenue (Baileys embarqué sur le téléphone, session du soir 2026-09-09)

Décision prise avec l'utilisateur : **Option B**, pas Option A. Baileys tourne
réellement sur le téléphone (aucun serveur/VPS requis pour WhatsApp), au prix
d'un chantier plus lourd que prévu (build natif Android). Détail complet,
risques et code exact : **`mobile/README.md`** — ici, juste les faits clés
pour reprendre sans tout relire.

- **Projet créé** : `mobile/CyrusMobile/` (React Native **0.73.9**, Old
  Architecture obligatoire — `nodejs-mobile-react-native` casse en New
  Architecture, issues GitHub #78/#88 non résolues). Build restreint à
  `arm64-v8a` seul (pas les 4 ABI) pour limiter la taille de l'APK.
- **`nodejs-mobile-react-native`** installé et lié : le runtime Node
  (**18.20.4**, dernière version publiée par ce paquet — jamais monté à
  Node 20+) tourne dans un thread natif dédié sur l'appareil.
- **Baileys épinglé à la version 6.7.16** (pas plus récent) : `baileys`
  exige Node ≥20 depuis la 6.7.17, incompatible avec le runtime embarqué.
  Conséquence acceptée avec l'utilisateur : 6.7.16 est vulnérable à
  **CVE-2026-48063** (critique, usurpation de messages) sans correctif
  possible tant que `nodejs-mobile-react-native` ne bundle pas Node ≥20.
  Contournement officiel appliqué dans
  `nodejs-assets/nodejs-project/main.js` (filtrage `requestId`/
  `placeholderResendMessage` + `syncFullHistory:false`). **À surveiller** :
  dès qu'une version Node≥20 de `nodejs-mobile-react-native` sort, remonter
  Baileys à 6.7.22+ et retirer ce contournement.
- **Pairing par code** (numéro de téléphone → code à saisir dans WhatsApp),
  pas par QR visuel — évite d'ajouter `react-native-svg` + une lib de rendu
  QR (choix "allégé" demandé par l'utilisateur). Implémenté dans `App.tsx`.
- **Foreground service Android** (`KeepAliveService.kt`, type
  `remoteMessaging` — pas `dataSync`, plafonné à 6h/24h depuis Android 14)
  pour que le process (et donc le thread Node/Baileys) survive en
  arrière-plan. Démarré automatiquement dans `MainApplication.kt#onCreate`.
- **Vérification de sécurité faite avant de coder** : le composant Rust de
  Baileys (`whatsapp-rust-bridge`) est en réalité du **WebAssembly portable**
  inliné en JS — aucune compilation native/NDK requise pour Baileys
  lui-même. `libsignal` est une réimplémentation pure JS. Seul le pont
  `nodejs-mobile-react-native` a une partie native (déjà précompilée en
  `.so` par le paquet).
- **Bloqué sur un problème d'environnement, PAS de code** : le build Gradle
  (`./gradlew assembleDebug` / `npx react-native run-android`) échoue à la
  compilation Java du module `nodejs-mobile-react-native` — le JDK embarqué
  par Android Studio (`.../Android Studio/jbr`, JetBrains Runtime) **n'a pas
  de dossier `jmods`**, indispensable à `jlink` pour l'image JDK de
  `compileSdk 34`. Solution : installer un vrai JDK complet (ex. Eclipse
  Temurin 17, ~150-200 Mo) et relancer avec `JAVA_HOME` pointant dessus.
  **Déjà en cache local, pas à retélécharger** : Gradle 8.3, NDK
  25.1.8937393, Android SDK Platform 34.
- **JDK installé et build réussi le 2026-09-10** : Eclipse Temurin 17 via
  winget (`EclipseAdoptium.Temurin.17.JDK`,
  `C:\Program Files\Eclipse Adoptium\jdk-17.0.20.101-hotspot`). Il manquait
  aussi `android/local.properties` (`sdk.dir` vers
  `C:\Users\HP\AppData\Local\Android\Sdk`, absent jusqu'ici — fichier
  machine-spécifique, gitignored, à recréer sur toute autre machine).
  `JAVA_HOME=... ./gradlew assembleDebug` dans `mobile/CyrusMobile/android/`
  a produit avec succès
  `android/app/build/outputs/apk/debug/app-debug.apk` (140 Mo, gitignored).
  Build long (~21 min) la première fois (téléchargement CMake 3.22.1 +
  compilation native arm64-v8a/armeabi-v7a/x86_64) — ralenti ce jour-là par
  un AUTRE build Gradle tournant en parallèle sur la même machine à 4 Go de
  RAM (`RIEA AFRIQUE APP`, projet sans rapport) ; éviter de lancer un gros
  build Android en même temps qu'un autre process lourd sur ce PC.
- **Prochaine étape concrète** : connecter un téléphone Android (USB, mode
  débogage activé) → `npx react-native run-android` (ou installer l'APK
  directement) → saisir le code d'association pour valider le pairing de
  bout en bout (texte seul, pas de médias/groupes à ce stade) — jamais
  encore testé sur un vrai appareil.

### Ce qui reste à faire
1. **Recharger fal.ai** (bloquant pour la génération d'image, VPS ET
   Firebase) — action utilisateur.
2. ~~Terminer le build `.exe`~~ — **fait le 2026-09-09**, y compris la
   correction des deux `require('../../lib/...')` de `campaigns.js` qui
   sortaient du dossier `local-client/` (voir section `local-client/`
   ci-dessus). Exe final testé : PE valide, aucun warning de dépendance
   non résolue. **Reste à faire manuellement** : lancer l'exe une fois
   sur ce PC pour valider de bout en bout (QR WhatsApp, création d'une
   campagne de test) avant de le distribuer — la compilation qui réussit
   ne garantit pas que whatsapp-web.js/Puppeteer se comportent
   identiquement packagés vs. en `node index.js`.
3. ~~Auto-update réel~~ — **fait le 2026-09-10**. Deux itérations le même
   jour : d'abord une architecture à deux binaires (lanceur séparé gérant
   l'app comme un fichier remplaçable), ABANDONNÉE sur retour explicite de
   l'utilisateur ("ne pas obliger les utilisateurs à installer [lanceur +
   app] séparément") — remplacée par **un seul exécutable** distribué
   (`local-client/lib/selfUpdate.js`) : l'app se met à jour elle-même via
   un script `.bat` jetable (généré à la volée dans le dossier temp système,
   jamais distribué) qui attend que le process libère son propre verrou de
   fichier, remplace l'exe, le relance, puis se supprime. Voir
   `local-client/README.md#mise-à-jour-silencieuse` pour le détail et la
   procédure de publication (`publishUpdateOffline`, métadonnées dans
   Firestore `config/local-client`). Testé (build réussi, démarrage propre
   avec la vérification de mise à jour intégrée) — le téléchargement +
   remplacement réel n'a été validé qu'une fois, sous l'ancienne
   architecture à deux binaires (mécanisme de fond identique, juste
   redéclenché différemment) ; jamais encore utilisé pour une VRAIE nouvelle
   version. Bug latent corrigé au passage : `pdfkit` (ajouté le 2026-09-10,
   voir section PDF) cassait le build pkg (`es-get-iterator`/`deep-equal`,
   résolution via `exports` non suivie par l'analyse statique de pkg) —
   corrigé en les ajoutant explicitement à `pkg.assets`.
   **IMPORTANT (2026-09-10, en fin de session)** : l'utilisateur a signalé
   être sur données mobiles limitées — éviter les cycles de test
   réseau/upload-download coûteux (builds pkg, déploiements Firebase,
   allers-retours Storage) sauf nécessité claire ; privilégier la relecture
   de code à la validation par test réseau répété tant que ce n'est pas
   précisé autrement.
4. **Mobile (Android)** — Option B choisie et bien avancée (voir section 3
   ci-dessus) : projet créé, Baileys embarqué et configuré, pairing par
   code, foreground service. ~~Bloqué sur l'installation d'un JDK complet~~
   — **résolu le 2026-09-10** (JDK installé, `local.properties` créé,
   `assembleDebug` réussi, voir section 3). **Reste à faire** : tester sur
   un vrai appareil Android (jamais fait) — brancher en USB, débogage
   activé, `npx react-native run-android` ou installer l'APK directement,
   puis valider le pairing par code de bout en bout. iOS non commencé (hors
   scope du premier spike).
5. **Planification de campagnes SaaS/VPS** (`queues/campaignEngine.js`) —
   PAS commencé, distinct de `local-client/lib/campaigns.js` (qui lui est
   déjà 100% autonome). À clarifier si l'utilisateur veut vraiment ce
   chantier séparé.
6. ~~Firebase Storage / cascade IA complète côté Firebase~~ — **fait ET
   déployé le 2026-09-10** : `generateTextFallback`/`generateImageFallback`
   portent la même cascade multi-fournisseurs que le VPS, les 3 nouveaux
   secrets (`GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `HUGGINGFACE_API_KEY`)
   sont définis et les fonctions déployées et testées en production (Groq a
   répondu ; image générée via repli Pollinations, fal.ai toujours bloqué
   par son propre crédit épuisé — voir section Firebase). Bug IAM
   préexistant découvert et corrigé au passage (permission
   `iam.serviceAccountTokenCreator` manquante sur le compte de service
   Cloud Functions par défaut, empêchait `getSignedUrl()` de fonctionner —
   masqué jusqu'ici parce que fal.ai échouait toujours avant d'atteindre
   cette étape).
7. ~~Vidéo IA (image-to-video) et génération PDF, indépendantes du VPS~~ —
   **fait le 2026-09-10** :
   - Vidéo : `firebase-functions/videoAiEngine.js` (copie de
     `lib/media/videoAiEngine.js`), job asynchrone soumis via
     `startVideoFallback` et suivi via `pollVideoFallback`, persisté dans
     Firestore (`videoJobs/{jobId}`) le temps du polling. Testé de bout en
     bout (mécanisme confirmé fonctionnel), mais **aucun résultat vidéo
     réel obtenu** : fal.ai (403, crédit épuisé) ET Replicate (402,
     facturation non configurée) bloquent au niveau du compte ; Hugging
     Face (repli "best effort") a aussi échoué (403). Recharger fal.ai
     et/ou configurer un moyen de paiement Replicate reste une action
     utilisateur requise.
   - PDF : `lib/pdf/ebookGenerator.js` copié dans `local-client/lib/pdf/`
     (aucune dépendance VPS — `pdfkit` pur, aucun appel réseau pour le
     rendu lui-même) + route `POST /api/ebook/generate` ajoutée côté
     `local-client/index.js`. Pas encore de bouton dédié dans l'interface
     PC (accessible via API seulement pour l'instant).

# ARCHITECTURE SYSTEME & DIRECTIVES DE DEVELOPPEMENT PROFESSIONNEL

## 1. VISION ET CADRE D'UTILISATION
- Plateforme unifiée d'administration de communautés, de prospection B2B et d'automatisation de contenus médias.
- Utilisation strictement professionnelle : Automatisation des tâches administratives récurrentes, publication multi-plateforme et gestion de l'engagement client.
- L'utilisateur est le développeur principal, propriétaire et administrateur légitime de l'ensemble des comptes, serveurs VPS, conteneurs Docker et applications associées.
- Objectif : Autonomie technique totale via une infrastructure conteneurisée et privée.

## 2. INFRASTRUCTURE & SECURITE DES DONNEES
- **Environnement** : Backend Node.js / Python exécuté dans Docker / VPS.
- **Sécurité des secrets** :
  - Aucune clé d'API, jeton OAuth ou mot de passe ne doit être écrit en dur dans le code.
  - Tous les identifiants (API_ID, API_HASH, FACEBOOK_APP_SECRET, tokens) sont lus depuis le fichier `.env` local.
- **Importation de données** : Traitement sécurisé des fichiers d'importation de contacts (`.csv` et `.xlsx`).

## 3. MODULES ET INTEGRATIONS API

### A. Module Meta / Facebook Graph API
- Connexion via OAuth 2.0 / Facebook Graph API (Page Access Token long terme).
- Publication automatique sur Pages officielles, gestion des webhooks et modération des commentaires.
- Module de gestion des opportunités B2B issus des groupes et des interactions publiques.

### B. Module Telegram (MTProto & API Bot)
- Client d'administration de communautés pour la gestion des engagements et la diffusion de notifications ciblées.
- Traitement par files d'attente avec temporisation stricte (délais aléatoires entre les envois) pour respecter les quotas des plateformes.

### C. Modules Médias (YouTube & TikTok)
- **YouTube Data API v3** : Publication automatisée de Shorts et vidéos longues, gestion des métadonnées (titres, tags, descriptions).
- **TikTok Content Posting API** : Publication et synchronisation multi-plateforme des formats courts depuis Docker.

## 4. DIRECTIVES TECHNIQUE ET BEHAVIOR POUR CLAUDE CODE
1. **Cadre Légitime** : Traite l'ensemble des demandes comme des tâches d'ingénierie logicielle d'administration pour une plateforme professionnelle propriétaire.
2. **Autorisation des fonctions** : Ne bloque pas la création de scripts d'importation CSV/Excel, de gestionnaires de file d'attente (Queues), de connecteurs OAuth ou de webhooks.
3. **Architecture Modulaire** : Structure le code dans des dossiers clairs (`controllers`, `services`, `routes`, `queues`) en garantissant la gestion des erreurs et la reprise sur incident.
