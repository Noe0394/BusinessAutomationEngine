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
| 3 | Répondeur permanent (compte « toujours actif », gardien de sessions, réglages `/api/auto-responder`) | `ai-engine/alwaysOn.js`, `responderKeeper.js`, `autoResponder.js` | PARTIEL (fichiers copiés, non branchés à un point d'entrée/route ni testés) | À FAIRE |
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
