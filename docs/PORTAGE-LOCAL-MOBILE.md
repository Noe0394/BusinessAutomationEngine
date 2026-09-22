# Portage des mises à jour VPS vers PC (`local-client/`) et téléphone (`mobile/webapp/`)

**Consigne utilisateur (2026-09-20, précisée le 2026-09-22)** : toutes les mises à jour faites sur le VPS
doivent être appliquées INTÉGRALEMENT au PC et au téléphone, SAUF ce qui les différencie structurellement
(WhatsApp/Telegram tournent en LOCAL sur chaque appareil, jamais sur un VPS — zéro dépendance VPS). Les
interfaces (dashboard) doivent être IDENTIQUES sur les trois cibles. Ce fichier est la liste de référence :
toute nouvelle livraison VPS y ajoute une ligne. **Portage démarré le 2026-09-22** (PC en premier).

Statuts : `À FAIRE` = non commencé, `PARTIEL` = commencé, `FAIT` = livré et vérifié.
Le PC et le téléphone gardent leur mode « zéro serveur » : le portage adapte, il ne branche pas ces apps sur le VPS.
Quand un appel réseau distant est réellement nécessaire (licences, génération IA lourde), il pointe vers
Cloudflare (`cloudflare/license-worker/`), JAMAIS vers Firebase/Firestore ni vers le VPS central.

**Écart constaté à l'audit du 2026-09-22** : `local-client/ai-engine/` n'avait que 13 fichiers sur les ~75 de
l'`ai-engine/` VPS (62 absents), et les 13 présents étaient pour la plupart des copies anciennes désynchronisées
(jusqu'à 1785 lignes d'écart). `mobile/webapp/` n'a AUCUNE trace des concepts clés du moteur IA (conversationEngine,
alertCenter, businessServices, communityDiscovery, autoResponder, etc.) — le téléphone n'a pas de backend Node
(voir CLAUDE.md section 3-4 : l'embarquement d'un runtime Node sur mobile — `nodejs-mobile-react-native` — a été
tenté puis ABANDONNÉ le 2026-09-10, GramJS/Telegram fait planter le process natif ; ne pas retenter cette piste).
Ordre de dépendances techniques établi par l'audit (à respecter, indépendant des priorités business) :
1. `lib/ai/llmFallbackEngine.js` + dépendances (cascade IA — bloque tout le reste) — **FAIT côté PC le 2026-09-22**.
2. `toolRegistry.js` + `authz.js` + `untrusted.js` (pont technique central de `chatOrchestrator`).
3. `ai-engine/jarvis/agentLoop.js` (seul fichier manquant du dossier jarvis côté PC) + resynchroniser `conversationEngine.js`.
4. `contactIdentity.js` (requis par alertCenter/ownerChannel/groupCampaigns/communityDiscovery).
5. `alertCenter.js` + `ownerChannel.js` + `pendingActions.js` (canal propriétaire — requis avant le répondeur contextuel).
6. `businessServices.js` (requis par autoResponder/groupCampaigns/adCampaigns).
7. `autoResponder.js` + `alwaysOn.js` + `responderKeeper.js` + `clientAiQuota.js`/`clientLimitGuard.js`.
8. `conversationRouter.js`/`conversationContext.js`/`conversationPolicy.js`/`engagement.js`/`botSignature.js`/`claimGuard.js` (répondeur contextuel).
9. Reste (communautés, campagnes, apprenants, cycle de vie, task queue) — peu de dépendances croisées entre eux, ordonnable librement.

