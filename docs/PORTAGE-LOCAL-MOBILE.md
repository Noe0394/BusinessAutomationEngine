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

### État détaillé PC (`local-client/`) au 2026-09-22, fin de session

**FAIT et vérifié** (64 fichiers `ai-engine/*.js` de premier niveau + `jarvis/*` + `agents/*` chargent tous sans
erreur — `require()` réel testé sur chacun, pas seulement `node -c`) :
- Cascade IA complète (`lib/ai/llmFallbackEngine.js` + `aiErrors.js` + `marketingSkills.js` + `skills/*`) — testée
  en réel (appel `generateAIResponse` → réponse reçue via le repli Pollinations).
- `loopGuard.js`, `clientAiQuota.js`, `aiUsageLedger.js`, `authz.js`, `untrusted.js`, `toolAgent.js`,
  `capabilityGap.js` — copiés tels quels (self-containés, aucune adaptation requise).
- `toolRegistry.js`, `serviceCommands.js`, `activityIntelligence.js` — copiés tels quels, débloqués par
  l'adaptation de `toolsExtra.js`/`toolsLifecycle.js` ci-dessous.
- `toolsExtra.js`, `toolsLifecycle.js` — **ADAPTÉS** : la résolution de session `adapters/{whatsapp,telegram}Manager.
  getOrCreate(tenant).session` (multi-tenant, VPS) devient `require('../lib/{whatsapp,telegram}')` directement
  (mono-compte local, pas de registre de tenants).
- `botSignature.js` — copié tel quel : `isNumberOfOtherTenant` (concept multi-tenant, "un autre compte sur ce
  serveur") n'a pas d'équivalent mono-compte ; le `try/catch` existant dégrade déjà proprement vers `false`
  (vérifié), juste commenté pour expliciter que c'est voulu.
- `guidedSetup.js`, `cyrusSelf.js` — **ADAPTÉS** : même substitution `peek(tenant).session` → session locale
  directe pour les vérifications `isConnected()`.
- `jarvis/agentLoop.js` (seul fichier manquant du dossier jarvis) — copié tel quel.
- `jarvis/conversationEngine.js` — **RESYNCHRONISÉ** (127 lignes de retard résorbées : accompagnement apprenant,
  mémoire commerciale, garde-fous `claimGuard`/`learnerSupport`, registre d'engagement, ET la notification
  "question commerciale sans service" ajoutée cette nuit sur le VPS).
- `contactCrm.js`, `personaManager.js`, `offerClarifier.js`, `messageHistory.js`, `voiceProcessor.js`,
  `manualPaymentValidator.js`, `emotionalCloser.js` — **RESYNCHRONISÉS** (dérive purement additive vérifiée par
  diff avant copie, aucune logique locale spécifique perdue).
- Les ~45 autres fichiers manquants sans dépendance directe à `adapters/` (alertCenter, ownerChannel,
  pendingActions, businessServices, contactIdentity, contactsPipeline, contactExtractor, campaignService +
  `lib/campaignStatus.js`, campaignContinuity, groupCampaigns(+Parser), adCampaigns(+Parser), customerLifecycle,
  courseKnowledge, learnerSupport, taskQueue, mediaPipeline, chatUploads, ocrProvider, memoryQuery, secretVault,
  knowledgeBase, notifications, toolsConversation, toolsServices, conversationRouter, conversationContext,
  conversationPolicy, engagement, claimGuard, clientLimitGuard, modelRouter, alwaysOn, responderKeeper,
  autoResponder, assistantLayer, activityStore) — copiés tels quels.

**DÉBLOQUÉ le 2026-09-23** — voir la ligne dédiée plus bas (« Livraison — déblocage chatOrchestrator.js »). L'ancien
piège authz/principal ci-dessous est résolu ; conservé pour mémoire :
- **`chatOrchestrator.js`** (546 lignes locales vs 1601 VPS) — **PIÈGE TROUVÉ** : la version VPS exige désormais un
  principal d'autorisation (`authz.currentPrincipal()` + `input.tenantId` obligatoires, voir `authz.js` porté ci-
  dessus) et BLOQUE toute la conversation ("Je ne peux pas traiter cette demande") sans lui — or l'appel actuel de
  `local-client/index.js:370` (`chatOrchestrator.handle({ text, history, sessionId, lastAssistantMessage }, ...)`)
  ne fournit ni `tenantId` ni principal. Un remplacement direct aurait cassé tout le Chat Intelligent local.
  À faire : soit établir un principal OWNER fixe côté local-client avant l'appel (mono-compte, aucun risque
  d'usurpation réel), soit adapter `handle()`/`handleInner` pour accepter l'absence de principal en mode local.
  Fonctions exportées compatibles par ailleurs (`detectIntent`, `handle` toujours présents côté VPS, en plus des
  nouveaux `isQuickChat`/`handleOwnerQueue`/`searchMyGroups`).
- **`communityDiscovery.js`, `communityService.js`** — nécessitent des méthodes que `local-client/lib/whatsapp.js`
  (whatsapp-web.js) n'expose PAS encore : `createGroup`, `addGroupParticipants`, `setGroupDescription`,
  `getGroupInviteLink`, `checkNumbersOnWhatsApp`, `getInviteInfo`, `joinGroupByInvite`. `lib/telegram.js` a un
  écart similaire (`createCommunityGroup`, `getGroupEntity`, `resolveRecipient`, `exportGroupInviteLink`,
  `searchPublicCommunities`, `searchPublicPeople`). Ce n'est PAS un simple changement de chemin de require — il
  faut D'ABORD étendre `lib/whatsapp.js`/`lib/telegram.js` avec ces capacités (whatsapp-web.js et GramJS les
  supportent tous les deux nativement, à vérifier API par API) avant de porter ces deux fichiers.

