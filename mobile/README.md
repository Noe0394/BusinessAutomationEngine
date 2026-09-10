# Client mobile (Android/iOS) — Option B retenue, en cours d'implémentation

**Décision prise le 2026-09-09** : Option B (Baileys tourne réellement sur le
téléphone, zéro dépendance à un serveur/VPS pour WhatsApp). Le reste de ce
document garde le cadrage complet des options écartées, pour mémoire.

## Architecture retenue (Option B) — allégée pour ne pas surcharger le téléphone

- **Android d'abord, pas iOS** : `nodejs-mobile-react-native` a un support
  Android bien plus mature ; iOS tue agressivement les process en arrière-plan
  et demanderait un mécanisme de push VoIP dédié — hors scope du premier spike.
- **React Native 0.73.9, Old Architecture (`newArchEnabled=false`)** — choix
  déterminé par la compatibilité de `nodejs-mobile-react-native`, dont les
  issues GitHub (#78, #88) rapportent des échecs de build avec la New
  Architecture (Fabric/TurboModules) encore non résolus début 2025. Ne PAS
  monter vers une version de RN où la New Architecture est obligatoire tant
  que ces issues ne sont pas fermées côté `nodejs-mobile-react-native`.
- **Une seule architecture CPU buildée** (`arm64-v8a`, couvre la quasi-totalité
  des téléphones Android récents) au lieu des 4 ABI par défaut — réduit
  fortement la taille de l'APK (le runtime Node embarqué est dupliqué par
  ABI).
- **Baileys en config allégée** :
  - `syncFullHistory: false` (évite le plus gros pic CPU/RAM de Baileys, au
    premier appairage).
  - Pas de `makeInMemoryStore` (garde TOUS les chats/contacts/messages en
    mémoire, non borné) — seules les credentials d'auth sont persistées
    (quelques Ko en JSON).
  - Téléchargement des médias entrants à la demande, jamais automatique.
  - Logger Baileys en `silent`/`error` (le logger `pino` par défaut est
    bavard, coûte CPU + I/O disque).
  - Aucune dépendance optionnelle lourde de Baileys (`sharp`/`jimp` pour les
    images, `ffmpeg` pour vidéos/stickers) tant qu'aucune fonctionnalité média
    n'est demandée.
  - Réutilisation telle quelle des fonctions pures déjà isolées pour
    `local-client/lib/` (`normalizeRecipientEntry`, `personalizeMessage`,
    `spintax`) — c'est du vrai Node dans les deux cas, zéro portage.
- **Survie en arrière-plan (Android)** : foreground service + notification
  persistante discrète ("WhatsApp connecté"), plus demande unique à
  l'utilisateur d'exclure l'app de l'optimisation de batterie — seul
  mécanisme réellement fiable sur Android, plus léger en pile que des
  wake-locks bricolés qui tentent de contourner Doze.
- **Portée du premier spike** : Android seul, texte seul (pas médias, pas
  groupes), juste pairing + envoi/réception, pour valider la faisabilité
  avant d'investir plus (cf. recommandation ci-dessous, désormais suivie).

### Vérification de faisabilité faite avant de se lancer (2026-09-09)

Point de risque identifié puis levé : Baileys dépend de `whatsapp-rust-bridge`
(un composant Rust) et de `libsignal`. Inspection de leurs paquets npm :
- `whatsapp-rust-bridge` compile en **WebAssembly portable**, inliné en
  base64 dans un unique fichier JS (`dist/index.js`, ~1,9 Mo) — aucun binaire
  natif par OS/architecture, aucune compilation Rust/NDK nécessaire sur
  l'appareil. Le WASM s'exécute nativement dans le moteur V8 embarqué par
  nodejs-mobile.
- `libsignal` (ici `WhiskeySockets/libsignal-node`) est une réimplémentation
  **pure JS** du protocole Signal (dépend seulement de `protobufjs` et
  `curve25519-js`, tous deux purs JS) — pas le `libsignal-client` natif de
  Signal lui-même.

Conclusion : aucune compilation native (NDK, Rust, node-gyp) requise pour
faire tourner Baileys dans `nodejs-mobile-react-native` — seul le pont
React Native ↔ Node lui-même (`nodejs-mobile-react-native`) a une partie
native, déjà précompilée par le paquet.

### Contrainte de version Baileys — risque de sécurité accepté (2026-09-09)

`nodejs-mobile-react-native` n'a jamais publié de version au-delà de
`18.20.4` (dernier runtime Node embarqué disponible = Node **18**). Or
`baileys` exige Node `>=20` depuis la version `6.7.17` (et toutes les
versions `7.0.0-rc*`). La dernière version sans cette contrainte est
**`baileys@6.7.16`**, épinglée dans
`nodejs-assets/nodejs-project/package.json`.

