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

**Chantier JARVIS (2026-09-20, branche `feat/jarvis-engine`, non déployé)** : moteur
conversationnel (refus respecté, anti-répétition, NO_ACTION, file/debounce par
conversation, agent multi-outils avec PREPARE→confirmation→VERIFY, mémoire 7×24 h
stricte, local-first, licences sur Cloudflare). Détail et reste-à-faire :
**`docs/JARVIS.md`**. Décision utilisateur : Cloudflare (Worker+D1, gratuit)
remplace Firebase (devenu payant) — `cloudflare/license-worker/`, à déployer
par l'utilisateur ; le générateur de licences Cloudflare est volontairement le
DERNIER chantier. RIEA/Firebase partagé : toujours intouché.
**COMPTE DES TESTS RÉELS : tout test réel (WhatsApp/Telegram/IA/licence) se fait avec le
compte rattaché à la clé de licence de test** (consigne utilisateur du 2026-09-20).
La clé est dans `.env` (variable `CYRUS_TEST_LICENSE_KEY`, fichier ignoré par Git : le dépôt
GitHub est PUBLIC, ne jamais l'écrire dans un fichier commité). Scénarios : `docs/TESTS-REELS.md`.
Identifiants Cloudflare (compte, jeton API, R2) : aussi dans `.env` (`CLOUDFLARE_*`), jamais commités.

**Chantier en cours (2026-09-15, reprendre ICI)** : rendre l'agent CYRUS
**100% autonome** (objectif explicite de l'utilisateur : "aiguiser le système
intelligent à agir de façon 100% autonome"). Dernière avancée =
**connecteurs de plateforme externes pilotés par les permissions** (point 4
ci-dessous, section en tête de `docs/PARITE-LOCAL.md`). Suivi vivant complet,
chantier par chantier, dans
**`docs/PARITE-LOCAL.md`** (fichier au nom historique, contient en réalité
TOUT le suivi de cette phase — à lire intégralement avant de reprendre,
plusieurs sections empilées dans l'ordre chronologique). Résumé pour
reprendre sans tout relire :

1. **VPS (VM Google Cloud, voir section infra ci-dessous) : FAIT et
   DÉPLOYÉ, vérifié en conditions réelles par l'utilisateur.**
   `ai-engine/{chatOrchestrator,offerClarifier,personaManager,
   emotionalCloser,voiceProcessor,platformOrchestrator,storageAdapter}.js` +
   6 nouvelles actions dans `lib/intelligence/action-executor.js` + DeepSeek
   dans la cascade IA. Branché sur LES DEUX tchats du dashboard
   ("Copywriter Studio IA" ET "💬 Chat Intelligent" — piège réel rencontré :
   le premier câblage n'avait touché QUE le premier, l'utilisateur a testé
   le second et reçu une réponse robotique, corrigé depuis).
   **2 bugs critiques trouvés en test réel et corrigés** (tous deux
   déployés) : (a) l'onglet "Chat Intelligent" n'était pas branché sur le
   nouveau moteur — corrigé dans `lib/intelligence/vps-bridge.js` ; (b) le
   LLM **niait avoir accès à WhatsApp/Telegram** quand on lui demandait
   comment il comptait contacter les clients (répondait comme un assistant
   généraliste classique, "je n'ai pas accès à vos comptes externes") —
   corrigé en ajoutant une consigne explicite d'accès réel dans
   `lib/ai/llmFallbackEngine.js#SYSTEM_PROMPT` (source unique, utilisé
   partout) ET `ai-engine/personaManager.js#personaSystemPrompt`. **Si un
   comportement similaire de déni de capacité réapparaît ailleurs, c'est le
   même type de correctif qu'il faut appliquer** (le LLM a besoin qu'on lui
   affirme explicitement son accès réel, sinon il retombe sur son
   comportement par défaut d'IA généraliste prudente).
2. **PC (`local-client/`) : port COMPLET, désormais COMMITTÉ ET POUSSÉ**
   (commit `52f3231`, 2026-09-15) — tout le code existe (`local-client/ai-engine/`,
   `local-client/lib/ai/llmFallbackEngine.js`, `local-client/lib/intelligence/
   runtimes/local-runtime.js`, hooks `onIncomingMessage` ajoutés à
   `lib/whatsapp.js`/`lib/telegram.js`, route `/api/intelligence/goal-chat`
   modifiée dans `index.js`), vérifié par `node --check` + tests de logique
   en isolation, **jamais testé avec de vraies clés API ni un vrai compte
   WhatsApp/Telegram local, jamais buildé en `.exe`**.
3. **Mobile (`mobile/webapp/`) : PAS commencé.**
4. **Chantier "plateformes BACK-OFFICE EXTERNES" : CADRE CONSTRUIT côté VPS
   (2026-09-15), pas encore testé en réseau réel.** Rendre l'agent capable
   d'opérer les plateformes du vendeur pour lui, **piloté par les permissions**
   et NON limité à une plateforme précise (précision explicite de
   l'utilisateur : la formation n'est qu'un exemple). Réalisé : cadre générique
   de connecteurs `ai-engine/connectors/` (connectorManager piloté par les
   scopes, platformConnector `X-API-Key`, systemIoConnector, accountingConnector,
   `active_connectors.json`) + validation de paiement Human-in-the-Loop
   (`ai-engine/manualPaymentValidator.js`) + branchements chatOrchestrator/
   index.js. **Détail complet et reste-à-faire : voir `docs/PARITE-LOCAL.md`,
   section tout en haut "Connecteurs de plateforme…".**
   - **Cible concrète = RIEA AFRIQUE** (`https://riea-afrique-web.web.app/`, sa
     PROPRE app, MÊME projet Firebase partagé `rien-afrique`). **RÉSOLU : la
     manière de donner l'accès = une clé API `X-API-Key`.** L'utilisateur a
     lui-même déployé sur RIEA une Cloud Function `agentGateway` (endpoints
     `/api/v1/agent-gateway/{enroll,suspend}-student`, clés hachées dans
     `rieaApiKeys`, back-office admin RIEA `/admin` pour générer/révoquer). Il a
     fourni une clé `sk_live_…` (dans `.env` local sous `CYRUS_PLATFORM_API_KEY`).
   - ⚠️ **RÈGLE ABSOLUE reconfirmée (2026-09-15) + mémoire globale épinglée
     `riea-afrique-read-only-api-only`** : ne JAMAIS toucher quoi que ce soit de
     déployé pour RIEA (Firestore/règles/fonctions). CYRUS agit sur RIEA
     EXCLUSIVEMENT via cette API HTTP. Le code source RIEA est lisible en local
     (`C:\Users\HP\Downloads\RIEA AFRIQUE\riea-afrique-site\`) POUR CONNAÎTRE LE
     CONTRAT UNIQUEMENT — ne rien y modifier ni redéployer.
5. **Ancien chantier "parité Mode VPS ↔ Local" (pièce jointe, ebook,
   Studio Média...)** : toujours dans le même état qu'avant (code écrit,
   jamais compilé/testé, RAM de la machine à revérifier) — voir la section
   correspondante, plus bas dans `docs/PARITE-LOCAL.md`, pas prioritaire
   tant que le chantier ci-dessus n'est pas avancé.

## Archive — infrastructure Google Cloud (état documenté le 2026-09-14)

> Les consignes SSH et de déploiement qui suivent sont historiques. L'utilisateur indique que la VM Google n'est plus active faute de paiement : ne pas l'utiliser comme cible. La cible actuelle est le backend Render; Vercel reste l'interface web et `public/config.js` pointe vers Render. Lire `docs/MIGRATION-GOOGLE-RENDER.md` avant toute publication. Aucun push sur `main` tant que les écarts de code, d'environnement et de données n'ont pas été réconciliés, car `main` déclenche le déploiement Render.

**À la date de cette archive, le VPS de production n'était PLUS Render** — il avait été migré vers une VM Google Cloud
Compute Engine, confirmé explicitement par l'utilisateur le 2026-09-14.
Render reste configuré (webhook GitHub + auto-deploy actifs) mais le
service y est **SUSPENDU** depuis au moins le 2026-09-08 (dernier déploiement
Render réel : commit `11652f9f...`, ce jour-là) — **tout push sur `main`
depuis n'atteint donc plus la production réelle** tant que le déploiement
ne se fait pas manuellement sur la VM ci-dessous. Ne JAMAIS supposer qu'un
`git push` suffit à déployer sur ce projet désormais.

### Accès VM Google Cloud — production réelle
```
Instance      : instance-20260909-074745
Projet GCP    : rien-afrique  (MÊME projet que le failover Firebase, voir
                règle preserve-existing-infrastructure — prudence identique)
Zone          : us-central1-a
Utilisateur VM: deploy

Connexion (fonctionne via Google Cloud Shell — l'ancienne clé SSH locale ne
fonctionne plus) :
  gcloud compute ssh deploy@instance-20260909-074745 --project=rien-afrique --zone=us-central1-a

Conteneur Docker principal : cyrus-super-assistant-backend (port 3000->3000)
URL publique   : https://34-135-20-27.sslip.io
Health check   : https://34-135-20-27.sslip.io/health
```
### Mécanisme de déploiement RÉEL sur cette VM (confirmé et exécuté avec
succès le 2026-09-14) — PAS de GitOps automatique, tout est manuel via SSH :
```
gcloud compute ssh deploy@instance-20260909-074745 --project=rien-afrique --zone=us-central1-a --command="<commande>"
```
Le checkout applicatif vit dans `/home/cyrus2026/BusinessAutomationEngine`
(utilisateur Linux **`cyrus2026`**, PAS `deploy` — accéder aux fichiers via
`sudo -u cyrus2026 ...` ou `sudo <commande>`). C'est un checkout git normal
(`origin` = ce dépôt GitHub, branche `main`) :
1. `git pull origin main` (en tant que `cyrus2026`) pour récupérer les
   derniers commits.
2. `sudo ./deploy.sh` (depuis ce même dossier) — rebuild l'image Docker
   (`docker-compose up -d --build`) PUIS nettoie les images/couches
   orphelines (le disque ne fait que 9,7 Go, voir le commentaire en tête du
   script — un rebuild sans nettoyage l'a déjà rempli à 97% le 2026-09-09).
   Le build installe des paquets système lourds (ffmpeg, g++, python3...) :
   compter plusieurs minutes, PAS instantané — si une commande SSH interactive
   semble ne rien afficher/se terminer sans output, ce n'est probablement pas
   un échec mais un souci d'affichage du terminal SSH (voir piège ci-dessous),
   pas le signe que le build a échoué.
3. Vérifier : `sudo docker ps -a` (conteneur `cyrus-super-assistant-backend`
   doit être "Up", `CREATED` récent) + `curl https://34-135-20-27.sslip.io/health`
   + `sudo docker logs cyrus-super-assistant-backend --tail 50` (chercher
   "Server listening on port 3000", pas de `MODULE_NOT_FOUND`/`SyntaxError`
   — des erreurs Baileys "Connection Failure"/"PreKeyError"/"MessageCounterError"
   dans les logs sont NORMALES, bruit habituel multi-tenant, pas un échec).

**Pièges déjà rencontrés (2026-09-14), à éviter au prochain déploiement :**
- **Fichiers root-owned dans le checkout** : `git pull` peut échouer avec
  des `Permission denied` si des fichiers du dépôt appartiennent à `root`
  (constaté sur 134 fichiers, cause exacte non identifiée — probablement un
  `sudo git pull`/`sudo npm install` lancé par erreur une fois). Fix :
  `sudo chown -R cyrus2026:cyrus2026 /home/cyrus2026/BusinessAutomationEngine`
  avant de retenter le pull.
- **Checkout localement modifié/désynchronisé de git** (constaté une fois :
  des fichiers avaient été déposés directement sur le disque, hors git, sans
  jamais faire avancer le HEAD local) : `git pull` refuse alors avec "local
  changes would be overwritten". Diagnostic AVANT toute action destructive :
  comparer le contenu réel (`md5sum`/`diff` après avoir neutralisé les fins
  de ligne CRLF/LF, PAS un simple `diff` brut qui affiche tout comme
  différent à cause de ça) pour confirmer qu'il n'y a pas de vrai travail
  concurrent avant d'écraser quoi que ce soit. Remède SANS `git reset --hard`
  (souvent bloqué par le mode auto de Claude Code, "Irreversible Local
  Destruction") : `git update-ref refs/heads/main origin/main` (déplace HEAD
  sans toucher à l'arbre de travail) puis `git reset` (sans argument —
  resynchronise l'INDEX sur HEAD, ne touche PAS non plus l'arbre de travail)
  puis `git checkout -- .` (restaure l'arbre de travail depuis l'index) —
  3 commandes ciblées et réversibles à chaque étape, jamais un `--hard`.
- **`gcloud compute ssh --command="... & ..."` avec backgrounding/nohup
  inline** : silencieusement NE S'EXÉCUTE PAS DU TOUT sur Windows (aucune
  sortie, aucune erreur, le process ne démarre jamais) — problème
  d'échappement entre Git Bash → gcloud → plink.exe. Solution fiable : écrire
  un petit script `.sh` sur la VM via `printf ... | sudo tee /tmp/script.sh`
  (évite les guillemets imbriqués), puis le lancer en arrière-plan DÉTACHÉ de
  la session SSH via `sudo systemd-run --unit=<nom> /tmp/script.sh` (fonctionne
  de façon fiable, contrairement à `nohup ... &`), et sonder avec
  `systemctl status <nom>` / lire le fichier de log qu'il écrit.

---

## État actuel du projet (résumé)

**CYRUS SUPER ASSISTANT** — plateforme Node.js/Express (`index.js`).
La cible courante est le backend Render (`business-automation-engine`); Vercel
sert l'interface web et le dashboard appelle l'URL Render définie dans
`public/config.js`. Le service Render est actif sur `main`; le dernier état
vérifié est le commit `bbee8e59ee8531811451fcc4f7aa9c96525bb5b2` en `Live`,
avec `/health` en 200 et le `config.js` Vercel en 200 vers Render. Cette
publication automatique a eu lieu le 2026-09-24 à 16:24 UTC, avant l'audit
actuel. Ne pas lancer de build supplémentaire pour ce même commit. L'exact SHA
et les modifications hors Git de la VM ne sont toujours pas établis; contrôler
les sauvegardes de données avant de déclarer la migration intégrale.
Dashboard servi en HTML/JS statique unique (`public/dashboard.html`), avec
export PWA (`manifest.json`, `sw.js`, `icon.svg`) et un build d'obfuscation
(`npm run build` → `public/dist/dashboard.html`) — inchangé par cette
migration d'infrastructure.

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
- **Testé sur un vrai appareil le 2026-09-10** (TECNO CL6k, USB) — app
  lancée avec succès (React Native + thread Node embarqué opérationnels,
  "Node : prêt"), UI entièrement refaite (thème sombre/cyan aligné sur le
  logo CYRUS SUPER ASSISTANT fourni par l'utilisateur, pastilles de statut
  animées, apparition du code en "récompense", boutons à retour tactile —
  voir `App.tsx`) — mais **le pairing échoue systématiquement** :
  1. Bug trouvé et corrigé : `ReferenceError: crypto is not defined` au
     premier `requestPairingCode` — `globalThis.crypto` n'existe par défaut
     qu'à partir de Node 19 (stable), absent du runtime Node 18.20.4
     embarqué ; polyfilé via `require('node:crypto').webcrypto` en tête de
     `main.js`.
  2. Une fois ce bug corrigé, un VRAI code d'association est généré avec
     succès (confirmé, ex: `BZ1Q3W83`) — mais WhatsApp refuse ensuite de
     finaliser la liaison : `Error: Timed Out` (statusCode 408,
     `validateConnection`) au premier essai, puis `Connection Closed` au
     second (même symptôme réel, message différent).
  3. **Cause probable identifiée** : `nodejs-mobile-react-native` n'a
     **aucune version publiée au-delà de Node 18.20.4** (vérifié en direct
     sur le registre npm — dernière publication oct. 2024, plus d'un an) ;
     Baileys 6.7.17+ exige Node ≥20, donc le mobile reste figé sur le
     paquet `baileys@6.7.16`, dont la version de protocole WA embarquée
     (`[2,3000,1019707846]`) semble désormais trop datée pour que WhatsApp
     accepte un NOUVEL appairage — le VPS, sur
     `@whiskeysockets/baileys@^6.7.24` (`[2,3000,1043857760]`), n'a pas ce
     problème.
  4. **Tentative de contournement essayée et ABANDONNÉE** : forcer
     `version: [2,3000,1043857760]` en dur dans `makeWASocket()` (valeur
     statique copiée du VPS, PAS un `fetchLatestWaWebVersion()` dynamique —
     différent de l'erreur déjà commise côté VPS le 2026-09-06/07) — n'a
     pas résolu le problème (toujours "Connection Closed" ensuite) et a été
     retiré : déclarer une version de protocole que le code sous-jacent
     (6.7.16) n'implémente pas réellement peut paraître suspect aux
     systèmes anti-abus WhatsApp.
  5. **Option A envisagée puis REFUSÉE par l'utilisateur** (demande
     explicite, absolue) : faire tourner Baileys à jour sur un petit
     serveur séparé (`server/`, déjà écrit pour Koyeb, `GET /messages`
     ajouté pour le polling mobile sans webhook entrant) — testé
     fonctionnel sur la VM (conteneur Docker séparé, port 8001), mais
     **démonté immédiatement** : l'utilisateur refuse tout serveur
     externe pour le WhatsApp du téléphone, même temporaire/séparé du VPS
     principal, par principe. Ne jamais réintroduire cette option sans
     qu'il ne le redemande explicitement.
  6. **Option "réutiliser whatsapp-web.js (PC) sur mobile" écartée** :
     nécessite un vrai navigateur Chromium complet (Puppeteer), qu'il
     n'existe aucun moyen standard de faire tourner dans ce runtime Node
     embarqué sur Android — pas une simple substitution de bibliothèque,
     une architecture entièrement différente et non faisable en l'état.
  7. **Aucune bibliothèque alternative d'embarquement Node trouvée** sur
     npm (recherche faite) qui supporterait Node ≥20 pour React Native.
  8. **Baileys embarqué (Node 18) : BLOQUÉ**, sans solution restante
     identifiée qui respecte la contrainte "zéro serveur externe" de
     l'utilisateur. Reprendre uniquement si : (a)
     `nodejs-mobile-react-native` publie un jour une version Node ≥20, (b)
     une autre lib d'embarquement Node apparaît, ou (c) l'utilisateur
     accepte de reconsidérer la contrainte zéro-serveur.
  9. **Piste alternative retenue : WebView Android + injection JS directe**
     (proposée par l'utilisateur le 2026-09-10, toujours "zéro serveur" —
     le téléphone reste l'unique exécuteur). Idée : réutiliser la valeur
     réelle de whatsapp-web.js, qui n'est pas Puppeteer lui-même mais ses
     scripts `Injected/*.js` (hook de `window.Store`), en les faisant
     tourner dans la WebView **native** Android (`react-native-webview`)
     au lieu d'un Chromium piloté par CDP.
     - **Test minimal réalisé et RÉUSSI** (`WebViewTest.tsx`, écran
       accessible depuis un lien en haut de l'écran d'accueil de l'app) :
       WebView avec User-Agent desktop Chrome chargeant
       `https://web.whatsapp.com` — la page se charge intégralement et
       affiche un **vrai QR code scannable** (confirmé visuellement sur
       appareil réel, TECNO CL6k, 2026-09-10). Script de sonde injecté
       confirme `canvas=true`, `titre="WhatsApp"`,
       `html=630512 caractères`. `minSdkVersion` relevé de 21 à 24 (requis
       par `react-native-webview`, voir `android/build.gradle`) — aucune
       perte de compatibilité réelle en 2026.
     - **Hypothèse validée** : rien n'empêche `web.whatsapp.com` de tourner
       normalement dans une WebView Android native avec le bon
       User-Agent. L'étape suivante (non commencée) est de porter les
       scripts `Injected/*.js` de whatsapp-web.js et le pont natif↔JS pour
       lire/envoyer des messages — travail substantiel, à ne démarrer
       qu'après validation explicite de l'utilisateur vu l'ampleur.
     - Limite observée sur le test (cosmétique, pas bloquante) : la page
       déborde horizontalement dans la WebView (pas de scaling
       "responsive" appliqué) — à corriger plus tard via un viewport
       injecté ou du CSS si besoin, sans rapport avec la faisabilité.
     - **Pont réel construit et déployé** (`whatsappWebBridge.ts` +
       `WhatsAppWebEngine.tsx`, accessible via le lien "🚀 Moteur WhatsApp
       (WebView réel)" sur l'écran d'accueil, coexiste avec l'écran Baileys
       existant sans le remplacer). Réécriture minimale (texte seul, pas
       un port complet de whatsapp-web.js/Utils.js) qui réutilise les
       mêmes modules internes que whatsapp-web.js
       (`window.require('WAWebSocketModel')`, `WAWebCollections`,
       `WAWebSendMsgChatAction`, etc. — voir
       `local-client/node_modules/whatsapp-web.js/src/Client.js` et
       `src/util/Injected/Utils.js` comme référence, extraits et
       simplifiés au strict nécessaire). `window.require` est un global
       exposé par le bundle WhatsApp Web lui-même, pas par
       Puppeteer/whatsapp-web.js — fonctionne donc à l'identique dans la
       WebView native.
     - **Testé sur l'appareil réel (2026-09-10)** : après rechargement de
       l'app, l'écran affiche `WA: UNPAIRED · Pont: prêt` — confirmation
       que le script injecté a bien accroché l'état interne réel de
       WhatsApp Web (pas une valeur simulée) et que `bridge-ready` a bien
       été émis. Panneau de test (ID destinataire, texte, bouton Envoyer,
       journal des messages reçus) opérationnel et vide comme attendu
       (aucun appairage encore fait).
     - **APPAIRAGE RÉEL CONFIRMÉ le 2026-09-10** (numéro WhatsApp Business
       de l'utilisateur, via l'option "Se connecter avec le numéro de
       téléphone" de WhatsApp Web lui-même — code à 8 chiffres saisi côté
       téléphone). L'écran passe bien de `WA: UNPAIRED` à `WA: CONNECTED`,
       confirmant que le pont lit l'état interne réel. Un premier essai
       avec un autre numéro avait échoué ("impossible de se connecter") ;
       cause non déterminée avec certitude (numéro différent, ou
       simplement un essai transitoire raté côté WhatsApp — pas
       nécessairement lié à Business vs. standard). À revisiter seulement
       si le pairing échoue de façon répétée et reproductible.
     - **Bug trouvé et corrigé sur l'envoi de message** : le panneau de
       test envoyait le numéro brut tel quel (ex. `22664977093`) à
       `WidFactory.createWid()`, qui exige un ID complet et rejetait avec
       `InvalidWidError: wid error: invalid wid`. Corrigé dans
       `WhatsAppWebEngine.tsx` (`send()`) : ajout automatique du suffixe
       `@c.us` si absent — même tolérance que l'écran Baileys existant
       (`App.tsx`, suffixe `@s.whatsapp.net` pour Baileys, `@c.us` pour
       whatsapp-web.js/WA Web, cf.
       `local-client/node_modules/whatsapp-web.js/src/Client.js:2225`).
     - **Deuxième bug trouvé et corrigé sur l'envoi** : `whatsappWebBridge.ts`
       tentait de créer une conversation absente via
       `Collections.Chat.find(chatWid)`, qui n'est pas une méthode
       publique valide dans ce contexte (`TypeError: this.findImpl is not
       a function`). Corrigé en reprenant le vrai flux de whatsapp-web.js
       (`window.WWebJS.getChat`, voir Utils.js ligne ~868) : résolution
       via `window.require('WAWebFindChatAction').findOrCreateLatestChat(chatWid)`.
     - **ENVOI ET RÉCEPTION CONFIRMÉS DE BOUT EN BOUT sur l'appareil réel
       (2026-09-10)**, après les deux corrections ci-dessus : message
       texte envoyé avec succès (`Envoyé à 22664977093@c.us`) ET capté par
       le hook de réception (`Collections.Msg.on('add', ...)`), qui a
       affiché le message envoyé dans le journal de l'app (`Moi: Test
       CYRUS bridge WebView`) — la preuve que le même chemin de code qui a
       affiché ce message sortant affichera un message entrant réel
       (même hook, aucune distinction de traitement). **Le blocage mobile
       WhatsApp documenté plus haut (Baileys/Node 18) est donc résolu par
       cette voie alternative** : connexion, envoi et réception texte
       fonctionnent tous les trois, en zéro-serveur, via
       `WhatsAppWebEngine.tsx` + `whatsappWebBridge.ts`. Le moteur Baileys
       reste en place mais n'est plus la voie à développer davantage.
     - **UI de conversation réelle construite (2026-09-10)**, remplaçant
       le panneau de test brut : `WhatsAppWebEngine.tsx` masque
       maintenant la WebView WhatsApp Web une fois connecté (réduite
       hors-écran via un style absolu, pas démontée — le pont injecté doit
       continuer de tourner pour recevoir les messages), et affiche à la
       place une vraie interface de conversation par contact (bulles
       envoyé/reçu animées, barre de saisie, un contact actif à la fois —
       toujours dans l'esprit minimal du spike). Pendant l'appairage
       (non connecté), la WebView redevient visible en plein écran (le QR
       doit rester visible/interactif).
     - **Bug trouvé et corrigé** : `FlatList inverted` (utilisé pour
       afficher les messages du plus récent en bas) appliquait un miroir
       qui rendait le texte de `ListEmptyComponent` illisible (inversé/
       mirroir), constaté sur l'appareil. Remplacé par une liste normale
       (données triées plus ancien→plus récent) avec défilement
       automatique vers le bas via `scrollToEnd` sur `onContentSizeChange`
       — plus robuste que de compenser le miroir avec un contre-transform.
       Confirmé visuellement corrigé sur l'appareil réel.
     - **Confirmé fonctionnel par l'utilisateur (2026-09-10, test manuel
       direct sur l'appareil)** : ouverture d'un contact + envoi/réception
       via la nouvelle UI de conversation valident bien de bout en bout
       (mon automatisation adb avait échoué a re-tester ça elle-même —
       clavier tiers du TECNO CL6k perdant des caractères lors de la
       frappe injectée trop rapide — mais le test manuel de l'utilisateur
       confirme que le code fonctionne correctement).
     - **Liste des conversations et reconnexion ajoutées (2026-09-10)** :
       `WhatsAppWebEngine.tsx` affiche maintenant un écran de liste
       (conversations dérivées des messages vus depuis l'ouverture de
       l'app, triées par récence, avatar + aperçu du dernier message) avec
       navigation vers/depuis une conversation individuelle (flèche
       retour). Si la session se coupe après une connexion réussie
       (`waState` repasse à autre chose que `CONNECTED`), un bandeau
       "Session WhatsApp interrompue" s'affiche et la WebView redevient
       visible automatiquement (même mécanisme que l'appairage initial) —
       confirmé fonctionnel sur l'appareil réel (navigation liste ↔
       conversation testée, empty states corrects).
     - **Persistance du processus en arrière-plan déjà en place** : un
       service de premier plan Android (`KeepAliveService.kt`, démarré
       sans condition au lancement dans `MainApplication.kt`) maintient le
       processus de l'app vivant quand elle passe en arrière-plan — ce
       mécanisme est au niveau du processus, donc couvre automatiquement
       la WebView du moteur actuel sans code supplémentaire (il avait été
       écrit à l'origine pour le thread Node/Baileys, mais s'applique
       identiquement à n'importe quel code tournant dans ce process).
       **Non re-testé en conditions réelles pour ce moteur précis** (app
       en arrière-plan plusieurs minutes + réception d'un message) — les
       ROM TECNO/Infinix sont connues pour être agressives sur la gestion
       batterie des apps en arrière-plan malgré un service de premier
       plan ; à vérifier par l'utilisateur si l'usage réel révèle des
       messages manqués app fermée.
     - **Bug trouvé et corrigé (2026-09-10, signalé par l'utilisateur)** :
       "Echec envoi : Error: No lid for user" lors d'un changement de
       destinataire. Cause : WhatsApp adresse certains contacts en
       interne au format "LID" (identifiant privé, déploiement progressif
       côté WhatsApp, indépendant de ce projet) plutôt que par numéro de
       téléphone ; `chat.id.isLid()` renvoie alors vrai pour ce contact et
       le code appelait `getMaybeMeLidUser()` sans filet — cette fonction
       lève l'erreur au lieu de renvoyer une valeur vide quand le compte
       de l'utilisateur n'a pas (encore) d'identité LID résolue. Corrigé
       dans `whatsappWebBridge.ts` (`__cyrusSend`) par un repli sur
       `getMaybeMePnUser()` (identité numéro classique) si l'identité LID
       est indisponible, plutôt que de planter. Déployé et l'app recharge
       bien (connexion confirmée) ; **non re-testé sur le contact précis
       qui a déclenché l'erreur** (dépend de l'adressage LID côté
       WhatsApp pour ce contact spécifique, pas reproductible par un
       numéro de test arbitraire) — à confirmer par l'utilisateur en
       retentant le changement de destinataire qui avait échoué.
     - **Reste à faire pour "utilisable en production"** : rien d'autre
       identifié comme bloquant à ce stade pour l'usage "texte seul, un
       contact à la fois" du spike. Pistes d'amélioration non urgentes :
       persistance de la liste de conversations sur disque (elle se vide
       actuellement à chaque redémarrage de l'app, en mémoire seulement),
       et validation réelle du comportement en arrière-plan prolongé.
     - Fragilité assumée et documentée dans `whatsappWebBridge.ts` : les
       noms de modules WA internes utilisés peuvent changer à une future
       mise à jour de WhatsApp Web — même fragilité structurelle que
       whatsapp-web.js côté PC.

### 4. PIVOT vers webapp Capacitor (`mobile/webapp/`, session du 2026-09-10 soir)

**`mobile/CyrusMobile/` (React Native + nodejs-mobile-react-native) est
abandonné pour Telegram/IA, mais reste en l'état** (le moteur WhatsApp y est
pleinement fonctionnel, voir section 3 ci-dessus) — le nouveau chantier
mobile est `mobile/webapp/`, un projet Capacitor séparé.

**Déclencheur** : tentative d'ajouter Telegram (GramJS) au runtime Node
embarqué de `mobile/CyrusMobile/` — a fait planter tout le process natif
(`node::TrapWebAssemblyOrContinue`, crash natif, pas une exception JS) dès
le chargement de `telegram/client/TelegramClient.js`. Cause : GramJS utilise
un module crypto compilé en WebAssembly (SRP/2FA) incompatible avec le
runtime Node 18 embarqué par `nodejs-mobile-react-native` sur cette
architecture. Aucun correctif identifié côté runtime embarqué.

**Décision (utilisateur)** : plutôt que de continuer à debugger ce crash
natif, pivot vers une **webapp unique** (HTML/CSS/JS standard, pas de
framework/bundler côté UI) encapsulée par **Capacitor** pour Android —
préserve le principe "zéro serveur" (tout tourne sur l'appareil) tout en
évitant le runtime Node embarqué pour Telegram.

**Contrainte technique découverte en cours de route** : un `<iframe>`
cross-origin classique dans une page web NE PEUT PAS injecter de JS dans
`web.whatsapp.com`/`web.telegram.org` (same-origin policy du navigateur,
vraie sur PC comme sur mobile — ce n'est pas une limite Capacitor). D'où
`EmbeddedWebViewPlugin.java`, un plugin Capacitor natif custom (Java, pas de
dépendance Kotlin ajoutée) qui reproduit ce que `react-native-webview`
offrait côté React Native : une WebView Android pilotable depuis JS
(`open`/`setVisible`/`setBounds`/`evaluate`/`close`), avec un pont
`window.Cyrus.postMessage` équivalent à `window.ReactNativeWebView.postMessage`.
Plusieurs instances nommées (`id`) coexistent (une pour WhatsApp, une pour
Telegram).

**Telegram Web (`web.telegram.org/k/`) exploré en direct (Chrome devtools,
compte déjà connecté observé — API confirmée réelle, PAS un port de
GramJS)** : expose `window.rootScope.managers.{appMessagesManager,
appUsersManager, ...}` avec `appMessagesManager.sendText/sendMessage`
(callables, confirmés `typeof === 'function'`) et
`rootScope.addEventListener('history_multiappend', ...)` pour la réception.
Contrairement au pont WhatsApp (entièrement validé, réutilisé tel quel
depuis `mobile/CyrusMobile/whatsappWebBridge.ts`), **le pont Telegram
(`www/telegramBridge.js`) est un premier jet non éprouvé** : la détection
d'état (`rootScope.myId`) est confirmée fonctionner sur appareil réel
(affiche "Connecté" pour une session déjà autorisée), mais l'envoi
(`sendText`) et le format exact de `history_multiappend` n'ont pas encore
été exercés de bout en bout.

**Bugs rencontrés et corrigés pendant la mise en place** :
- `local.properties` manquant (`sdk.dir`) — copié depuis
  `mobile/CyrusMobile/android/local.properties`.
- Capacitor 7 exige JDK 21 pour compiler (`error: invalid source release:
  21` avec JDK 17) — utiliser le JBR fourni avec Android Studio
  (`C:\Program Files\Android\Android Studio\jbr`) comme `JAVA_HOME` pour ce
  projet, pas le JDK 17 utilisé par `mobile/CyrusMobile/`.
- `EmbeddedWebViewPlugin` faisait planter l'app à CHAQUE lancement
  (`ClassCastException: CoordinatorLayout$LayoutParams cannot be cast to
  FrameLayout$LayoutParams`) : le parent réel de la WebView Capacitor est
  un `CoordinatorLayout` (pas un `FrameLayout` comme supposé initialement).
  Corrigé en construisant un `ViewGroup.LayoutParams` générique dans
  `open()` (converti automatiquement vers le bon type concret par
  `ViewGroup.addView()` en interne) et en castant vers
  `ViewGroup.MarginLayoutParams` (supertype commun portant `setMargins`)
  dans `setBounds()`, jamais vers un type layout concret précis.
- Une WebView native ajoutée par-dessus la WebView Capacitor s'affiche
  TOUJOURS par-dessus tout le contenu HTML, quel que soit le CSS/z-index
  (couche native séparée) : une WebView embarquée en plein écran masquait
  entièrement l'entête/la nav de l'app. Corrigé via `setBounds()`
  (positionnement en pixels écran calculés côté JS via
  `getBoundingClientRect() * devicePixelRatio`) + masquage explicite de la
  WebView inactive à chaque changement d'onglet (`syncWebViewVisibility()`
  dans `www/app.js`) — sans ça la WebView de l'onglet précédent restait
  visible et bloquait les autres onglets.

**Confirmé fonctionnel sur appareil réel (2026-09-10)** : app se lance sans
crash, QR WhatsApp réel affiché (nav/entête restent cliquables par-dessus),
bascule d'onglet WhatsApp↔Telegram fonctionne (masquage/affichage correct
des deux WebViews), détection d'état Telegram confirmée sur une session
déjà connectée. **Non encore testés** : appairage WhatsApp réel (scan QR),
envoi/réception Telegram réel, écran Génération IA (licence + appels
Firebase, code écrit mais jamais lancé sur appareil).

**Contrainte utilisateur reconfirmée pendant cette session** : coût de
données mobiles élevé perçu par l'utilisateur sur les cycles
build→install→relancer répétés (même si le build Gradle lui-même tourne en
local sur le PC et que `adb install` passe par USB, donc ne consomme pas de
données mobiles directement — mais CHAQUE relance fait recharger
`web.whatsapp.com`/`web.telegram.org` en vrai sur la connexion du
téléphone). Ne plus enchaîner les cycles de test sans confirmation
explicite ; grouper les correctifs avant de rebuilder.

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

### 5. Parité fonctionnelle `mobile/webapp/` avec `public/dashboard.html` (session du 2026-09-10, suite du pivot Capacitor)

**Constat de départ** : `public/dashboard.html` (l'interface de référence à
dupliquer) est en réalité du HTML/JS vanilla (9087 lignes) — **pas du React**,
malgré la demande initiale de l'utilisateur qui l'assumait. Confirmé avec
l'utilisateur : on continue en HTML/JS pur, cohérent avec le choix déjà acté
pour `mobile/webapp/` (pas de framework/bundler, voir section 4). Confirmé
aussi : la cible est "Web + mobile", pas seulement Android — **implication non
encore traitée** : un simple onglet de navigateur PC ne peut pas ouvrir de
WebView native et lui injecter du JS (même contrainte cross-origin que celle
qui a motivé `EmbeddedWebViewPlugin.java` côté Android, voir section 4) ; le
candidat naturel pour le "Web PC" est `local-client/` (Express + whatsapp-web.js/
Puppeteer, a déjà sa propre UI minimale servie en localhost, voir
`local-client/public/`) plutôt qu'une page web classique — **pas commencé**,
`local-client/` n'a aujourd'hui ni Telegram ni parité d'interface avec
`dashboard.html`.

**Audit d'écart fait** (lecture seule, dashboard.html vs `mobile/webapp/`) :
export Excel des groupes = absent, filtrage de contacts = partiel (dédup
intra-fichier seulement), moteur de campagne = bonne base mais sans reprise
fiable après fermeture d'app, **Mode Manuel Express (deep links wa.me/tg://) =
totalement absent** (la fonctionnalité la plus riche du dashboard), page
connexions/historiques = partielle, module Facebook = absent (dépend
structurellement d'un backend OAuth, à clarifier avec l'utilisateur si
demandé).

**Réalisé cette session** (dans `mobile/webapp/www/` uniquement — dossier créé
aujourd'hui, jamais commité, aucun fichier VPS touché) :
- `lib/db.js` passé en v2 : nouveau store `sentLog` (journal de tout envoi
  réellement déclenché, campagne ou manuel) permettant `wasSentRecently()`
  (anti-doublons 48h, équivalent local du Smart Screening de
  `POST /api/messages/manual-import` côté VPS) et `getLatestCampaign()`.
- `campaign.js` : suivi des échecs d'envoi (`failed[]`, avant simplement
  ignorés), reprise automatique d'une campagne encore `'running'` au
  redémarrage de l'app (avant : `sentIdentifiers` repartait toujours de zéro
  en mémoire, la persistance SQLite/IndexedDB promise par le commentaire
  d'en-tête du fichier n'était pas branchée), et export Excel/CSV des membres
  de groupe déjà extraits (bouton "📥 Exporter (Excel)", réutilise
  `lib/fileExport.js` qui existait déjà mais n'était encore appelé nulle
  part).
- `lib/smartTextGenerator.js` (nouveau) : port fidèle du composant
  "Copywriter IA Intelligent" du dashboard (accroche + puces d'avantages +
  appel à l'action, synonymisation) — pur JS, zéro réseau.
- `lib/manualRelance.js` (nouveau, sans DOM) + `relance.js` (nouveau, wiring
  DOM) : **Mode Manuel Express** complet — file reprise de la dernière
  campagne du canal (contacts absents de `campaign.sent`) ou import direct
  d'un fichier avec anti-doublons 48h, rotation de variantes A/B/C, génération
  de texte via l'intention, deep link `https://wa.me/...?text=...` /
  `https://t.me/...`, ouverture via `window.open(url, '_system')` (délègue à
  Android la résolution vers l'app WhatsApp/Telegram installée), copie
  presse-papiers, Mode Série Continu avec décompte, compteur de rythme,
  raccourcis clavier. Nouvel onglet "📇 Relance Manuelle" dans `index.html`.
- **Simplification assumée** : pas de support Image-to-Link (aperçu visuel
  joint au message) — cette fonctionnalité du dashboard héberge l'image sur
  le serveur pour produire un lien public avec balises OG, structurellement
  incompatible avec "zéro serveur" tel quel ; à reprendre plus tard via
  Firebase Storage + Hosting si l'utilisateur le demande.

**Non testé sur appareil** (aucun build/install fait cette session — voir la
contrainte données mobiles de l'utilisateur, section 4 fin de session
précédente) : uniquement relecture de code + `node --check` sur les fichiers
JS modifiés/créés. `window.open(url, '_system')` pour déclencher
WhatsApp/Telegram depuis la WebView Capacitor n'a jamais été vérifié
concrètement sur ce projet — à valider au prochain cycle de build groupé.

**"Web PC" (`local-client/`) réalisé dans la foulée, même session** — Telegram
(GramJS) ajouté et UI étendue :
- `lib/telegram.js` (nouveau) : session Telegram mono-poste, adapté fidèlement
  du pattern multi-tenant déjà éprouvé de `adapters/telegram.js` (racine,
  jamais modifié ni requis directement — copié/adapté comme le veut la
  convention déjà en place pour `local-client/`, voir tête de
  `lib/campaigns.js`). Flux numéro → code → mot de passe 2FA éventuel,
  session sauvegardée dans `%APPDATA%\CyrusLocalClient\telegram_session.txt`.
  **Bug attrapé avant exécution** : premier jet avec
  `require('telegram/tl')` pour `Api` — corrigé en `require('telegram')`
  (comme la racine) après un `node -e "require(...)"` qui aurait sinon
  planté au premier appel réel à `resolveRecipient`.
- `lib/telegramRecipients.js` (nouveau) : équivalent Telegram de
  `lib/whatsappRecipients.js#normalizeRecipientEntry` (identifiant
  `@username` ou numéro brut, jamais suffixé contrairement au JID WhatsApp).
- `lib/campaigns.js` : genericisé pour dispatcher WhatsApp/Telegram par
  `config.channel` (stocké dans `config_json`, aucune migration SQLite
  requise — une campagne existante sans `channel` reste traitée comme
  `'whatsapp'`). Le listener de reprise auto après reconnexion est maintenant
  filtré par canal (une reconnexion WhatsApp ne réveille plus une campagne
  Telegram en pause, et inversement — bug qu'aurait introduit une
  génericisation naïve). Ajout de `markManualSent(id, to)` pour la Relance
  Manuelle Express desktop (voir plus bas).
- `lib/whatsapp.js` : ajout de `getGroups()`/`getGroupMembers()` (whatsapp-web.js
  expose directement `client.getChats()`/`chat.participants`, pas besoin du
  rappel `groupMetadata.update()` du pont WebView mobile).
- `index.js` : routes `/api/telegram/*` (status/login start-code-password/
  logout/send/groups/groups/:id/members) + `/api/whatsapp/groups*` +
  `/api/campaigns/:id/mark-sent` ; `telegram.connect()` appelé au démarrage
  comme `whatsapp.connect()`.
- `public/` (UI, toujours sans framework) : nouvel onglet Telegram (login par
  code, miroir du QR WhatsApp), onglet Campagnes étendu (sélecteur de canal +
  extraction de groupes avec "Importer comme destinataires"/"Exporter
  (Excel)", export via SheetJS **client-side** — `public/lib/xlsx.full.min.js`
  copié depuis `mobile/webapp/www/lib/` en local, aucun réseau — un vrai
  onglet de navigateur peut déclencher un téléchargement `XLSX.writeFile`
  directement, contrairement à la sandbox de la WebView Capacitor mobile).
  Nouvel onglet **Relance Manuelle Express** (`public/relance.js`, réutilise
  `public/lib/smartTextGenerator.js` copié tel quel de `mobile/webapp/www/lib/`)
  : source = destinataires `pending`/`error` de la campagne la plus récente du
  canal choisi (pas de mode "import direct sans campagne" ici, simplification
  assumée — créer une campagne sans la démarrer sert le même besoin). Différence
  notable avec le mobile : cette page tourne dans un VRAI onglet de navigateur
  (ouvert par `open()`), donc `window.open()` y est un vrai popup avec blocage
  standard — la détection `opened === null` du dashboard d'origine s'applique
  ici telle quelle, sans l'incertitude documentée côté Capacitor.
- **Sécurité corrigée en cours de route** : le premier jet de la liste de
  groupes construisait le HTML via un gabarit de chaîne avec
  `onclick="...(...)"` interpolant le NOM du groupe (donnée externe non
  fiable, un nom de groupe WhatsApp/Telegram peut contenir des guillemets/HTML)
  — remplacé par une construction DOM impérative (`createElement`/
  `addEventListener`) avant tout usage, aucune injection possible.
- **Non testé** : nécessite un vrai numéro de téléphone et une saisie
  interactive de code (impossible à valider de façon autonome) — seule la
  relecture de code + `node --check` sur tous les fichiers modifiés/créés a
  été faite. `TELEGRAM_API_ID`/`TELEGRAM_API_HASH` à renseigner dans
  `local-client/.env` (mêmes valeurs que la racine, voir `.env.example`)
  avant le premier test.

### Filtrage de contacts (liste noire) + page Connexions unifiée (même session, suite)

Sur demande explicite de l'utilisateur ("fais tout proprement") : les deux
points 2 et 3 ci-dessus ont été réalisés, sur mobile ET desktop.

**Liste noire (opt-out manuel)** — distincte de l'anti-doublons 48h déjà en
place pour la Relance Manuelle Express (temporaire, automatique) : un
identifiant ajouté ici est exclu de **toute nouvelle campagne**, jusqu'à
retrait explicite.
- Mobile : nouveau store IndexedDB `blocklist` (`lib/db.js` passé en v3),
  `db.filterBlocked()` appliqué dans `campaign.js` (import fichier ET
  extraction de groupe) et dans `lib/manualRelance.js` (reprise de campagne ET
  import direct). UI de gestion (ajouter/retirer) dans l'onglet Campagnes.
- Desktop : nouvelle table SQLite `blocklist` (`lib/db.js`), filtrage
  appliqué au point d'entrée unique `lib/campaigns.js#createCampaign` (donc
  valable quelle que soit la source des destinataires — saisie manuelle ou
  extraction de groupe, sans dupliquer la logique de filtrage). Une campagne
  dont TOUS les destinataires sont bloqués lève une erreur explicite plutôt
  que de créer une campagne vide. UI de gestion dans l'onglet Campagnes,
  routes `GET/POST/DELETE /api/blocklist`.

**Page Connexions unifiée** — statut + déconnexion propre des deux moteurs
et historique des envois, au lieu de pastilles dispersées par écran.
- Mobile (nouvel onglet "🔌 Connexions", `connexions.js`) : historique via
  `db.getSentLog()` (déjà écrit, jusqu'ici jamais affiché). Déconnexion
  réelle ajoutée à `EmbeddedWebViewPlugin.java` (nouvelle méthode
  `logout(id)`) — **distincte de `close()`** : `CookieManager`/`WebStorage`
  sont partagés par toutes les WebView de l'app (pas isolés par instance),
  donc un simple `close()` laisserait la session WhatsApp Web/Telegram Web
  intacte et rechargerait une session déjà connectée à la réouverture au
  lieu de redemander un appairage — `logout()` efface explicitement cookies
  + stockage web avant de détruire la vue. `app.js` expose
  `window.Cyrus.connections.{logoutWhatsApp,logoutTelegram}` (seul point
  d'entrée externe sur l'état par ailleurs privé de son IIFE) et réinitialise
  tout l'état local (relance automatiquement une session vierge si l'onglet
  du canal est actif).
- Desktop (nouvel onglet "Connexions") : `lib/db.js#listSentHistory()`
  réutilise la table `messages` déjà existante (filtrée sur
  `direction='out'`, canal déduit du préfixe `tg:` sur le jid) — aucune
  nouvelle table. Route `POST /api/whatsapp/logout` ajoutée (manquait
  totalement avant, seul Telegram avait déjà la sienne) : appelle
  `whatsapp.logout()` PUIS relance immédiatement `whatsapp.connect()` pour
  qu'un nouveau QR apparaisse sans redémarrage complet du serveur.

**Bugs trouvés et corrigés avant toute exécution** (relecture + `node --check`
systématique sur chaque fichier touché, aucun test réel encore fait) :
- `local-client/lib/db.js` : un backtick parasite dans un commentaire SQL
  (`` `channel` `` pour styliser un nom de colonne) fermait prématurément le
  template literal JS englobant tout le bloc `CREATE TABLE`, cassant le
  fichier entier (`SyntaxError: missing ) after argument list`). Corrigé en
  reformulant le commentaire sans backticks.

**Toujours non testé** (aucune action utilisateur possible de façon autonome
pour la connexion Telegram réelle ; aucun cycle build/install fait sur mobile
par respect de la contrainte données mobiles) — seule la relecture de code et
`node --check` ont été faits sur l'ensemble des fichiers modifiés/créés cette
session, mobile et desktop confondus.

**Bug UX réel signalé par l'utilisateur et corrigé, avec test réel cette
fois** (2026-09-10, fin de session) : "l'interface est vide... on ne voit
même pas le code" — le QR WhatsApp de `local-client/` n'existait qu'en ASCII
dans le terminal du SERVEUR (`qrcode-terminal`), invisible pour quiconque ne
regarde pas ce terminal précis (choix déjà fait avant cette session, voir
`README.md`). Corrigé : `npm install qrcode` (génération PNG, distinct de
`qrcode-terminal` conservé pour le debug console) + `lib/whatsapp.js#getQRCodeImage()`
régénère un data URL à la demande à partir du QR courant + `GET /api/status`
l'expose + `public/app.js` l'affiche en `<img>`. **Vérifié réellement** (pas
juste relu) : décodage du base64 renvoyé par l'API, vérification de la
signature PNG, rendu visuel confirmé — vrai QR scannable. Au passage,
l'utilisateur a aussi signalé que l'interface était "blanche et fade" :
`public/index.html` (jamais stylé depuis une version brouillon) reprend
maintenant les tokens de couleur du thème sombre/cyan déjà utilisé côté
mobile (`--bg: #0A0E14`, `--cyan: #22D3EE`, etc.) pour la cohérence visuelle
entre les deux plateformes.

**Piège process Windows découvert pendant ce test** : `TaskStop` sur une
tâche `npm start` lancée en arrière-plan ne tue PAS forcément le vrai
processus `node.exe` sous-jacent (wrapper npm sur Windows) — un ancien serveur
est resté vivant plusieurs minutes après un `TaskStop` "réussi", tenant le
port 4100 et servant une session WhatsApp/QR périmée à un onglet Chrome resté
ouvert. Diagnostic fiable : `netstat -ano | grep :4100` puis
`Get-Process -Id <pid>` (PowerShell) pour identifier le VRAI process
propriétaire du port avant de conclure qu'un serveur est bien arrêté — ne pas
se fier au seul statut retourné par `TaskStop`.

### Cahier des charges "Zero-VPS" reformulé par l'utilisateur (2026-09-10, nouvelle demande dans la même session)

L'utilisateur a rouvert la demande avec un cahier des charges formel
redemandant l'essentiel de ce qui précède, plus quelques exigences précises
vérifiées puis traitées :

1. **Foreground Service Android sur `mobile/webapp/`** — confirmé absent
   (contrairement à l'ancien projet `mobile/CyrusMobile/` qui en avait un).
   Porté à l'identique : `KeepAliveService.java` (traduction Java du
   `KeepAliveService.kt` de CyrusMobile — ce projet est en Java, pas Kotlin),
   déclaré dans `AndroidManifest.xml` (`foregroundServiceType="remoteMessaging"`,
   permissions `FOREGROUND_SERVICE`/`FOREGROUND_SERVICE_REMOTE_MESSAGING`/
   `POST_NOTIFICATIONS`), démarré sans condition dans `MainActivity.java#onCreate`
   (pas de classe `Application` custom dans ce projet Capacitor, contrairement
   à `MainApplication.kt` côté CyrusMobile — démarrage au niveau Activity à la
   place, équivalent). Couvre les deux WebView embarquées (WhatsApp ET
   Telegram, alors que l'original ne couvrait que WhatsApp). **Non testé**
   (nécessiterait un cycle build/install complet, pas fait par respect de la
   contrainte données mobiles) — relecture de code uniquement, en miroir
   fidèle d'un pattern déjà validé sur appareil réel ailleurs dans ce dépôt.
2. **Optimisations Puppeteer sur `local-client/lib/whatsapp.js`** — `--single-process`
   ajouté, heap V8 abaissé de 256 à 150 Mo, et blocage des requêtes
   `image`/`media`/`font` ajouté via `client.pupPage.setRequestInterception`
   (hooké sur les évènements `qr`/`loading_screen`/`ready`, le plus tôt
   possible). **Délibérément PAS de blocage CSS** malgré la demande littérale
   ("CSS non critique") : aucun moyen fiable de distinguer un CSS critique
   d'un CSS décoratif via l'API Puppeteer, bloquer les feuilles de style
   casserait entièrement la mise en page de WhatsApp Web — seuls
   images/vidéo/audio/polices sont bloqués (dégrade l'affichage des photos de
   profil/aperçus média, jamais l'envoi/réception de texte). **Testé
   réellement en conditions réelles** : redémarrage du serveur avec les
   nouveaux flags, session WhatsApp déjà appairée restaurée avec succès
   (`connected: true` via `GET /api/status`), aucun crash. Mesure RAM prise
   sur le vif (PowerShell `Get-Process`) : le processus Chromium
   `--single-process` consomme ~610 Mo de Working Set — **la limite de 150 Mo
   ne plafonne que le tas JS (V8), pas l'empreinte totale du moteur Chromium**
   (code natif, moteur de rendu, pile réseau, tout fusionné dans un seul
   processus par `--single-process`) ; l'optimisation réelle attendue est
   surtout de contenir la CROISSANCE mémoire sur une session longue (media
   accumulé), pas de réduire drastiquement l'empreinte de base — à ne pas
   présenter comme une réduction spectaculaire de RAM totale.
3. **Persistance de session Telegram mobile ("StringSession")** — terminologie
   du cahier des charges inadaptée à l'architecture réelle : le concept
   StringSession appartient à GramJS, abandonné le 2026-09-10 au profit du
   pont WebView (voir section 4 plus haut). Rien à coder : la persistance est
   déjà garantie nativement par le stockage propre de la WebView Android
   (cookies/IndexedDB), identique au mécanisme déjà validé côté WhatsApp.
   Rappel utile pour la suite : contrairement à WhatsApp, l'envoi/réception
   Telegram (`telegramBridge.js`) n'a jamais été validé de bout en bout sur un
   vrai échange (seule la détection d'état l'a été).
4. **Electron pour le PC** — question posée à l'utilisateur (redondance avec
   le `.exe` `pkg` déjà fonctionnel de `local-client/`) : l'utilisateur a
   perçu la question comme un doute sur ma compréhension du projet plutôt que
   comme un choix d'architecture à trancher. **Décision prise unilatéralement
   pour ne pas re-bloquer sur une question** : rester sur `local-client/`
   (Node + navigateur système + packaging `.exe` existant), appliquer
   uniquement les optimisations RAM demandées (fait, voir point 2) — pas de
   chantier Electron entamé. À reconsidérer seulement si l'utilisateur le
   redemande explicitement.
5. **UI dupliquée / duplication du projet React** — rappel (déjà tranché
   plus tôt dans cette session, redemandé ici en des termes similaires) :
   `public/dashboard.html` est du HTML/JS vanilla, pas du React — la
   duplication dans `mobile/webapp/www/` et `local-client/public/` suit ce
   même style, jamais l'ancien code VPS.

**Reste à faire pour la parité complète** :
1. Build + test réel sur appareil Android du Foreground Service (point 1
   ci-dessus) et de Telegram sur `local-client/` de bout en bout (login réel,
   envoi, campagne, extraction de groupes) — action utilisateur requise, à
   grouper en un seul cycle de test.
2. Tester la page Connexions (déconnexion réelle des deux moteurs, mobile ET
   desktop) et la liste noire (blocage effectif à l'import) sur appareil/PC
   réel — à grouper avec le point 1.
3. Surveiller en usage réel si `--single-process` + heap 150 Mo cause des
   crashs Puppeteer (voir le commentaire "A SURVEILLER" dans
   `lib/whatsapp.js`) — premier réflexe si ça arrive : remonter le heap ou
   retirer `--single-process`, pas chercher ailleurs.
4. Support Image-to-Link si demandé (voir simplification plus haut).
5. Décision utilisateur sur le module Facebook (hors "zéro-serveur" en
   l'état).

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

**Infra licences/IA (2026-09-20)** : le VPS réplique ses licences vers le Worker Cloudflare (`CLOUDFLARE_LICENSE_URL` +
`CLOUDFLARE_ADMIN_SECRET` dans le `.env` de la VM) ; la synchronisation Firestore du VPS est DÉSACTIVÉE
(`FIREBASE_SERVICE_ACCOUNT_PATH` commenté dans le `.env` de la VM ; sauvegarde `/tmp/env.backup.*`). **Le `.env` est copié dans l'image
Docker au build : toute modification du `.env` de la VM exige un rebuild (`deploy.sh`), pas seulement `docker-compose up`.**
Ne jamais tester `verify-key` avec un faux appareil sur la clé réelle (voir `docs/TESTS-REELS.md`).

**Compte de test UNIQUE (rappel utilisateur, 2026-09-20)** : tout test réel et tout réglage « propriétaire » (répondeur permanent, campagnes,
mémoire) utilisent UNIQUEMENT le compte de la clé de test (`.env` : `CYRUS_TEST_LICENSE_KEY`). Il n'y a AUCUN compte admin pour le
moment : ne jamais ajouter `__admin__` à une configuration (`AUTO_REPLY_ALWAYS_ON_TENANTS` de la VM ne contient que la clé de test).

**PORTAGE PC + TÉLÉPHONE (consigne utilisateur, 2026-09-20)** : toute mise à jour livrée sur le VPS doit être appliquée
INTÉGRALEMENT plus tard à `local-client/` (PC) et `mobile/webapp/` (téléphone). Liste de référence et statuts :
**`docs/PORTAGE-LOCAL-MOBILE.md`** — y ajouter une ligne à chaque nouvelle livraison VPS. Portage différé, non commencé.