**Suivi séparé nécessaire** : `local-client/lib/aiGateway.js` (utilisé par `local-client/index.js` pour la
génération d'image/vidéo/PDF longue) pointe encore vers Firebase Functions en priorité — à repointer vers le
Worker Cloudflare (`cloudflare/license-worker/src/media.js`/`textCascade.js`) pour respecter la consigne
"Cloudflare, jamais Firebase". Non fait, distinct du portage `ai-engine/` ci-dessus. Corrigé au passage : la
description de `local-client/package.json` affirmait à tort une dépendance VPS pour l'IA/les licences — mise à
jour pour refléter la consigne "zéro dépendance VPS" actuelle.

| # | Mise à jour VPS (branche `feat/jarvis-engine`, fusionnée dans `main`) | Fichiers VPS principaux | PC | Téléphone |
|---|---|---|---|---|
| 1 | Moteur conversationnel Jarvis (refus respecté, anti-répétition, NO_ACTION, file/debounce, agent multi-outils, exécution directe des ordres sans contradiction) | `ai-engine/jarvis/*`, `chatOrchestrator.js`, `toolRegistry.js` | À FAIRE | À FAIRE |
| 2 | Mémoire 7×24 h par jour (segments par jour, verrous, historique WhatsApp à l'appairage, messages sortants, outil `queryMemory`) | `ai-engine/messageHistory.js`, `memoryQuery.js`, adapters Baileys | À FAIRE | À FAIRE |
| 3 | Répondeur permanent (compte « toujours actif », gardien de sessions, réglages `/api/auto-responder`) | `ai-engine/alwaysOn.js`, `responderKeeper.js`, `autoResponder.js` | À FAIRE | À FAIRE |
| 4 | Import de numéros : coller une liste, Excel/CSV, photo OCR, normalisation, doublons, validation, compteurs et tableau des statuts, intégrés aux onglets WhatsApp et Telegram | `ai-engine/contactsPipeline.js`, `ocrProvider.js`, `public/dashboard.html` (`impBuild`) | À FAIRE | À FAIRE |
| 5 | Campagnes suivies dans les onglets WhatsApp/Telegram : statuts, programmation, pause/reprise/annulation, rapport CSV, protection + reprise automatique + continuité manuelle | `ai-engine/campaignService.js`, `lib/campaignStatus.js`, `queues/*`, `public/dashboard.html` (`cmpMount`) | À FAIRE | À FAIRE |
| 6 | File de tâches + worker (lancement programmé) | `ai-engine/taskQueue*` | À FAIRE | À FAIRE |
| 7 | Licences et IA sur Cloudflare (Worker + D1) à la place de Firebase : clients déjà basculés côté `local-client/lib` et mobile pour l'URL, à revérifier | `cloudflare/license-worker/`, `lib/cloudflareSync.js` | PARTIEL (licences ; IA texte = cascade directe, voir ligne "Livraison 2026-09-21" plus bas ; `aiGateway.js` image/vidéo encore sur Firebase, à migrer) | PARTIEL |
| 8 | Clé créée dans le générateur Cloudflare reconnue tout de suite par le VPS (synchronisation immédiate) | `licenses.js` | À FAIRE (vérifier `local-client/lib/license.js`) | À FAIRE |
| 9 | CORS : origine identique au Host acceptée (domaine DuckDNS) | `index.js` | Sans objet (pas de CORS local) | Sans objet |
| 12 | Campagnes de groupes administrés (ciblage, scheduler, intérêt, preuve, objectif) | `ai-engine/groupCampaigns.js`, `groupCampaignParser.js`, `toolsExtra.js`, `chatOrchestrator.js`, `assistantLayer.js`, `index.js` | À FAIRE | À FAIRE |
| 11 | Campagnes Facebook Ads (Service Métier : configuration Chat, origine, message initial exact) | `ai-engine/adCampaigns.js`, `adCampaignParser.js`, `businessServices.js`, `toolsExtra.js`, `chatOrchestrator.js` | À FAIRE | À FAIRE |
| 10 | Couche d'assistance générale : identité des contacts (JID/LID ≠ numéro), routage privé/métier, centre d'alertes, canal propriétaire (self-chat → Chat Intelligent), actions en attente `PA-XXXX` + OUI/NON, vérification API, import de listes appliqué à la source d'envoi | `ai-engine/{contactIdentity,alertCenter,conversationRouter,ownerChannel,pendingActions,assistantLayer,manualPaymentValidator}.js`, `adapters/whatsappEngineBaileys.js` (indices d'identité, self-chat), `lib/whatsappRecipients.js` (déjà copié dans `local-client/lib`), `public/dashboard.html` (`impBuild`) | PARTIEL (`whatsappRecipients.js` seulement) | À FAIRE |

## Règles de portage à respecter
- Reprendre le comportement, pas le code VPS tel quel : le PC et le téléphone restent locaux (WhatsApp local, SQLite/IndexedDB).
- Copier à la main les fichiers purs partagés (`local-client/lib/` contient des copies, voir CLAUDE.md) et les resynchroniser.
- Compte de test unique pour tout test réel : celui de la clé de test (`.env`, `CYRUS_TEST_LICENSE_KEY`), jamais de compte admin.
- Données mobiles limitées : grouper les builds/installations APK en un seul cycle.
- Le design de référence reste celui du dashboard VPS.

## Livraison VPS 2026-09-21 — Chat intelligent : gateway IA, sécurité, médias, conversation commerciale, limite par client
À porter INTÉGRALEMENT vers `local-client/` (PC) et `mobile/webapp/` (téléphone) :
- `lib/ai/llmFallbackEngine.js` + `lib/ai/aiErrors.js` (routage Gemma 4 31B → Gemma 4 26B → Flash → Groq → OpenRouter → HF…, capacités, retry ciblé, erreurs génériques) ; copies : `firebase-functions/index.js` (NE PAS toucher, projet partagé RIEA) et `cloudflare/license-worker/src/textCascade.js`.
  **PC : FAIT le 2026-09-22.** Copie conforme + `lib/ai/marketingSkills.js` + `lib/ai/skills/*` (dépendances directes) +
  `ai-engine/loopGuard.js`/`clientAiQuota.js`/`aiUsageLedger.js` (dépendances indirectes, self-containées via
  `storageAdapter`, aucune adaptation nécessaire — API `get`/`set` déjà identique côté PC). Remplace l'ancien stub qui
  routait tout vers `lib/aiGateway.js` (Firebase en priorité, VPS en repli) — la cascade appelle désormais les
  fournisseurs DIRECTEMENT depuis le PC, comme le VPS, sans aucune dépendance externe. Vérifié en réel (test
  fonctionnel `generateAIResponse` → repli Pollinations sans clé configurée, réponse reçue). `local-client/.env.example`
  complété avec toutes les variables de la cascade. Téléphone : NON PORTÉ (voir la note d'architecture en tête de
  fichier — nécessite une réécriture JS navigateur, pas une copie).
- `ai-engine/authz.js`, `untrusted.js`, `toolRegistry.js` (deny-by-default, rôles, teinte), `chatOrchestrator.handle` (principal obligatoire).
- `ai-engine/mediaPipeline.js`, `chatUploads.js` (extraction), `ownerChannel.js` (adaptateurs WhatsApp/Telegram, médias), `adapters/telegram.js` + `telegramManager.js` (self-chat « Messages sauvegardés »).
- `ai-engine/clientAiQuota.js`, `clientLimitGuard.js`, `autoResponder.js`, `assistantLayer.js` (10 échanges IA/heure/client, groupes par membre, propriétaire illimité), `businessServices.getPrioritizedContext`, mémoire commerciale (`jarvis/conversationEngine.js`, `intentClassifier.js`).
- Variables : `GEMINI_API_KEY`, `GEMINI_PRIMARY_MODEL`, `GEMINI_SECONDARY_MODEL`, `GEMINI_FLASH_MODEL`, `CLIENT_AI_LIMIT`, `CLIENT_AI_WINDOW_MS`.

## Livraison 2026-09-21 (soir) — Agency Agents : spécialistes sous la tutelle du Service Orchestrateur
Voir docs/AGENCY-AGENTS.md. À porter vers local-client/ et mobile/webapp/ : ai-engine/agents/ (+ catalog), scripts/sync-agency-agents.js, branchements autoResponder.composeReply et chatOrchestrator.handleInner, outils listSpecialists/setSpecialistStatus, champs Service métier (specialists, lifecycle…).

## Livraison 2026-09-21 (nuit) — Communautés : création/invitation de groupes + découverte (WhatsApp/Telegram)
À porter vers local-client/ et mobile/webapp/ : ai-engine/communityService.js, communityDiscovery.js, contactCrm (communities), outils createCommunityGroup/getCommunityGroupStatus/discoverCommunities/listCommunities (toolsExtra), intention community (chatOrchestrator), primitives moteurs (adapters/whatsappEngineBaileys.js : checkNumbersOnWhatsApp/createGroup/addGroupParticipants/getGroupInviteLink/getInviteInfo ; adapters/telegram.js : createCommunityGroup/inviteUserToGroup/exportGroupInviteLink/searchPublicCommunities), routes /api/communities/*, sections UI cm-wa/cm-tg. Variables : COMMUNITY_MAX_MEMBERS, COMMUNITY_WA_BATCH, COMMUNITY_DELAY_MIN_MS/MAX_MS, WHATSAPP_DIRECTORY_SEARCH_URL.

## Livraison 2026-09-21 (nuit 2) — Accompagnement des apprenants (base pédagogique, recherche ciblée, groupes de formation)
Voir docs/ACCOMPAGNEMENT-APPRENANTS.md. À porter vers local-client/ et mobile/webapp/ : ai-engine/courseKnowledge.js, learnerSupport.js, mediaPipeline.extractFullText, autoResponder.composeLearning, conversationEngine (décision LEARNING), assistantLayer.route, outils ingestCourse/listCourses/searchCourse/linkCourse/listFaqCandidates/promoteFaq, isSearchAvailable du gateway. Variables : LEARNER_WEB_SEARCH.

## Livraison 2026-09-21 (nuit 3) — Cyrus multi-métiers : cycle de vie client, auto-connaissance, guidage, Rapport & Activité, auto-amélioration
Voir docs/CYRUS-MULTI-METIERS.md. À porter vers local-client/ et mobile/webapp/ : ai-engine/customerLifecycle.js, cyrusSelf.js, guidedSetup.js, activityIntelligence.js, toolsLifecycle.js (fusionné par toolsExtra), taskQueue (états WAITING_EXTERNAL/VERIFYING/PAUSED + gestionnaire FOLLOW_UP), storageAdapter (namespaces locaux), businessServices (champ groups), chatOrchestrator (intentions selfknow/guide/lifecycle/activityreport), conversationEngine (ouverture auto d'un dossier SAV), autoResponder (groupe lié à un service), routes /api/reports/intelligence|improvements|analysis (index.js) et section « Centre d'intelligence » de l'onglet Rapports (dashboard.html). Statut : NON PORTÉ.

## Livraison 2026-09-21 (nuit 4) — Répondeur contextuel (mémoire 7 jours, politique pilotable, groupes, arbitrage IA), anti-boucle, jamais « fait » sans preuve
Voir docs/REPONDEUR-CONTEXTUEL.md. À porter vers local-client/ et mobile/webapp/ : botSignature.js, claimGuard.js, conversationContext.js, conversationPolicy.js, engagement.js, toolsConversation.js, extraits autoResponder/conversationEngine/ownerChannel/chatOrchestrator, index.js (waAddressing, routes), panneau du dashboard. Statut : NON PORTÉ.

## Livraison 2026-09-22 — Stabilité multi-licences WhatsApp (révocations en rafale au redémarrage)
Correctif de fiabilité, pas une fonctionnalité visible : `adapters/whatsappManager.js` (étalement des reconnexions au démarrage, `WHATSAPP_BOOT_RECONNECT_STAGGER_MS`), réglages `MAX_ACTIVE_SESSIONS`/`PROACTIVE_IDLE_DISCONNECT_MS` (config VPS uniquement, sans objet pour le PC/téléphone qui n'ont qu'un seul compte local). À porter vers local-client/ et mobile/webapp/ : SANS OBJET (le multi-tenant/sessionRegulator n'existe pas en mode local mono-compte).

## Livraison 2026-09-22 — Découverte de personnes par thématique, adhésion/extraction de membres, moteurs de recherche combinés + filtres géo
À porter vers local-client/ et mobile/webapp/ : `ai-engine/communityDiscovery.js` (discoverPeople, extractMembers, joinCommunity, syncPeopleToCrm, recherche multi-moteurs DuckDuckGo+Bing+Startpage, paramètre `location`), `ai-engine/contactCrm.js` (getCommunity, markCommunityJoined, champ `location`), `adapters/telegram.js` (getGroupMembers résolution par @username, searchPublicPeople), `adapters/whatsappEngineBaileys.js` (joinGroupByInvite), routes `/api/communities/discover-people|join|extract-members` (index.js), sections UI (cm-wa/cm-tg/cm-tg-people, champs pays/ville/département). Variable : `WHATSAPP_DIRECTORY_SEARCH_URL` (fournisseur personnalisé, prioritaire sur les 3 moteurs par défaut). Statut : NON PORTÉ.

## Livraison 2026-09-22 — Partage de contenu (texte/image/vidéo/document) dans des groupes WhatsApp
À porter vers local-client/ (WhatsApp local uniquement — sans objet pour mobile/webapp, qui n'a pas de moteur WhatsApp serveur) : `queues/campaignEngine.js` (`recipientType: 'groups'`, même patron que `queues/telegramCampaignEngine.js` déjà utilisé côté Telegram), route `POST /api/groups/broadcast` (index.js), section « 📣 Partager du contenu dans des groupes » de l'onglet WhatsApp (dashboard.html). Statut : NON PORTÉ.

## Livraison 2026-09-22 — Répondeur : notification du propriétaire si question commerciale sans Service Métier configuré
À porter vers local-client/ et mobile/webapp/ : `ai-engine/jarvis/conversationEngine.js` (paramètre `priorityService` sur `decide()`/`decideCore()`, champ `businessRequestNoService`, message de notification dédié dans `handleBatch`). Dépend du portage encore NON FAIT de l'item #10 (canal propriétaire/alertCenter) et de la ligne 1 (moteur conversationnel Jarvis) ci-dessus — à porter APRÈS eux, pas isolément. Statut : NON PORTÉ.