Problème : `baileys@6.7.16` est listée par npm comme vulnérable à
**CVE-2026-48063** (GHSA-qvv5-jq5g-4cgg, **critique**) — usurpation de
messages via un payload `placeholderResendMessage` forgé, exploitable à
distance sans authentification, corrigée seulement en `6.7.22+`/
`7.0.0-rc12+` (donc jamais utilisable ici tant que `nodejs-mobile-react-native`
ne bundle pas Node ≥20 — aucune version de ce type n'existe à ce jour).

**Décision (validée avec l'utilisateur)** : accepter le risque pour ce
spike, en appliquant le contournement officiel de l'avis de sécurité :
- `syncFullHistory: false` (déjà en place pour l'allègement CPU/RAM).
- Filtrage de tout message `messages.upsert` portant un champ `requestId`
  ou un `placeholderResendMessage` — implémenté dans
  `nodejs-assets/nodejs-project/main.js`.

**À refaire dès que possible** : dès qu'une version de
`nodejs-mobile-react-native` embarque Node ≥20 (à surveiller sur son
dépôt npm), remonter vers `baileys@6.7.22+` et retirer ce contournement.

## Ce qui reste à faire ici

1. ~~Scaffolding React Native + intégration `nodejs-mobile-react-native`~~ —
   **fait le 2026-09-09** (`mobile/CyrusMobile/`, RN 0.73.9, Old Architecture,
   `arm64-v8a` seul, Metro configuré pour ignorer `nodejs-assets/`).
2. ~~Baileys dans `nodejs-assets/nodejs-project/`~~ — **fait**, avec le
   contournement CVE-2026-48063 documenté ci-dessus
   (`nodejs-assets/nodejs-project/main.js`). Les 3 fichiers purs
   (`whatsappRecipients.js`, `personalization.js`, `spintax.js`) **pas encore
   copiés ici** — pas nécessaires pour le spike texte seul (pairing +
   envoi/réception simple), à ajouter seulement si des campagnes mobiles sont
   décidées plus tard.
3. ~~Écran de pairing côté React Native~~ — **fait**
   (`mobile/CyrusMobile/App.tsx`). Pairing par **code** (numéro de téléphone
   → code à saisir dans WhatsApp), pas par QR visuel — évite d'ajouter
   `react-native-svg` + une lib de rendu QR, dans l'esprit "allégé" retenu
   pour ce projet. `npx tsc --noEmit` passe sans erreur.
4. ~~Foreground service Android + notification persistante~~ — **fait**
   (`android/app/src/main/java/com/cyrusmobile/KeepAliveService.kt`, démarré
   dans `MainApplication.kt#onCreate`). Type `remoteMessaging` (pas
   `dataSync`, qui a un plafond de 6h/24h en arrière-plan depuis Android 14).
   Permissions ajoutées dans `AndroidManifest.xml`.
5. Test réel sur un appareil Android physique — **bloqué, pas encore fait**.

### Blocage actuel (2026-09-09) : build Gradle incomplet, JDK manquant

`npx react-native run-android` / `./gradlew assembleDebug` échoue sur la tâche
`compileDebugJavaWithJavac` (module `nodejs-mobile-react-native`) avec :
```
Failed to transform core-for-system-modules.jar
Error while executing process .../jbr/bin/jlink.exe ... finished with non-zero exit value 1
```
**Cause identifiée** : le JDK embarqué par Android Studio (`C:\Program Files\Android\Android Studio\jbr`, OpenJDK 21 "JetBrains Runtime") **ne contient pas le dossier `jmods`** (confirmé : `jmods/` absent de cette installation). Le plugin Gradle Android a besoin de `jlink` avec des `jmods` complets pour construire l'image JDK utilisée à la compilation `compileSdk 34`. Un essai de contournement par jonction de dossier (pour éviter un bug d'espace dans le chemin `Program Files`) n'a pas résolu le problème — ce n'est pas un problème de chemin, le JDK lui-même est incomplet pour cet usage.

**Ce qui a déjà été validé, pour ne pas repartir de zéro** :
- Gradle 8.3, NDK 25.1.8937393 et Android SDK Platform 34 sont maintenant tous
  en cache local (`C:\Users\HP\.gradle`, `C:\Users\HP\AppData\Local\Android\Sdk`)
  — ces téléchargements n'auront pas à être refaits.
- Tout le reste du build (resources, manifeste, autolinking, copie du projet
  Node dans les assets) passe sans erreur jusqu'à cette étape de compilation
  Java précise.

**Prochaine étape (à faire sur WiFi)** : installer un JDK complet incluant
`jmods` — ex. [Eclipse Temurin 17](https://adoptium.net/) (~150-200 Mo) — puis
relancer avec `JAVA_HOME` pointant vers ce JDK :
```
JAVA_HOME=/chemin/vers/temurin-17 ./gradlew assembleDebug
```
Une fois l'APK produit, connecter un téléphone Android (ou un émulateur) et
lancer `npx react-native run-android`, puis saisir le code d'association dans
WhatsApp pour valider le pairing de bout en bout.

---

## Cadrage original (options écartées, gardé pour mémoire)

Ce dossier était un placeholder : aucun projet mobile n'existait dans ce
dépôt avant cette décision. Ce document cadrait la faisabilité avant tout
premier code, comme demandé — un point de départ pour une décision, pas un
plan figé.

## La contrainte qui structure tout le reste

La consigne demande **Baileys** (bibliothèque Node.js pure) comme moteur
WhatsApp mobile. Le problème : ni Android ni iOS n'embarquent un runtime
Node.js nativement, et les frameworks mobiles courants (React Native,
Flutter) n'exécutent PAS du JavaScript "Node" — leur moteur JS (Hermes/JSC
sur RN, Dart sur Flutter) n'a pas les modules `net`/`crypto`/`stream` dont
Baileys dépend. Trois façons de lever ça, avec des compromis très différents :

### Option A — Baileys tourne sur un serveur, le mobile n'est qu'un client HTTP
Le mobile ne fait QUE parler HTTP à un service qui, lui, fait tourner
Baileys. Ce service existe déjà partiellement dans ce dépôt :
**`server/`** (micro-service Baileys mono-tenant, pensé pour Koyeb — voir
`server/README.md`). Le mobile deviendrait un client de plus de ce
micro-service (comme `local-client/` l'est du VPS principal), sans jamais
exécuter Baileys sur le téléphone lui-même.
- ✅ Réutilise du code existant et déjà éprouvé (`server/`).
- ✅ Aucune limite de plateforme mobile (juste du HTTP).
- ⚠️ Ce n'est plus vraiment "Baileys tourne sur mobile" au sens strict de la
  consigne — c'est Baileys qui tourne À CÔTÉ, sur un petit serveur dédié à
  CE téléphone (ou partagé). Implique un serveur à héberger par utilisateur
  (ou un multi-tenant comme le VPS principal), donc pas un vrai mode
  "on-premise" mobile — plutôt une extension du modèle SaaS existant.
- Session WhatsApp toujours vivante seulement si ce serveur reste up — pas
  d'usage réellement hors-ligne pour WhatsApp lui-même (contrairement à
  whatsapp-web.js sur PC, qui EST la connexion).

### Option B — Runtime Node embarqué dans l'app mobile
Des ponts existent pour faire tourner du "vrai" Node.js dans une app React
Native (ex: `nodejs-mobile-react-native`) ou similaire pour Flutter. Baileys
tournerait alors réellement sur l'appareil.
- ✅ Colle à la lettre à la consigne ("exécution hors navigateur", licence
  Baileys locale).
- ⚠️ Complexité d'intégration significative (build natif Android/iOS
  spécifique par plateforme, taille d'app accrue, maintenance du pont à
  chaque montée de version RN/Node).
- ⚠️ Comportement en arrière-plan incertain : iOS tue agressivement les
  process en tâche de fond — une session WebSocket Baileys ne survit pas
  forcément à l'app mise en arrière-plan sans notifications push dédiées
  (VoIP push ou équivalent), à valider par un prototype avant tout
  engagement sérieux.

### Option C — WebView + whatsapp-web.js (comme le PC), pas de Baileys
Techniquement jouable (Capacitor/Cordova avec un WebView), mais la consigne
interdit explicitement Puppeteer/Chromium sur mobile — écarté d'emblée, cité
ici seulement pour dire pourquoi ce n'est pas une option retenue.

## Recommandation pour la suite (à valider avec vous avant tout code)

Commencer par **prototyper l'Option A** (mobile = client HTTP de
`server/`) : c'est le chemin le plus court vers quelque chose qui marche
réellement, en réutilisant un service déjà écrit dans ce dépôt. Si
l'exigence "Baileys tourne VRAIMENT sur l'appareil, même sans réseau vers un
serveur dédié" est non négociable, l'Option B devient nécessaire — mais
mérite un spike technique isolé (quelques jours, sur UNE plateforme
d'abord) avant d'engager tout un plan produit dessus.

## Ce qui, dans l'architecture failover déjà en place, s'appliquerait tel
quel à un futur client mobile (Option A)

- `local-client/lib/vpsClient.js`, `license.js`, `aiGateway.js`,
  `failover.js` : logique de bascule VPS/Firebase déjà écrite de façon
  générique (HTTP + en-têtes `x-license-key`/`x-device-id`) — un client
  mobile HTTP pourrait suivre exactement le même contrat, sans rien
  dupliquer côté VPS/Firebase.
- `firebase-functions/verifyLicenseOffline` : déjà pensé pour n'importe quel
  client (pas de dépendance PC), directement réutilisable par un mobile.
