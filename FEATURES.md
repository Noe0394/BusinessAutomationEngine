# Inventaire complet des fonctionnalités — CYRUS SUPER ASSISTANT

Document généré le 2026-09-10 à la demande explicite de l'utilisateur ("scanne
tout le projet... liste globale de toutes les fonctionnalités, aussi infime
soit-elle"). Compilé à partir d'un scan en lecture seule de l'intégralité du
dépôt (backend VPS, Firebase, interface web, chantier Zero-VPS mobile et
desktop, projets mobiles). Aucun fichier n'a été modifié pour produire ce
document.

Légende de statut : ✅ fonctionnel et utilisé en production/testé · 🟡 présent
mais partiel/non testé de bout en bout · ⛔ désactivé/abandonné · ⚠️ état
contradictoire ou incertain (voir note).

---

## 1. Backend VPS principal (`index.js` racine + `adapters/` + `lib/` + `queues/`)

C'est le système d'origine, déployé en continu sur Render. **Rien ici n'a été
touché par le chantier Zero-VPS.**

### 1.1 Authentification, licences, administration
- ✅ Connexion dashboard client par mot de passe, portail admin séparé (même mot de passe, route cachée `/admin-secret-portal`).
- ✅ Vérification de clé de licence + liaison à un appareil (`deviceId`), CRUD complet des licences (créer/lister/activer-désactiver/modifier modules+expiration/délier un appareil/supprimer) depuis l'admin.
- ✅ Configuration des identifiants OAuth (Google/Facebook/TikTok) depuis l'admin, jamais réaffichés en clair après saisie.
- ✅ Tableau de bord admin agrégé (usage, statut de stockage des sessions, causes de refus de licence).
- ✅ Vérification de mise à jour pour `local-client/` (`GET /api/check-update`).
- ✅ Sondes de vie publiques (`/health`, `/ping`) pour un keep-alive externe.
- ✅ Pages légales publiques (confidentialité, CGU, suppression de données) exigées par Meta.
- ✅ PWA installable (`manifest.json`, `sw.js`, icône) — "Ajouter à l'écran d'accueil".