**Suivi séparé nécessaire** : `local-client/lib/aiGateway.js` (utilisé par `local-client/index.js` pour la
génération d'image/vidéo/PDF longue) pointe encore vers Firebase Functions en priorité — à repointer vers le
Worker Cloudflare (`cloudflare/license-worker/src/media.js`/`textCascade.js`) pour respecter la consigne
"Cloudflare, jamais Firebase". Non fait, distinct du portage `ai-engine/` ci-dessus. Corrigé au passage : la
description de `local-client/package.json` affirmait à tort une dépendance VPS pour l'IA/les licences — mise à
jour pour refléter la consigne "zéro dépendance VPS" actuelle.

### Téléphone (`mobile/webapp/`) — état au 2026-09-22
**NON commencé.** Nécessite une réécriture en JS navigateur (pas de copie possible, zéro backend Node — voir
note d'architecture ci-dessus) des mêmes comportements que ci-dessus, avec la cascade IA appelée via un Worker
Cloudflare plutôt qu'en direct (consigne utilisateur du 2026-09-22 : "les cloud fonctions se tournent directement
vers Cloudflare"). Première étape logique une fois le PC stabilisé : décider si `cloudflare/license-worker/src/
textCascade.js` (déjà existant, à vérifier s'il couvre toute la cascade ou seulement un sous-ensemble) devient le
point d'entrée unique IA pour le téléphone.

| # | Mise à jour VPS (branche `feat/jarvis-engine`, fusionnée dans `main`) | Fichiers VPS principaux | PC | Téléphone |
|---|---|---|---|---|
| 1 | Moteur conversationnel Jarvis (refus respecté, anti-répétition, NO_ACTION, file/debounce, agent multi-outils, exécution directe des ordres sans contradiction) | `ai-engine/jarvis/*`, `chatOrchestrator.js`, `toolRegistry.js` | FAIT (jarvis/*, toolRegistry.js, chatOrchestrator.js — déblocage authz/principal le 2026-09-23, voir plus bas) | À FAIRE |
| 2 | Mémoire 7×24 h par jour (segments par jour, verrous, historique WhatsApp à l'appairage, messages sortants, outil `queryMemory`) | `ai-engine/messageHistory.js`, `memoryQuery.js`, adapters Baileys | FAIT (fichiers copiés/resynchronisés, non testé en conditions réelles) | À FAIRE |
| 3 | Répondeur permanent (compte « toujours actif », gardien de sessions, réglages `/api/auto-responder`) | `ai-engine/alwaysOn.js`, `responderKeeper.js`, `autoResponder.js` | PARTIEL (voir bilan PC ci-dessous) | PARTIEL (FAQ locale + mode IA WhatsApp facultatif ; Telegram entrant, réglages permanents et gardien de sessions absents) |
| 4 | Import de numéros : coller une liste, Excel/CSV, photo OCR, normalisation, doublons, validation, compteurs et tableau des statuts, intégrés aux onglets WhatsApp et Telegram | `ai-engine/contactsPipeline.js`, `ocrProvider.js`, `public/dashboard.html` (`impBuild`) | PARTIEL (contactsPipeline.js/ocrProvider.js copiés et chargent ; UI `impBuild` du dashboard PC pas vérifiée/portée) | À FAIRE |
| 5 | Campagnes suivies dans les onglets WhatsApp/Telegram : statuts, programmation, pause/reprise/annulation, rapport CSV, protection + reprise automatique + continuité manuelle | `ai-engine/campaignService.js`, `lib/campaignStatus.js`, `queues/*`, `public/dashboard.html` (`cmpMount`) | PARTIEL (campaignService.js + lib/campaignStatus.js copiés et chargent ; `queues/*` de local-client à vérifier séparément, UI `cmpMount` pas portée) | À FAIRE |
| 6 | File de tâches + worker (lancement programmé) | `ai-engine/taskQueue*` | PARTIEL (fichier copié, pas de worker/planificateur branché dans local-client/index.js) | À FAIRE |
| 7 | Licences et IA sur Cloudflare (Worker + D1) à la place de Firebase : clients déjà basculés côté `local-client/lib` et mobile pour l'URL, à revérifier | `cloudflare/license-worker/`, `lib/cloudflareSync.js` | PARTIEL (licences ; IA texte = cascade directe, voir ligne "Livraison 2026-09-21" plus bas ; `aiGateway.js` image/vidéo encore sur Firebase, à migrer) | PARTIEL |
| 8 | Clé créée dans le générateur Cloudflare reconnue tout de suite par le VPS (synchronisation immédiate) | `licenses.js` | À FAIRE (vérifier `local-client/lib/license.js`) | À FAIRE |
| 9 | CORS : origine identique au Host acceptée (domaine DuckDNS) | `index.js` | Sans objet (pas de CORS local) | Sans objet |
| 12 | Campagnes de groupes administrés (ciblage, scheduler, intérêt, preuve, objectif) | `ai-engine/groupCampaigns.js`, `groupCampaignParser.js`, `toolsExtra.js`, `chatOrchestrator.js`, `assistantLayer.js`, `index.js` | PARTIEL (groupCampaigns.js/Parser + toolsExtra.js FAIT et adapté ; chatOrchestrator.js/routes index.js pas encore branchés) | À FAIRE |
| 11 | Campagnes Facebook Ads (Service Métier : configuration Chat, origine, message initial exact) | `ai-engine/adCampaigns.js`, `adCampaignParser.js`, `businessServices.js`, `toolsExtra.js`, `chatOrchestrator.js` | PARTIEL (fichiers copiés ; chatOrchestrator.js pas encore branché) | À FAIRE |
| 10 | Couche d'assistance générale : identité des contacts (JID/LID ≠ numéro), routage privé/métier, centre d'alertes, canal propriétaire (self-chat → Chat Intelligent), actions en attente `PA-XXXX` + OUI/NON, vérification API, import de listes appliqué à la source d'envoi | `ai-engine/{contactIdentity,alertCenter,conversationRouter,ownerChannel,pendingActions,assistantLayer,manualPaymentValidator}.js`, `adapters/whatsappEngineBaileys.js` (indices d'identité, self-chat), `lib/whatsappRecipients.js` (déjà copié dans `local-client/lib`), `public/dashboard.html` (`impBuild`) | FAIT côté branchement (2026-09-23) — `assistantLayer.js` instancié et branché dans `index.js`, self-chat détecté sur les deux canaux (capacité ajoutée dans `lib/whatsapp.js`/`lib/telegram.js`, voir section dédiée plus bas), vérifié par scripts de fumée (pas encore par un compte réel connecté). Reste : `impBuild` du dashboard PC pas vérifié | À FAIRE |

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
**PC : PARTIEL (2026-09-22)** — `ai-engine/agents/` (agentRegistry.js, orchestrationService.js, specialistRunner.js,
specialistSelector.js, catalog/) copié tel quel et charge sans erreur. `scripts/sync-agency-agents.js` non copié ;
branchement dans `autoResponder.composeReply`/`chatOrchestrator.handleInner` en attente du déblocage de
`chatOrchestrator.js` (voir piège authz ci-dessus). Téléphone : NON PORTÉ.

## Livraison 2026-09-21 (nuit) — Communautés : création/invitation de groupes + découverte (WhatsApp/Telegram)
À porter vers local-client/ et mobile/webapp/ : ai-engine/communityService.js, communityDiscovery.js, contactCrm (communities), outils createCommunityGroup/getCommunityGroupStatus/discoverCommunities/listCommunities (toolsExtra), intention community (chatOrchestrator), primitives moteurs (adapters/whatsappEngineBaileys.js : checkNumbersOnWhatsApp/createGroup/addGroupParticipants/getGroupInviteLink/getInviteInfo ; adapters/telegram.js : createCommunityGroup/inviteUserToGroup/exportGroupInviteLink/searchPublicCommunities), routes /api/communities/*, sections UI cm-wa/cm-tg. Variables : COMMUNITY_MAX_MEMBERS, COMMUNITY_WA_BATCH, COMMUNITY_DELAY_MIN_MS/MAX_MS, WHATSAPP_DIRECTORY_SEARCH_URL.
**PC : PARTIEL (2026-09-23)** — Débloqué : `lib/whatsapp.js` étendu (checkNumbersOnWhatsApp, createGroup,
setGroupDescription, addGroupParticipants, getGroupInviteLink, getInviteInfo, joinGroupByInvite — signatures
vérifiées en lisant le code source réel de whatsapp-web.js installé, pas une supposition) et `lib/telegram.js`
étendu (createCommunityGroup, getGroupEntity, inviteUserToGroup, exportGroupInviteLink, searchPublicCommunities,
searchPublicPeople, resolveRecipient désormais exporté — copiés quasi à l'identique du VPS car GramJS est LA
MÊME bibliothèque des deux côtés, contrairement à WhatsApp). `communityDiscovery.js`/`communityService.js`
copiés et adaptés (même substitution `adapters/{whatsapp,telegram}Manager` → `lib/{whatsapp,telegram}` que les
autres fichiers), chargent sans erreur. **NON TESTÉ en conditions réelles** (nécessite un compte WhatsApp/
Telegram local réellement connecté pour vérifier créer un groupe, rejoindre par lien, etc. — à faire avant un
premier usage réel). Reste : brancher les routes `/api/communities/*` + section UI dans `local-client/index.js`/
`public/`. Téléphone : NON PORTÉ.

## Livraison 2026-09-21 (nuit 2) — Accompagnement des apprenants (base pédagogique, recherche ciblée, groupes de formation)
Voir docs/ACCOMPAGNEMENT-APPRENANTS.md. À porter vers local-client/ et mobile/webapp/ : ai-engine/courseKnowledge.js, learnerSupport.js, mediaPipeline.extractFullText, autoResponder.composeLearning, conversationEngine (décision LEARNING), assistantLayer.route, outils ingestCourse/listCourses/searchCourse/linkCourse/listFaqCandidates/promoteFaq, isSearchAvailable du gateway. Variables : LEARNER_WEB_SEARCH.
**PC : PARTIEL (2026-09-22)** — courseKnowledge.js, learnerSupport.js, mediaPipeline.js, assistantLayer.js copiés et
chargent (dont la décision LEARNING de conversationEngine, déjà resynchronisée). Non vérifié en conditions réelles
(ingestion d'un vrai support de cours). Téléphone : NON PORTÉ.

## Livraison 2026-09-21 (nuit 3) — Cyrus multi-métiers : cycle de vie client, auto-connaissance, guidage, Rapport & Activité, auto-amélioration
Voir docs/CYRUS-MULTI-METIERS.md. À porter vers local-client/ et mobile/webapp/ : ai-engine/customerLifecycle.js, cyrusSelf.js, guidedSetup.js, activityIntelligence.js, toolsLifecycle.js (fusionné par toolsExtra), taskQueue (états WAITING_EXTERNAL/VERIFYING/PAUSED + gestionnaire FOLLOW_UP), storageAdapter (namespaces locaux), businessServices (champ groups), chatOrchestrator (intentions selfknow/guide/lifecycle/activityreport), conversationEngine (ouverture auto d'un dossier SAV), autoResponder (groupe lié à un service), routes /api/reports/intelligence|improvements|analysis (index.js) et section « Centre d'intelligence » de l'onglet Rapports (dashboard.html). Statut : NON PORTÉ.
**PC : PARTIEL (2026-09-22)** — customerLifecycle.js, cyrusSelf.js (adapté), guidedSetup.js (adapté),
activityIntelligence.js, toolsLifecycle.js (adapté) tous copiés/adaptés et chargent. Manque : routes
`/api/reports/*` dans local-client/index.js, section dashboard PC correspondante — NON PORTÉ. Téléphone : NON PORTÉ.

## Livraison 2026-09-21 (nuit 4) — Répondeur contextuel (mémoire 7 jours, politique pilotable, groupes, arbitrage IA), anti-boucle, jamais « fait » sans preuve
Voir docs/REPONDEUR-CONTEXTUEL.md. À porter vers local-client/ et mobile/webapp/ : botSignature.js, claimGuard.js, conversationContext.js, conversationPolicy.js, engagement.js, toolsConversation.js, extraits autoResponder/conversationEngine/ownerChannel/chatOrchestrator, index.js (waAddressing, routes), panneau du dashboard. Statut : NON PORTÉ.
**PC : PARTIEL (2026-09-22)** — botSignature.js, claimGuard.js, conversationContext.js, conversationPolicy.js,
engagement.js, toolsConversation.js tous copiés et chargent (le "arbitrage IA" de conversationEngine, déjà
resynchronisé, en dépend). Manque : `index.js` (waAddressing, routes) et panneau dashboard PC — NON PORTÉ.
Téléphone : NON PORTÉ.

## Livraison 2026-09-22 — Stabilité multi-licences WhatsApp (révocations en rafale au redémarrage)
Correctif de fiabilité, pas une fonctionnalité visible : `adapters/whatsappManager.js` (étalement des reconnexions au démarrage, `WHATSAPP_BOOT_RECONNECT_STAGGER_MS`), réglages `MAX_ACTIVE_SESSIONS`/`PROACTIVE_IDLE_DISCONNECT_MS` (config VPS uniquement, sans objet pour le PC/téléphone qui n'ont qu'un seul compte local). À porter vers local-client/ et mobile/webapp/ : SANS OBJET (le multi-tenant/sessionRegulator n'existe pas en mode local mono-compte).

## Livraison 2026-09-22 — Découverte de personnes par thématique, adhésion/extraction de membres, moteurs de recherche combinés + filtres géo
À porter vers local-client/ et mobile/webapp/ : `ai-engine/communityDiscovery.js` (discoverPeople, extractMembers, joinCommunity, syncPeopleToCrm, recherche multi-moteurs DuckDuckGo+Bing+Startpage, paramètre `location`), `ai-engine/contactCrm.js` (getCommunity, markCommunityJoined, champ `location`), `adapters/telegram.js` (getGroupMembers résolution par @username, searchPublicPeople), `adapters/whatsappEngineBaileys.js` (joinGroupByInvite), routes `/api/communities/discover-people|join|extract-members` (index.js), sections UI (cm-wa/cm-tg/cm-tg-people, champs pays/ville/département). Variable : `WHATSAPP_DIRECTORY_SEARCH_URL` (fournisseur personnalisé, prioritaire sur les 3 moteurs par défaut).
**PC : PARTIEL (2026-09-23)** — Débloqué en même temps que la livraison "Communautés" du 2026-09-21 ci-dessus (même
correctif : `lib/whatsapp.js`/`lib/telegram.js` étendus). `communityDiscovery.js` (discoverPeople, extractMembers,
joinCommunity, syncPeopleToCrm, recherche multi-moteurs, `location`) copié et adapté, charge sans erreur ;
`contactCrm.js` (getCommunity/markCommunityJoined/location) déjà resynchronisé. NON TESTÉ en conditions réelles.
Manque : routes `/api/communities/*` + UI (pays/ville/département) dans local-client/. Téléphone : NON PORTÉ.

## Livraison 2026-09-23 — Refonte Service Métier : mémoire libre, zéro lien de paiement, sélection multi-services
À porter vers local-client/ et mobile/webapp/ : `ai-engine/businessServices.js` (champ `commercial.memo` + extraction
IA best-effort non bloquante), `toolRegistry.js` (configureBusinessService : memo), `toolsServices.js`
(updateBusinessService : memo/memoAppend), `autoResponder.js` (correctif sélection multi-services, hint réel au
lieu de toujours vide), `index.js` (3 messages "lien de paiement" corrigés — Studio de contenu),
`lib/intelligence/action-executor.js` (GENERATE_PAYMENT_LINK : suppression du "Bénéficiaire" générique),
`public/dashboard.html` (nouveau champ "Mémoire de l'activité").
**PC : PARTIEL (2026-09-23)** — `businessServices.js`, `toolRegistry.js`, `toolsServices.js`, `autoResponder.js`
resynchronisés (copie conforme, aucun des quatre ne dépend de `adapters/`) et chargent tous sans erreur. Manque :
`lib/intelligence/action-executor.js` local-client (si utilisé côté PC, à vérifier) et surtout **l'interface** —
`local-client/public/` n'a AUCUN formulaire Service Métier aujourd'hui (jamais porté, voir ligne 10 du tableau) :
le champ mémo backend est prêt mais rien ne l'expose encore côté PC tant que cette UI n'existe pas. Téléphone :
NON PORTÉ (même dépendance).

## Livraison 2026-09-22 — Partage de contenu (texte/image/vidéo/document) dans des groupes WhatsApp
À porter vers local-client/ (WhatsApp local uniquement — sans objet pour mobile/webapp, qui n'a pas de moteur WhatsApp serveur) : `queues/campaignEngine.js` (`recipientType: 'groups'`, même patron que `queues/telegramCampaignEngine.js` déjà utilisé côté Telegram), route `POST /api/groups/broadcast` (index.js), section « 📣 Partager du contenu dans des groupes » de l'onglet WhatsApp (dashboard.html). Statut : NON PORTÉ (pas commencé cette session — `local-client/queues/` à auditer séparément).

## Livraison 2026-09-22 — Répondeur : notification du propriétaire si question commerciale sans Service Métier configuré
À porter vers local-client/ et mobile/webapp/ : `ai-engine/jarvis/conversationEngine.js` (paramètre `priorityService` sur `decide()`/`decideCore()`, champ `businessRequestNoService`, message de notification dédié dans `handleBatch`). Dépend du portage encore NON FAIT de l'item #10 (canal propriétaire/alertCenter) et de la ligne 1 (moteur conversationnel Jarvis) ci-dessus — à porter APRÈS eux, pas isolément.
**PC : FAIT côté code** — `conversationEngine.js` resynchronisé inclut déjà ce comportement (fait partie du portage
général de cette session) ; `alertCenter.js`/`ownerChannel.js` (dont dépend la notification réelle) copiés aussi.
Chaîne complète NON testée en conditions réelles (nécessite `autoResponder.js` branché + un compte WhatsApp/
Telegram local connecté). Téléphone : NON PORTÉ.

## ⚠️ Incident VPS (2026-09-23) — le VM de référence est SUPPRIMÉ (facturation GCP suspendue)
`instance-20260909-074745` (projet `rien-afrique`) a été supprimé par Google Cloud faute de paiement. Le code est
intact (tout est poussé sur GitHub, vérifié commit par commit contre `origin/main`) ; l'incertitude porte sur le
`.env` réel du VM (jamais commité, jamais sauvegardé ailleurs à notre connaissance) et sur les données locales au VM
(sessions WhatsApp, CRM, Services Métiers — `GITHUB_MIRROR_USER_DATA=false` par défaut, voir `.env.example`). Les
licences devraient être intactes (Cloudflare Worker+D1, infrastructure séparée). **Conséquence directe pour ce
chantier : c'est précisément la raison d'être du portage PC/téléphone — ne plus dépendre d'un VPS.** Priorité
maximale sur ce document tant que le VPS n'est pas restauré. Nouvelle consigne utilisateur (2026-09-23, réaffirmée
« absolument tout ») : port INTÉGRAL, sans exception, de tout ce qui a été livré sur le VPS.

## Livraison 2026-09-23 (suite VM) — Déblocage `chatOrchestrator.js` (piège authz/principal résolu)
**PC : FAIT et vérifié.** Le fichier VPS (1601 lignes) a été resynchronisé verbatim vers `local-client/ai-engine/
chatOrchestrator.js` (remplace l'ancienne copie à 546 lignes, très en retard). Toutes ses dépendances (`actionLedger`,
`activityIntelligence`, `adCampaignParser`, `agents/orchestrationService`, `alertCenter`, `authz`, `businessServices`,
`connectors/connectorManager`, `contactCrm`, `contactIdentity`, `conversationRouter`, `customerLifecycle`, `cyrusSelf`,
`groupCampaignParser`, `groupCampaigns`, `guidedSetup`, `jarvis/agentLoop`, `manualPaymentValidator`, `memoryQuery`,
`messageHistory`, `offerClarifier`, `personaManager`, `platformOrchestrator`, `serviceCommands`, `toolAgent`,
`toolRegistry`, `toolsLifecycle`, `untrusted`, `queues/recurringTasks`, `lib/intelligence/{goal-chat,task-parser}`,
`lib/ai/llmFallbackEngine`) existaient déjà côté `local-client/` — confirmé une par une avant la copie. UNE seule
adaptation réelle dans les 1601 lignes : `searchMyGroups()` (résolution du lien d'invitation d'un groupe WhatsApp)
utilisait `adapters/whatsappManager.getOrCreate(tenantId).session` (VPS, multi-tenant) → remplacé par
`require('../lib/whatsapp')` (même patron que `toolsExtra.js`, mono-compte local).
Point d'entrée du tableau de bord (`local-client/index.js`, route de chat) : un principal `OWNER` fixe est désormais
émis une seule fois au démarrage (`authz.issuePrincipal({ tenant: 'local', role: 'OWNER', ... })`, tenant `'local'`
— même convention que `tenantId: 'local'` déjà utilisée ailleurs dans ce fichier) et transmis à chaque appel de
`chatOrchestrator.handle()` (`tenantId: 'local', principal: LOCAL_OWNER_PRINCIPAL`) — aucun risque d'usurpation en
mode mono-compte local (l'accès au tableau de bord EST déjà l'authentification).
**Vérifié en réel** (pas seulement `node --check`) : `require()` du fichier resynchronisé charge sans erreur, ET un
script de fumée a appelé `chatOrchestrator.handle()` directement avec les dépendances réelles du tableau de bord
local sur 3 messages différents (« bonjour » → repli conversation courante correct ; « montre mes prospects » →
intention CRM exécutée avec une vraie réponse ; « quelle est mon activité ? » → boucle Agent à outils exécutée,
dégradation propre sur l'échec réseau du LLM en environnement hors-ligne) — aucun crash, le principal/tenant passe
la vérification d'autorisation à chaque appel.
**DÉBLOQUÉ le 2026-09-23 (suite immédiate, sur demande explicite de l'utilisateur de continuer « minutieusement »)** :
`assistantLayer.js` est maintenant instancié et branché dans `local-client/index.js` (`assistant = assistantLayer.create({...})`
+ `assistant.start()`), et `handleIncomingCustomerMessage` reproduit l'ordre exact du VPS (`index.js:5524`) :
résolution d'identité → campagnes de groupes (`groupEntry`/`leadDm`) → historique → preuve de paiement → campagne
d'entrée publicitaire (`adEntry`) → routage privé/métier (`route`) → `autoResponder.handleIncoming()` — avec repli
sur l'ANCIEN pipeline (`messageTriage`+`emotionalCloser`) uniquement si l'auto-réponse est explicitement désactivée
pour ce compte/canal (`autoOut.skipped === 'DISABLED'`), exactement comme le VPS le fait déjà lui-même.

**Détection du self-chat — capacité RÉELLEMENT AJOUTÉE (pas une simple copie)**, différente entre les deux canaux :
- `lib/whatsapp.js` : nouvel évènement `message_create` (en plus de `'message'`, qui ne capte que `fromMe:false`),
  filtré sur `msg.fromMe === true && msg.to === <mon JID, via client.info.wid._serialized>` (= self-chat), avec un
  registre `sentByMe` + délai de 700 ms pour ignorer l'écho d'un message que CE client vient lui-même d'envoyer
  (`rememberSent()`, hooké dans `sendMessage`/`sendMedia`) — même principe que
  `adapters/whatsappEngineBaileys.js#checkOwnerMessage`/`isSelfChatJid` côté VPS (Baileys), mais un mécanisme
  différent car whatsapp-web.js n'expose pas la même forme d'évènement.
- `lib/telegram.js` : l'écouteur existant ignorait TOUT message `out:true` (donc aussi les Messages sauvegardés
  tapés depuis le téléphone) — ajout d'un embranchement dédié quand `chatId === mon id` (résolu une fois via
  `client.getMe()`), avec le même registre `sentByMe`. Bug corrigé au passage dans `sendMessage()` : une destination
  = mon propre id (self-chat) passait par la résolution "numéro de téléphone" de `resolveRecipient` (fausse route) ;
  utilise maintenant `'me'`, l'idiome natif GramJS pour les Messages sauvegardés.
- `local-client/ai-engine/ownerChannel.js`/`assistantLayer.js` restent **INCHANGÉS** (toujours resynchronisables tel
  quel depuis le VPS) : l'adaptation vit entièrement à la frontière, dans `local-client/index.js` — `localWhatsappSession`/
  `localTelegramSession` (objets « session » exposant `sendMessage`/`isConnected`/`getSelfIds`/`isSelfChatJid`/
  `isSavedMessages`/`getIdentityHints`) et `shimBaileysMessage()` (construit l'enveloppe `{key:{remoteJid,id,fromMe},
  message:{conversation}}` que `ownerChannel.js#WHATSAPP` attend, à partir d'un message whatsapp-web.js natif).

**Vérifié en réel** (scripts de fumée, sans compte WhatsApp/Telegram connecté — voir limite ci-dessous) :
`assistant.resolveIdentity`/`route`/`adEntry`/`groupEntry`/`leadDm` appelés avec des messages WhatsApp de forme
whatsapp-web.js réelle (`msg.from`/`msg.body`/`msg._data.notifyName`) : aucun crash, réponses cohérentes (aucune
campagne configurée → `NO_CAMPAIGN_CONFIGURED`/`NOT_A_CAMPAIGN_GROUP`/`NOT_A_LEAD`, routage → `DISABLED` faute de
réglage). `ownerChannel.handleOwnerMessage()` appelé DIRECTEMENT avec un message self-chat WhatsApp shimmé ET un
message self-chat Telegram (GramJS natif) : les deux reconnaissent correctement le self-chat (`isSelfChatJid`/
`isSavedMessages`), extraient le texte, appellent `chat()` et renvoient la réponse à la BONNE destination avec la
signature anti-boucle. Câblage complet `assistant.start()` → gestionnaire enregistré → `handleOwnerMessage` →
réponse envoyée, revérifié avec un `chatOrchestrator` stubbé (élimine tout appel réseau réel du test).

**Limite connue, non résolue** : les pièces jointes (image/document/note vocale) envoyées dans le self-chat WhatsApp
ne sont PAS traitées (`localWhatsappSession.downloadIncomingMedia` lève une erreur volontaire) — dégrade proprement
(`ownerChannel.js` capture déjà cet échec et répond un message d'erreur clair au lieu de planter), mais ce n'est pas
une vraie fonctionnalité. À faire si besoin : construire un shim média complet (whatsapp-web.js expose `msg.downloadMedia()`
nativement sur le message ORIGINAL, à conserver en plus du shim Baileys-shaped). **Jamais testé avec un vrai compte
WhatsApp/Telegram connecté** (self-chat réel depuis un téléphone) — seulement des scripts de fumée avec des messages
simulés fidèles à la forme réelle des deux bibliothèques ; c'est la prochaine étape de validation, à faire par
l'utilisateur avec un compte réel. Téléphone : sans objet directement (pas de backend Node), mais bénéficiera du
même contrat une fois `cloudflare/license-worker/` étendu pour servir d'équivalent chatOrchestrator côté navigateur.

## Livraison 2026-09-23 (suite VM) — Registre des nouveaux contacts publicitaires (relance, export Excel)
`ai-engine/adCampaigns.js` (registre `listNewAdContacts`), routes `/api/ad-campaigns/new-contacts` + `/export-excel`,
section dashboard « Nouveaux contacts publicitaires » dans l'onglet Publicité ; correctif `contactCrm.js#ensureContact`/
`recordSeen` (bug de clé non normalisée : `markPurchase`/`setStage` indexaient sous le JID brut tandis que
`getContact` cherchait sous le numéro normalisé — un achat confirmé pouvait rester invisible).
**PC : FAIT pour le backend** (2026-09-23) — `adCampaigns.js` et `contactCrm.js` resynchronisés verbatim (aucune
dépendance `adapters/`, confirmé identiques au VPS avant copie). **Vérifié en réel** : script de fumée exécutant
`recordSeen()` deux fois de suite (2e appel bien `isNew:false`, confirmant le correctif de clé) puis
`listNewAdContacts()` sur le stockage local — aucun crash. Manque encore, PAS PORTÉ : les routes Express
`/api/ad-campaigns/new-contacts(+/export-excel)` dans `local-client/index.js` et la section correspondante dans
`local-client/public/` (aucune UI Service Métier/campagnes publicitaires n'existe encore côté PC, voir item #11/#10
du tableau plus haut — blocage UI plus large, pas spécifique à cette livraison). Téléphone : NON PORTÉ.

## Chantier EN COURS 2026-09-23 (soir) — Licence hybride offline (Ed25519) + Cloudflare en secours

**Déclenché par** : consigne explicite de l'utilisateur (après l'incident VM) demandant une réadaptation vers
l'autonomie 100% locale. Audit livré en conversation (résumé : sessions WhatsApp/Telegram, base de données, IA et
paiements sont DÉJÀ 100% locaux/manuels ; seule la vérification de licence dépend encore d'un appel réseau, vers le
Worker Cloudflare `cyrus-license.ezechielatannidje.workers.dev` — gratuit, déjà indépendant du VM supprimé, mais pas
« zéro réseau »). Deux décisions utilisateur actées :
1. **Licence** : approche hybride retenue (PAS un simple remplacement) — validation OFFLINE par défaut (jeton signé
   Ed25519, vérifié localement avec une clé publique embarquée, aucun appel réseau requis pour fonctionner au
   quotidien), avec une vérification Cloudflare en arrière-plan pour détecter une révocation et rafraîchir le jeton.
2. **Déploiement Vercel** (`vercel --prod`) demandé dans la consigne d'origine : **écarté** — confirmé sans objet,
   Vercel sert exclusivement le mode VPS (mémoire épinglée `cyrus-single-vercel-webapp-architecture`), pas le
   chantier zéro-VPS local en cours.

**Conception retenue pour le jeton offline** (pas encore implémentée) :
- Format compact maison (PAS un JWT standard, pour éviter toute confusion d'algorithme) :
  `base64url(JSON des revendications) + '.' + base64url(signature Ed25519)`.
- Revendications : `{ key, deviceId, allowedModules, licenseExpiresAt, offlineGraceUntil, issuedAt }` —
  `offlineGraceUntil` (ex. +14 jours) est une fenêtre de tolérance hors-ligne, RE-signée/étendue à chaque
  vérification en ligne réussie ; distincte de `licenseExpiresAt` (l'expiration réelle de la licence).
- Vérification locale : signature valide (clé publique embarquée) + `key`/`deviceId` correspondent + horodatage
  actuel < `offlineGraceUntil` ET (`licenseExpiresAt` nul OU non dépassé).
- Rafraîchissement : au démarrage + périodiquement, tentative de vérification EN LIGNE (non bloquante) ; succès ->
  jeton mis à jour en cache local ; réseau injoignable -> on continue avec le jeton en cache tant qu'il est valide ;
  réponse EN LIGNE explicitement négative (révoqué/inactif/expiré/appareil différent) -> jeton local supprimé,
  licence invalidée pour de bon (une négation explicite du serveur prime toujours sur le cache).

**Fait jusqu'ici** :
- Confirmé que `crypto.webcrypto.subtle` (Web Crypto, Ed25519) fonctionne nativement sur ce Node.js (v24) — même
  API que le runtime Cloudflare Workers, donc utilisable des DEUX côtés (signature côté Worker, vérification côté
  `local-client`) sans dépendance npm supplémentaire. Testé par une génération de paire de clés Ed25519 factice
  (UNIQUEMENT pour valider la compatibilité de plateforme — **cette paire de test a été affichée en clair dans un
  terminal et ne doit JAMAIS servir en production** ; une vraie paire sera regénérée proprement, écrite directement
  dans un fichier hors du code/jamais loguée, avant tout usage réel).

**PAS ENCORE FAIT** (reste à faire, dans cet ordre) :
1. Générer la VRAIE paire de clés Ed25519 de production (proprement, sans l'afficher en clair) ; la clé PRIVÉE va
   UNIQUEMENT dans un secret Wrangler (`wrangler secret put LICENSE_SIGNING_PRIVATE_KEY` sur
   `cloudflare/license-worker/`, jamais commitée) ; la clé PUBLIQUE est intégrée telle quelle dans le code de
   `local-client/lib/license.js` (elle est publique par nature, aucun risque à la committer).
2. Modifier `cloudflare/license-worker/src/index.js#verify()` : après une vérification réussie, signer un jeton
   offline avec la clé privée et le renvoyer dans la réponse (`offlineToken`).
3. Modifier `local-client/lib/license.js` : vérification offline en PREMIER (jeton en cache + clé publique
   embarquée), rafraîchissement en ligne non bloquant en arrière-plan, gestion du cache local (fichier), gestion de
   la révocation explicite.
4. Déployer le Worker Cloudflare mis à jour (`wrangler deploy`, action utilisateur ou à faire ensemble — jamais
   effectué sans confirmation, cette infrastructure est actuellement le SEUL système qui a survécu à l'incident VM,
   voir la règle `preserve-existing-infrastructure`).
5. Tests réels (licence valide hors-ligne après un premier appairage en ligne, comportement si Cloudflare injoignable,
   comportement si la licence est révoquée pendant que l'app tourne hors-ligne puis se reconnecte).
6. Documenter le résultat final ici, avec le statut FAIT et les tests réellement passés (pas seulement écrits).
7. `mobile/webapp/` (Web Crypto disponible aussi en navigateur) : NON COMMENCÉ, à traiter après le PC.

## Reprise prioritaire — Parité intégrale VPS / PC local / téléphone (2026-09-23)

**Exigence utilisateur réaffirmée** : porter sur local-client/ et mobile/webapp/ toutes les fonctionnalités du VPS et rendre leurs interfaces identiques à l'interface de référence public/dashboard.html (mêmes onglets, libellés, formulaires, actions et retours visuels ; adaptation responsive seulement pour la taille d'écran). La simple reprise de la palette graphique ne satisfait pas cette exigence.

**Etat du releve** : le dashboard VPS comporte 14 controles d?onglet (11 visibles par defaut). Le PC en expose desormais 13 controles ; le telephone avait initialement 8 ecrans.

**Livraison en cours — Services Métiers PC** : ajout des routes locales /api/business-services (liste, création, contexte, lecture, mise à jour, suppression, connexion API, test et permissions) utilisant le registre mono-compte local. Le formulaire du panneau VPS a été repris dans local-client/public/index.html, et son comportement dans local-client/public/business-services.js. La vérification syntaxique Node des scripts PC a réussi. Téléphone : pas encore porté ; cette fonctionnalité n'est donc pas déclarée complète.

**Critère d'achèvement** : chaque onglet et fonction VPS a une correspondance PC et téléphone ; chaque interface reprend la même structure et les mêmes contrôles ; les différences nécessaires au matériel (par exemple appairage WhatsApp mobile) sont notées explicitement et ne suppriment aucune capacité métier. La feuille de route ligne par ligne ci-dessus doit être mise à jour au fil des livraisons et les tests rapportés uniquement après exécution réelle.


## Suite de portage 2026-09-23 - Aide, rapports et groupes mobile

PC local : routes locales de documentation, couts IA, journal d?activite, rapport d?intelligence, diagnostic, application et mesure des ameliorations. Les onglets Centre d?aide et Rapports utilisent les composants et gestionnaires repris du VPS.

Telephone : ecrans Centre d?aide hors ligne, rapports depuis IndexedDB, liste des groupes WhatsApp/Telegram via les ponts existants et extraction locale des membres. Les membres extraits sont ajoutes aux contacts de l?appareil. Les resultats ne sont pas synchronises avec le VPS.

Verifications executees : node --check sur les scripts serveur et JavaScript PC/mobile, git diff --check et test de fumee des modules locaux d?aide/rapport. Aucun compte reel ni appareil mobile n?a ete utilise pour valider les sessions reseau.

Ecart restant : portage mobile des Services Metiers connectes, creation/invitation et decouverte de communautes, reponse automatique, rapports complets avec ameliorations et APIs serveur. Le mobile conserve les integrations natives; ses ecrans ne sont donc pas encore identiques a 100% au VPS. Aucune livraison ni commit n?est declare complet tant que ces fonctions restent manquantes.


## Suite de portage - gestionnaire de campagnes PC et fiches m?tier mobile

PC : le gestionnaire de campagnes VPS est maintenant raccord? au runtime PC pour pr?parer les destinataires, analyser CSV/Excel/image, cr?er/lancer/programmer, piloter pause/reprise/annulation, suivre l??tat r?el, g?rer les m?dias et produire les rapports. L?ancienne API de campagne reste sous `/api/legacy-campaigns` pour les ?crans et la relance qui l?utilisent. La file persistante traite les lancements programm?s.

T?l?phone : ajout des fiches Services M?tiers sans secrets API, persist?es dans IndexedDB; l?utilisateur peut cocher explicitement l?inclusion du contexte avant de l?envoyer au fournisseur IA. La programmation existante d?une campagne est d?sormais sauvegard?e avec horaire, message et m?dia et reprise au red?marrage; elle s?ex?cute uniquement si CYRUS mobile est ouvert/actif. Les ponts mobile restent requis pour le transport WhatsApp/Telegram.

V?rifications de cette tranche : analyse syntaxique des fichiers modifi?s; test de fum?e r?el du module campaignService isol? (liste pr?par?e, brouillon cr??, lancement par runtime simul?, lecture du gestionnaire). Les fonctions connect?es ? un vrai compte et le build Android restent ? v?rifier.


Verification Android (2026-09-23): `npm run sync` succeeded. SHA-256 checks confirm `index.html`, `app.js`, `campaign.js`, `lib/db.js`, `business-services-mobile.js` and `parity-local.js` match Capacitor's Android public assets. `gradlew.bat assembleDebug` could not finish because this machine has JDK 17.0.20 while Capacitor Android requests Java source release 21 (`invalid source release: 21`). Install/select JDK 21, then rerun the Android build.

Mobile follow-up: the Services screen now has an explicit per-service WhatsApp FAQ auto-reply switch. It only answers exact private-chat question matches from `question => answer` lines, skips groups, self messages, unsubscribe/stop text, and blocked contacts, and sends no customer text to an AI provider. The Telegram web bridge still has no incoming-message event, so automatic Telegram replies are not exposed. A simulated bridge smoke test verified one exact DM response and skipped a group.
# Complément — prospects publicitaires et vue mobile

- PC local : ajout de `GET /api/ad-campaigns/new-contacts`, d'une vue dédiée et d'un export Excel du registre alimenté par `ai-engine/adCampaigns`. Le statut CRM et la distinction entre source vérifiée et origine déduite restent fournis par le moteur existant.
- Téléphone : ajout d'une vue Prospects & contacts locaux et export Excel. Elle montre les contacts importés, leur canal et les envois liés aux campagnes lorsque l'historique en garde l'identifiant. Les envois mobiles mémorisent désormais cet identifiant.
- Limite réelle : le mobile ne reçoit pas le signal d'origine publicitaire vérifié du pont Meta/VPS; la vue mobile n'étiquette donc pas ses contacts comme prospects publicitaires. Il reste aussi à porter le moteur VPS d'attribution et la prise en charge Messenger qui dépend d'un backend dédié.

### Complément — contrôle et rapport des campagnes mobiles

- Ajout d'une commande Annuler distincte de Pause : elle annule une programmation persistée ou arrête une campagne après l'envoi en cours, conserve les envois déjà journalisés et marque l'état `cancelled`.
- Le rapport de la dernière campagne affiche maintenant l'état et l'heure de programmation; la liste d'échecs peut être exportée en Excel.
- L'écran mobile expose désormais l'historique complet des campagnes par canal, avec compteurs d'envois/échecs/en attente, date de mise à jour et export Excel.
- Chaque nouvelle campagne conserve maintenant son instantané des destinataires; une reprise n'est plus affectée par un nouvel import. L'historique peut afficher chaque destinataire et son état, avec un plafond visuel de 500 lignes par campagne.
- La Relance Manuelle Express reprend désormais le même instantané des destinataires que la campagne sélectionnée; les campagnes anciennes sans instantané gardent le repli vers le carnet courant. Un envoi validé en relance est rattaché à l'identifiant de sa campagne dans le journal.

### Complément — fiches commerciales sur mobile

- Les fiches mobiles reprennent maintenant les champs structurés disponibles sur PC (type, projet, mémo, description, cible, prix promotionnel/devise, avantages, objections, paiement, accès/livraison, produits et objectifs), en plus des règles et FAQ déjà présentes.
- Le contexte envoyé au fournisseur IA reprend ces champs seulement si l'option « Inclure mes Services Métiers » est activée. Les anciennes fiches simples continuent de s'afficher et restent modifiables.

### Complément — rapports locaux sur mobile

- Ajout de filtres de dates, indicateurs par canal et campagne, journal des envois, comptage des échecs et export Excel multi-feuilles (synthèse, envois, campagnes, contacts). Ces chiffres sont dérivés exclusivement de l'historique local et ne sont pas synchronisés au VPS.

### Complément — historique d'extraction des communautés

- La base IndexedDB v5 conserve les membres extraits par canal et groupe, remplace la précédente extraction du même groupe, conserve nom/rôle/date et continue d'ajouter les identifiants au carnet de contacts local.
- L'écran Communautés affiche les extractions conservées et exporte WhatsApp + Telegram en Excel. Les nouvelles installations et les bases v4 passent par la migration IndexedDB existante.

### Complément — Groupes / Diffusion Facebook assisté

- PC et téléphone ont maintenant le même écran pour importer/gérer une liste de groupes Excel/CSV, coller le lien d'une publication, copier un commentaire et lancer le partage officiel Facebook.
- Le navigateur PC ouvre les fenêtres de partage pour les groupes cochés; le mobile ouvre sa feuille native un groupe à la fois. Facebook ne préselectionne pas le groupe cible et ne fournit pas de confirmation : l'interface enregistre uniquement l'ouverture du partage, jamais un succès fictif.

## Bilan de l'etat enregistre - 2026-09-23

Cette section consolide l'avancement actuel et remplace les anciens statuts provisoires ci-dessus lorsqu'ils se contredisent. Le portage VPS -> PC local + telephone est encore en cours : la parite des interfaces et des fonctions n'est pas complete.

### Fait et verifie

- PC local : gestionnaire de campagnes branche aux routes et au runtime local (preparation/import des destinataires, lancement, programmation, pause/reprise/annulation, suivi, medias et rapports); ancienne API conservee sous `/api/legacy-campaigns`.
- PC local : Services Metiers, communautes, reponse automatique/conversation, Centre d'aide, Rapports et prospects disposent maintenant de routes ou d'ecrans locaux.
- Telephone : campagnes avec programmation locale, instantane de destinataires, controle et historique; relance manuelle rattachee a la campagne; fiches Services Metiers et contexte soumis sur opt-in; aide, rapports locaux, communautes/extractions et prospects/contacts locaux.
- PC et telephone : ecran d'assistance au partage Facebook, import CSV/XLSX et partage manuel via les mecanismes officiels. Le statut indique l'ouverture du partage, jamais une publication confirmee.
- Telephone : stockage IndexedDB v8 pour fiches metier, extractions, recommandations de rapport, journal comptable et annuaire de communautes; ces donnees restent locales, sans synchronisation VPS. Le repondeur FAQ/IA facultatif est disponible par fiche sur WhatsApp et Telegram; l'evenement Telegram a ete raccorde mais sa recette reelle reste a faire.
- Adaptateur Facebook branche sur les operations principales dans l'onglet PC local; voir le bilan tranche Facebook plus bas pour la couverture et les fonctions encore absentes.

### Verifications executees

- Suite Node: 51 tests reussis pour communautes, Services Metiers, campagnes, reponse automatique et contexte metier.
- Plusieurs controles `node --check` et tests de fumee isoles PC/mobile reussis (campagne, partage Facebook, rapports, fiches metier, extraction communautaire, relance).
- `npm run sync` reussi pour Capacitor; les ressources Android synchronisees ont ete comparees aux sources web.
- Build Android non valide: l'environnement utilise JDK 17.0.20 alors que la compilation requiert Java 21 (`invalid source release: 21`). A relancer avec JDK 21.
- Aucun compte Meta, WhatsApp ou Telegram reel n'a ete utilise pour valider les flux reseau; aucun appareil mobile reel n'a ete valide.

### Reste a faire

1. Faire l'inventaire exhaustif des 14 onglets et de chaque action VPS, puis completer les correspondances PC et mobile. Les interfaces ne sont pas encore identiques a 100%; certains ecrans mobiles restent simplifiees ou adaptes aux ponts natifs.
2. Completer Facebook/Messenger sur PC et telephone: la connexion OAuth, la Page, les conversations, la correspondance de contacts et la file d'envoi sont maintenant implementees sur le PC, mais leur recette Meta reste a faire; capture de prospects/webhooks, regles de mots-cles, planificateur commun et passerelle mobile securisee restent a porter.
3. Completer les fonctions communautaires du VPS qui ne sont pas encore disponibles localement. La decouverte mobile Telegram de groupes/personnes via le client officiel, la recherche WhatsApp via moteurs publics, l'annuaire persistant et l'ouverture volontaire des liens sont ajoutes mais non verifies. Restent les jobs de creation/invitation avec progression, pause/reprise, leur registre et l'adhesion WhatsApp par API.
4. Verifier les integrations Services Metiers connectees ajoutees sur telephone (coffre Android Keystore, transport HTTPS, passerelle de formation, System.io et journal comptable local) et terminer la couverture des rapports VPS. Les filtres locaux, l'analyse IA des indicateurs agreges et la mesure locale des campagnes ne couvrent pas encore le journal VPS, les dossiers clients/SAV, les couts IA ni les analyses des specialistes.
5. Valider sur un compte/appareil Android le flux entrant Telegram raccorde a `history_multiappend`; puis porter les reglages globaux, la transcription vocale, les groupes et le cycle de vie de session du repondeur VPS.
6. Porter l'attribution publicitaire verifiee et la prise en charge Messenger sur le mobile; la vue prospects mobile n'infere pas une provenance publicitaire.
7. Reprendre le build Android avec JDK 21, puis effectuer une recette manuelle sur PC et appareil Android avec les comptes de test et transports concernes.
8. Reprendre la parite et les tests de bout en bout jusqu'a ce que chaque ecart restant soit implemente ou explicitement bloque par une limite documentee de plateforme/API.

## Tranche suivante - operations Facebook locales (2026-09-23)

Le releve du tableau VPS (`public/dashboard.html`) a confirme un onglet Facebook distinct comprenant connexion Meta, publications de Page, conversations Messenger, commentaires et groupes geres. Le partage assiste livre precedemment ne couvre pas ces fonctions.

### PC local ajoute dans cette tranche (sauvegarde dans Git)

- Onglet Facebook/Messenger raccorde au client local.
- OAuth Meta avec etat aleatoire a usage unique, expiration de 10 minutes et rappel local; App ID/Secret saisis dans l'interface et conserves dans le dossier de donnees local, hors du navigateur.
- Etat de connexion, deconnexion, publications texte/lien/image/video, programmation dans les fenetres imposees par Meta, lecture des publications et conversations, reponses Messenger, lecture/reponse/masquage/suppression de commentaires et registre local des groupes geres.
- Le serveur PC est maintenant lie a `127.0.0.1` pour garder ses routes locales et ses secrets hors du reseau local. La publication directe dans les groupes n'est pas exposee car Meta a retire la permission necessaire; le partage officiel manuel reste disponible.

### Limites et suite obligatoire

- Fonctions Facebook VPS encore absentes du PC: capture de prospects via webhooks/commentaires, regles de mots-cles et publication Facebook Page via le planificateur commun. Les imports sont rapproches des conversations existantes et la file Messenger est disponible; registre de groupes PC synchronise avec le partage, registre mobile local.
- `mobile/webapp` ne conserve aucun secret Meta et n'a pas de serveur local; il garde le partage Facebook manuel. Pour porter publication Page et Messenger sans exposer le secret dans l'application, il faut une passerelle serveur autorisee et une authentification mobile appropriee, puis les memes commandes/retours d'etat dans l'interface telephone.
- Le rapprochement integral des 14 onglets/actions VPS avec les interfaces PC et mobile reste requis. Cette tranche est sauvegardee dans les commits `4375fa4` et `93da9db`; cette sauvegarde ne signifie pas que la parite est terminee.
- Verification executee pour cette tranche : controles `node --check` sur serveur et UI Facebook PC; `git diff --check`; les 51 tests cibles passent; un test de fumee avec Axios simule valide les operations adapter (statut, Page, conversations, publication, envoi Messenger, commentaires et moderation). La synchronisation Capacitor passe aussi. La connexion Meta et l'URI OAuth exigent encore une recette avec une application de developpement Meta autorisee.

### Harmonisation supplementaire Facebook (PC + telephone)

- L'ecran Groupes / Diffusion exporte maintenant la liste en Excel sur PC et mobile avec nom, lien, identifiant, date d'ajout et derniere action.
- Sur PC, la liste de partage est fusionnee avec le registre de groupes de l'onglet Facebook et synchronisee localement; sur mobile elle reste dans le stockage local de l'appareil. Le fichier Android synchronise correspond aux sources (`facebook-share.js` et `index.html`, SHA-256 verifies).
- Suite ciblee deja executee: 51/51; test simule de l'adaptateur et registre de groupes reussi; `node --check`, controle des selecteurs UI et `git diff --check` reussis; `npm run sync` reussi. Les appels Meta en direct et la recette sur appareil n'ont pas ete executes.

### File de relance Messenger PC (2026-09-23)

- Import CSV/Excel de contacts et rapprochement cote serveur avec les conversations Messenger existantes de la Page par PSID/identifiant ou nom. L'interface montre les correspondances et exige une selection explicite; les contacts sans conversation ne peuvent pas etre coches.
- Envoi texte ou media image/video en file, progression consultable, lot de 25 et temporisation aleatoire de 10 a 15 secondes. Le serveur revalide lui-meme chaque destinataire contre les conversations de la Page avant de lancer; liste plafonnee a 500 et media a 10 Mo.
- Les erreurs Meta restent affichees par destinataire dans le resultat; cette protection n'etend pas la fenetre de messagerie Meta et l'application ne pretend pas que l'API a accepte les messages sans retour confirme.
- La file locale et sa progression sont en memoire et disparaissent si le processus s'arrete; la durabilite apres redemarrage et le bouton d'arret de file restent a implementer si requis par le VPS.

### Sauvegarde et diagnostic de la passerelle mobile (2026-09-23)

- Le portage PC/mobile et ses mises a jour de statut sont enregistres dans `4375fa4` (portage principal), `93da9db` (flux Facebook/Messenger PC et harmonisation) et `b2a7233` (bilan de portage). Ces commits sont locaux; ils ne constituent pas une publication distante.
- Le Worker `cloudflare/license-worker` expose actuellement les routes de licence, IA et medias, mais aucune route Facebook/Messenger. Son authentification accepte une licence active liee au bon appareil, et aussi une licence encore non liee; une future connexion Facebook devra exiger une liaison deja etablie.
- `cloudflare/license-worker/wrangler.toml` contient encore un identifiant D1 fictif et `docs/AUTONOMIE-SANS-VPS.md` indique que le Worker local n'est pas deploye. La passerelle mobile reste donc a concevoir et implementer, puis a configurer avec une migration D1, les secrets cote Worker, une URI OAuth Meta autorisee et une recette de bout en bout. Aucun jeton Meta ni secret d'application ne doit etre expose dans le client mobile.
- Aucun changement de Worker ni de passerelle mobile n'est inclus dans cette sauvegarde. Les ecarts et verifications restants sont listes dans « Reste a faire » ci-dessus; la parite complete des interfaces et fonctionnalites VPS n'est pas encore atteinte.

### Répondeur FAQ/IA local sur mobile — implémenté, non vérifié

- La fiche métier mobile propose, par canal, réponse FAQ exacte et réponse IA aux messages privés sans correspondance FAQ. Chaque option reste désactivée sauf activation explicite sur la fiche.
- Lorsque le mode IA est activé, le téléphone transmet à la cascade texte Cloudflare la question entrante, jusqu'aux 7 messages précédents et la fiche du service sélectionné. Les clés des fournisseurs restent dans le Worker; le téléphone envoie la clé de licence et l'identifiant de l'appareil déjà utilisés par l'écran IA.
- Les 12 derniers messages de chaque conversation sont conservés dans le stockage local du navigateur. Le répondeur ignore les groupes et les contacts bloqués, ajoute les demandes de désinscription à la liste noire locale et limite chaque canal à 10 générations par contact et par heure. Le prompt interdit d'inventer des offres/prix ou de confirmer une action sensible.
- Le pont WhatsApp existant et le pont Telegram `history_multiappend` transmettent les messages privés texte au même traitement FAQ/IA et renvoient la réponse dans la WebView concernée. Le schéma de l'événement suit l'implémentation amont de [Telegram Web K](https://raw.githubusercontent.com/morethanwords/tweb/master/src/lib/appManagers/appMessagesManager.ts), mais le raccordement live reste à valider. La tranche complète n'a pas encore été testée par analyse syntaxique, compte réel ou appareil Android. Les réglages globaux VPS, gardien de sessions, transcription vocale et réponses Telegram aux groupes restent absents.

### Rapports et boucle d'amélioration sur mobile — implémentés, non vérifiés

- L'écran Rapports accepte désormais les filtres de période, canal, statut de campagne et recherche locale. Les indicateurs distinguent les campagnes terminées, en cours, annulées, en échec et celles avec des destinataires échoués; l'export Excel suit les filtres visibles.
- L'analyse IA envoie à Cloudflare des agrégats seulement (comptages, statuts, taux), sans noms, numéros ni texte de message. Les réponses utilisent le même client IA sous licence que la génération de texte.
- Une recommandation de contrôle des échecs peut être enregistrée dans IndexedDB v8. Sa validation est déclarative et manuelle. La mesure suivante compare les taux sur les campagnes créées après validation; l'écran précise que cette évolution ne démontre pas un lien causal.
- Cette adaptation ne dispose pas des dossiers client/SAV, événements du journal central, coûts d'usage IA ni spécialistes VPS. Aucune campagne ni aucun destinataire n'est modifié automatiquement. Tranche non encore vérifiée par analyse syntaxique, test de fumée, compte ou appareil réel.

### Services Métiers connectés sur mobile — implémentés, non vérifiés

- Les fiches mobile acceptent maintenant les connecteurs passerelle de formation, System.io, API générique et comptabilité locale. Les clés sont chiffrées dans Android Keystore AES/GCM et ne sont jamais renvoyées au JavaScript; le transport natif autorise HTTPS, borne les corps/réponses et n'envoie pas les secrets aux redirections.
- Le test de connexion et les actions à permission explicite sont portés pour l'inscription/suspension via passerelle, la recherche/création de contacts et l'attribution de tags System.io. Le journal ventes/factures reste sur l'appareil et alimente les rapports mobiles.
- Un nouveau connecteur natif ouvre uniquement les liens HTTPS `chat.whatsapp.com` et `t.me` choisis par l'utilisateur. Le raccordement requiert un build Android avec ces plugins installés; aucun appel API réel ni build n'a été exécuté pour cette tranche.

### Découverte de communautés sur mobile — implémentée, non vérifiée

- La recherche WhatsApp mobile interroge DuckDuckGo, Bing et Startpage depuis le transport HTTPS Android, comme la voie annuaire public du VPS. Les recherches Telegram de groupes/canaux et de personnes utilisent le client WebK connecté et `appMessagesManager.requestHistory` avec les filtres globaux correspondants; les groupes exposent titre, username, lien et nombre de membres si fourni. Un profil public n'est ajouté au carnet local comme prospect qu'après clic explicite.
- Les liens trouvés sont dédoublonnés et conservés dans l'annuaire IndexedDB v8. Les liens WhatsApp restent « non vérifiés »; Telegram marque comme vérifiés uniquement les résultats renvoyés par sa recherche officielle. Ouvrir un lien est volontaire et l'application ne rejoint aucun groupe et n'envoie aucun message automatiquement.
- Limite connue : aucun filtre de localisation Telegram natif n'est appliqué; WhatsApp retourne des liens d'annuaires non vérifiés. La création/invitation de groupes et les jobs persistants restent absents du mobile. La recherche de personnes expose uniquement les profils publics que Telegram retourne par recherche textuelle, sans filtre réel par centres d'intérêt. Tranche non encore vérifiée sur Android réel ni via les moteurs publics.

## Checkpoint d'implementation - 2026-09-24

Telephone, prioritaire :
- Ajout d'un ecran Programmation / Planning pour les messages texte et medias WhatsApp/Telegram, avec stockage IndexedDB, etats envoyee/echec/incertain/echeance passee, annulation et nouvelle tentative explicite. Le rattrapage automatique n'envoie pas silencieusement les echeances manquees.
- Ajout de jobs locaux persistants de creation/invitation aux communautes, progression, pause/reprise, liste noire, confirmations et resultats incertains. WhatsApp propose le lien officiel si l'ajout direct est indisponible; tout message prive de lien requiert un opt-in.
- Ajout des reglages globaux du repondeur dans IndexedDB v11 : WhatsApp, Telegram, actif sur les deux canaux, pause et autorisation explicite des groupes. Les options FAQ/IA par Service Metier restent des opt-in separes. Les messages de groupe sont maintenant transmis au traitement; publications Telegram de canal ignorees.
- Ajout des ponts Android HTTPS, ouverture de liens communautaires via navigateur natif, coffre Keystore AES/GCM et transport natif. La WebView mobile n'embarque pas de secret fournisseur IA.

PC :
- La file Facebook Messenger est maintenant persistante dans SQLite local, expose un historique des destinataires et accepte un arret. Au redemarrage, le destinataire dont l'envoi etait en cours est marque incertain; les autres non envoyes sont distingues et ne sont pas relances automatiquement.

Verification de ce checkpoint : node --check sur les scripts modifies du PC et du telephone, git diff --check, npm run sync reussi. Les SHA-256 de index.html, lib/db.js, business-services-mobile.js, whatsappBridge.js et telegramBridge.js correspondent aux ressources Android synchronisees. Aucun test automatise, compte Meta/WhatsApp/Telegram reel, appareil Android ni build Android n'a ete execute pour cette tranche. Le build Android reste a reprendre avec JDK 21.

Restent en particulier : passerelle Facebook/Messenger mobile securisee et ses prerequis Meta/Cloudflare, captures de prospects et regles de mots-cles Facebook cote PC, journal/couts/dossiers SAV complets dans les rapports mobiles, transcription vocale mobile et inventaire de parite action par action des 14 onglets VPS. Les integrites dependantes d'une application Meta approuvee, d'un Worker deploye ou d'un appareil reel ne peuvent pas etre declarees validees par le seul code local.