### 1.2 WhatsApp (moteur Baileys, celui réellement actif en prod)
- ✅ Connexion par QR code **et** par code d'association numérique (deux modes).
- ✅ Cache de noms de profil (3 clés d'identité mémorisées), synchronisation complète de l'historique à l'appairage.
- ✅ Distinction fine révocation (nouveau QR) vs coupure réseau (reconnexion simple), sérialisation stricte connect/logout anti-corruption de session.
- ✅ Sauvegarde de session sur GitHub (uniquement `creds.json`, jamais les clés Signal) — restauration au redémarrage, snapshot périodique, purge à la déconnexion.
- ✅ Reconnexion automatique de **toutes** les clés déjà appairées au démarrage du serveur.
- ✅ Isolation multi-tenant stricte (une instance par clé de licence), connexion paresseuse.
- ✅ Régulateur de capacité : plafond de sessions simultanées avec éviction de la session la moins prioritaire, tenant admin protégé, balayage périodique des sessions inactives.
- ✅ Liste des groupes + membres, avec gestion dédiée de l'erreur de rate-limit WhatsApp.
- ✅ Export Excel consolidé de plusieurs groupes sélectionnés (dédoublonnage multi-groupes, traitement par tranches pour la RAM, résolution du numéro réel même derrière un identifiant `@lid` anonymisé).
- ✅ Import de contacts Excel/CSV, création de campagne directement depuis un fichier Excel.
- ✅ Moteur de campagne complet : file multi-campagnes, une seule active à la fois avec bascule instantanée, statuts par destinataire, pause/reprise/stop, persistance locale+GitHub, reprise exacte sans doublon après coupure.
- ✅ Smart Screening anti-doublons (empreinte de message + fenêtre 1h-30j configurable).
- ✅ Séquences multi-étapes (texte+médias combinés) avec délai entre étapes.
- ✅ Cadencement anti-ban non contournable côté frontend (délai aléatoire, pause de courtoisie périodique), pause automatique 30s si un contact répond pendant l'envoi.
- ✅ Coupe-circuit réseau (`circuitBreaker.js`) : détection de surcharge/latence, pause avec health-check avant reprise.
- ✅ Purge automatique des campagnes fantômes (48h sans signe de vie), élagage de l'historique (20 dernières campagnes conservées).
- ✅ Mode Manuel Express (deep links `wa.me`) avec file dédiée et marquage manuel synchronisé avec le moteur auto.
- ✅ Envoi direct de média (image/vidéo/document), compression vidéo automatique si >15 Mo (ffmpeg, résolution adaptative, repli en pièce jointe "document" si la compression échoue).
- ✅ Réponse conversationnelle automatique (`/api/chat-natural`).
- 🟡 Moteur alternatif whatsapp-web.js côté VPS : présent dans le code mais **désactivé en production** (faute de place disque) — reste actif uniquement en usage local (voir section 4).

### 1.3 Telegram (MTProto/GramJS)
- ✅ Login numéro→code→mot de passe 2FA, session `StringSession` persistée disque+GitHub.
- ✅ Reconnexion automatique avec backoff exponentiel, heartbeat périodique, détection de changement de compte (réinitialise les campagnes de l'ancien compte).
- ✅ Liste groupes/canaux, résolution destinataire par `@username` ou numéro (`contacts.importContacts`).
- ✅ Moteur de campagne symétrique à WhatsApp (multi-campagnes, anti-doublons, coupe-circuit, purge, Mode Manuel) avec deux différences : un seul média par campagne (pas de séquence), et un double mode destinataires (contacts vs groupes) sur un même moteur.
- ✅ Sous-module DM dédié avec délai de sécurité **verrouillé entre 30 et 60s** (non réductible, contrairement aux autres canaux) — anti-flood Telegram spécifique.
- ✅ Respect exact d'un `FLOOD_WAIT` Telegram (attend la durée précise exigée par l'API).

### 1.4 Facebook / Meta
- ✅ OAuth Page (App ID/Secret ou portail admin), déconnexion, récupération auto de la Page + compte Instagram Pro lié.
- ✅ Publication sur la Page (texte/lien/photo/vidéo) avec programmation (10 min-75 jours), PDF explicitement rejeté (limite API Meta).
- ✅ Groupes Facebook gérés (liste manuelle — Meta ne permet pas de les lister automatiquement) : publication en masse avec délai aléatoire, export Excel des membres.
- ✅ Partage assisté dans les groupes (contournement du retrait de la permission `publish_to_groups`) : préparation de contenu (post existant/lien manuel/rédaction dédiée), copie presse-papiers, ouverture de la fenêtre de partage officielle par groupe, suivi de statut.
- ✅ Capture de prospects : règles de réponse auto par mot-clé sur commentaires/messages, réponse privée à un commentaire (sans violer la règle des 24h Messenger), liste de prospects filtrable par mot-clé/source, export Excel.
- ✅ Modération de commentaires (lister/répondre/masquer-démasquer/supprimer), vérification de signature HMAC des webhooks.
- ✅ Messenger : liste conversations, envoi message/média, campagne DM en masse avec régulateur de débit (pause normale + pause triplée périodique), mise en correspondance de contacts importés avec les conversations existantes via PSID.
- ✅ Publication vidéo multi-plateforme réutilisant le même contenu : YouTube Shorts (OAuth Google, hashtag auto, programmation), TikTok (Login Kit, upload en 3 étapes), Instagram Reels (jeton Facebook réutilisé, polling de rendu).

### 1.5 Studio IA / Médias (le module le plus riche du produit)
- ✅ Cascade LLM multi-fournisseurs (Groq→Gemini→OpenRouter→HuggingFace→repli garanti sans clé) pour texte, cascade image (fal.ai FLUX→Pollinations), cascade vidéo image-to-video (fal.ai→Replicate→HuggingFace/Gradio), sélection explicite d'un fournisseur alternatif.
- ✅ Moteur de réponse 100% local sans LLM (système expert par mots-clés) en secours.
- ✅ Base de connaissances marketing statique (8 sujets : Ads Facebook/Google/TikTok, AIDA/PAS, closing, anti-ban, marché Afrique de l'Ouest).
- ✅ Guide de support produit intégré au chat (10 parcours pas-à-pas : connexion WhatsApp, Spintax, Studio IA, PDF, Relance Express, Facebook, YouTube/TikTok, PWA, statut hébergement).
- ✅ 7 "compétences expertes" invocables par module : Directeur Design (affiches), Cinéaste (script caméra), Planificateur de Livre, UGC + relance contact, Format Mobile (sous-titres TikTok/Reels), Automatisation Faceless (scripts B-Roll).
- ✅ Assistant conversationnel "Chat-First" : sessions multiples avec historique persistant, détection d'intention (chat/image/vidéo/livre) qui garde le fil d'une planification en cours, pièce jointe (image/vidéo/PDF), rendu coûteux déclenché seulement sur clic explicite.
- ✅ "Directeur Artistique IA" : un seul appel génère secteur détecté + accroche + prompt image + script vidéo + formats suggérés.
- ✅ Studio Média (CYRUS Predictive Media Engine, majoritairement client-side) : 5 secteurs presets, 4 formats, 3 types de livrable (photo/affiche avec habillage texte réel via satori+resvg/vidéo courte), génération de 3 propositions simultanées, édition post-génération, export PNG HD.
- ✅ "Image-to-Link" : hébergement éphémère + page avec balises Open Graph pour un aperçu WhatsApp/Telegram d'une image/vidéo.
- ✅ Export vidéo Ken Burns avec sous-titres mot-à-mot (narration en aperçu via synthèse vocale navigateur, export final silencieux par limitation technique).
- 🟡 Storyboard multi-scènes IA (2-8 scènes chaînées, continuité visuelle par réutilisation de la dernière frame) — présent, complexité élevée, pas de statut de test explicite trouvé.
- ✅ Montage/mixage de plusieurs clips personnels en vidéo verticale habillée (recadrage "cover" pour uniformiser les ratios).
- ✅ Génération de livre PDF complet (couverture, sommaire à vrais numéros de page, chapitres, citations, filigrane) — 100% local, aucun réseau pour le rendu.

### 1.6 Planification transverse
- ✅ Publications/messages programmés multi-canal (WhatsApp/Telegram/Facebook) avec statuts et limite de 5 tentatives, séquençage multi-étapes (WhatsApp uniquement), étiquette cosmétique de repérage.

### 1.7 Modèles de données (fichiers JSON, pas de vraie base de données)
- ✅ `models/contact.js` : profils de prospects Messenger, mise à jour sans jamais perdre un mot-clé déjà qualifié.
- ✅ `models/keyword_rules.js` : CRUD de règles mot-clé→réponse auto.
- ✅ `models/scrapedNumbers.js` : buffer d'extraction de groupes écrit au fil de l'eau (jamais accumulé en RAM).

### 1.8 Build & outillage
- ✅ Obfuscation du dashboard au build (`javascript-obfuscator`), servi automatiquement en prod si présent.
- ✅ Surveillance/redémarrage externe via l'API Render (`keep_alive_recovery.js`).

---

## 2. Micro-service séparé (`server/`, déployé sur Koyeb)

Un second connecteur WhatsApp Baileys, indépendant du backend principal — construit pour le polling mobile sans webhook entrant.

- ✅ Connexion/reconnexion Baileys éprouvée (timeout QR 120s, backoff 3s→5min), détection de session révoquée avec régénération auto.
- ✅ Appairage par QR (image PNG) **ou** par code à 4 groupes de 4 chiffres.
- ✅ Envoi texte/média direct, `GET /messages` (file en mémoire, 200 messages max, pagination) pour un client mobile derrière NAT sans webhook possible.
- ✅ Déconnexion + purge + ré-appairage immédiat, webhooks sortants (message/qr/connexion/reset de compte), authentification par secret partagé.
- ✅ Sauvegarde de session GitHub identique au principe du VPS principal.

---

## 3. Firebase (`firebase-functions/`, projet `rien-afrique` PARTAGÉ avec RIEA AFRIQUE — jamais toucher aux règles Firestore ni déployer sans cibler précisément)

Bascule de secours si le VPS est injoignable — Firestore est la base de licences PARTAGÉE avec le VPS (pas un simple miroir).

- ✅ CRUD licences complet (créer/lister/modifier modules+expiration/activer-désactiver/supprimer), protégé par secret admin distinct de celui du VPS.
- ✅ `verifyLicenseOffline` — peut lier un nouvel appareil automatiquement (compromis de sécurité assumé).
- ✅ Cascade IA texte/image identique à celle du VPS (dupliquée volontairement, runtime Cloud Functions séparé).
- ✅ Génération vidéo IA asynchrone (job Firestore + polling), rapatriement systématique en Firebase Storage (URL signée 7 jours).
- ✅ Mise à jour silencieuse de `local-client/` (métadonnées publiques + publication admin).
- ✅ Interface admin web dédiée (`cyrus-license-admin.web.app`) : création/recherche/gestion/renouvellement de licences, lien vers le back-office RIEA AFRIQUE.
- ⛔ `firestore.rules` : fichier mort, plus référencé par `firebase.json` depuis l'incident du 2026-09-09 (déploiement ayant écrasé le ruleset de RIEA AFRIQUE 42 min) — conservé pour mémoire uniquement.

---

## 4. Interface web du VPS (`public/dashboard.html`, HTML/JS vanilla — PAS du React)

L'interface de référence, dupliquée (pas modifiée) pour le chantier Zero-VPS.

- ✅ Connexion par clé de licence unique, hub "Connexions & Intégrations" centralisant WhatsApp (QR ou code mobile)/Telegram/Facebook/YouTube/TikTok.
- ✅ Onglets WhatsApp et Telegram : liste groupes avec recherche/sélection multiple, export Excel, import de contacts par glisser-déposer, Centre d'Envoi Multi-Médias (séquences d'étapes), réglages anti-ban (lot/délai/pause/anti-doublons), suivi de campagne en direct, gestionnaire multi-campagnes.
- ✅ Sous-module DM Telegram séparé avec délai verrouillé 30-60s.
- ✅ Onglet Facebook : relance contacts qualifiés, publication/programmation Page, planificateur de contenu maison, gestion groupes gérés.
- ✅ Onglet Programmation multi-canal unifié.
- ✅ Onglet Contacts/Prospects (règles mots-clés + liste filtrable + export).
- ✅ Onglet Groupes/Diffusion (partage assisté Facebook).
- ✅ Onglet Relance Manuelle Express (deep links, variantes A/B/C, SmartText, Image-to-Link, Mode Série Continu, raccourcis clavier).
- ✅ Onglet Studio IA (verrouillé par module de licence) : assistant conversationnel, générateur de livres, Studio Média complet.
- ✅ Composants transverses : générateur de texte "Copywriter IA" réutilisé sur tous les formulaires, upload universel "Image-to-Link", PWA installable.

---

## 5. Chantier "Zero-VPS" — PC (`local-client/`, Node + Express + navigateur système)

Construit/étendu dans cette session. Packaging `.exe` autonome existant (`@yao-pkg/pkg`).

- ✅ Vérification de licence Firebase-first avec repli VPS, auto-update silencieux avant démarrage.
- ✅ WhatsApp (whatsapp-web.js/Puppeteer) : QR affiché en vraie image PNG dans le navigateur (corrigé cette session — n'existait qu'en ASCII terminal auparavant), envoi/réception, déconnexion propre avec reconnexion auto, extraction groupes+membres.
- ✅ Optimisations RAM Puppeteer : `--single-process`, heap V8 à 150 Mo, blocage des requêtes images/vidéo/audio/polices (CSS volontairement épargné).
- ✅ Telegram (GramJS) : login numéro→code→2FA, statut/déconnexion, envoi, extraction groupes+membres, résolution destinataire.
- ✅ Campagnes : création multi-canal (WhatsApp/Telegram), Spintax+personnalisation, délai aléatoire configurable, démarrage/pause/annulation, **reprise automatique après redémarrage de l'app en pleine campagne**, suivi envois/échecs.
- ✅ Export Excel des membres de groupe (SheetJS côté navigateur).
- ✅ Liste noire (blocklist) par canal, appliquée systématiquement à la création de toute campagne (point d'entrée unique, quelle que soit la source des destinataires).
- ✅ Relance Manuelle Express (deep links `wa.me`/`t.me`) : reprise des destinataires pending/error de la dernière campagne, variantes A/B/C, génération de texte via intention, ouverture réelle en popup navigateur (détection de blocage fonctionnelle, contrairement au mobile).
- ✅ Page Connexions unifiée : statut+déconnexion des deux moteurs, historique des envois.
- 🟡 Génération IA texte/image et génération de livre PDF : routes API fonctionnelles (`/api/ai/*`, `/api/ebook/generate`) mais **sans bouton dédié dans l'interface actuelle** — accessible via API seulement.
- ⚠️ Thème visuel repris du mobile (dark/cyan) cette session suite à un retour utilisateur ("blanc et fade") — pas encore revu par l'utilisateur au moment de ce document.

---

## 6. Chantier "Zero-VPS" — Mobile (`mobile/webapp/`, Capacitor/Android)

Construit dans cette session, remplace `mobile/CyrusMobile/` (voir section 7).

- ✅ WhatsApp : WebView Android native + injection JS (`whatsappBridge.js`) sur `web.whatsapp.com`, User-Agent desktop, connexion/déconnexion réelle (cookies+stockage effacés), liste conversations, envoi/réception **validés de bout en bout sur appareil réel**.
- 🟡 Telegram : même principe (`telegramBridge.js`) sur `web.telegram.org/k/` — détection d'état confirmée sur appareil réel, mais **envoi/réception jamais validés de bout en bout** (contrairement à WhatsApp).
- ✅ Génération IA texte/image via licence Firebase.
- ✅ Campagnes : import Excel/CSV, extraction de groupe, Spintax+personnalisation, envoi séquentiel avec délai configurable, démarrage programmé, pause, **persistance IndexedDB avec reprise après fermeture d'app** (corrigé cette session — ne fonctionnait pas malgré un commentaire l'affirmant).
- ✅ Export Excel/CSV des membres de groupe (Capacitor Filesystem/Share).
- ✅ Liste noire par canal, filtrage à l'import fichier et à l'extraction de groupe.
- ✅ Relance Manuelle Express : reprise de campagne ou import direct avec anti-doublons 48h, variantes A/B/C, Mode Série Continu (décompte auto), compteur de rythme, deep links, raccourcis clavier.
- ✅ Page Connexions : statut+déconnexion réelle des deux moteurs (nouveau plugin natif `logout()`, distinct du simple `close()`), historique des envois.
- ✅ Foreground Service Android (ajouté cette session) pour maintenir les WebView actives écran verrouillé/app en arrière-plan.
- 🟡 Pas de support Image-to-Link (nécessiterait un hébergement public, incompatible "zéro serveur" tel quel — simplification assumée).
- ⛔ Module Facebook : absent (dépend structurellement d'un backend OAuth) — décision utilisateur encore en attente.

---

## 7. Projet mobile antérieur (`mobile/CyrusMobile/`, React Native) — largement remplacé par la section 6

- ✅ **`WhatsAppWebEngine.tsx` + `whatsappWebBridge.ts`** : moteur WhatsApp via WebView, **validé de bout en bout sur appareil réel** (le prototype dont `mobile/webapp/` est directement issu).
- 🟡 Pairing WhatsApp/Baileys embarqué (`App.tsx` + runtime Node `nodejs-mobile-react-native`) : UI fonctionnelle mais moteur **bloqué** (protocole WhatsApp trop daté pour un nouvel appairage, documenté dans `CLAUDE.md`).
- ✅ Génération IA texte/image (`AiEngine.tsx`) fonctionnelle.
- ⚠️ **Telegram embarqué (`TelegramEngine.tsx` + `nodejs-project/telegram.js`)** : code complet (login, dialogues, envoi) MAIS état contradictoire découvert lors de ce scan — le commentaire de tête du fichier affirme que Telegram/GramJS n'a jamais crashé sur ce runtime, alors que `CLAUDE.md` documente précisément un crash natif ayant motivé l'abandon de tout ce projet au profit de `mobile/webapp/`. `main.js` charge ce module sans aucun filet de sécurité (pas de try/catch) — si le crash documenté est toujours réel, son seul fait d'exister ferait planter l'app entière au démarrage. **À vérifier avant toute confiance ; ne pas relancer ce projet sans clarifier ce point.**
- Foreground Service Android (`KeepAliveService.kt`) — modèle dont celui de `mobile/webapp/` (section 6) est la traduction directe.

**Statut global de ce projet à trancher avec vous** : semble abandonné de fait au profit de `mobile/webapp/`, mais jamais formellement déclaré comme tel dans le dépôt.

---

## Notes de fond (hors fonctionnalités, mais pertinentes)

- `firebase-functions/videoAiEngine.js` est une quasi-copie de `lib/media/videoAiEngine.js` (racine) — dupliqué volontairement (runtime Cloud Functions séparé), à resynchroniser manuellement si l'un évolue.
- `server/lib/githubStore.js` n'a pas été comparé ligne à ligne au `githubStore.js` racine — probablement identique, non confirmé.
- Ce document reflète l'état du code au 2026-09-10. Le journal détaillé des décisions et de l'historique de développement reste `CLAUDE.md` (racine) — ce fichier-ci est un instantané des fonctionnalités, pas un journal de session.
