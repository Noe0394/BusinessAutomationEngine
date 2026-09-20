# JARVIS — moteur conversationnel (état au 2026-09-20)

Branche `feat/jarvis-engine`. Code : `ai-engine/jarvis/`, copié dans `local-client/ai-engine/jarvis/`
(hors `agentLoop.js`, qui dépend du `toolRegistry` VPS).

| Module | Rôle |
|---|---|
| `intentClassifier.js` | 21 intentions FR, mots entiers, négation locale, drapeaux (report, question, sujets, plainte de répétition). `arbitrate()` : l'IA tranche seulement les cas ambigus ; STOP déterministe non contournable |
| `conversationState.js` | état par (tenant, canal, contact) : NEW…CLOSED, refus, mémoire compacte, dernières réponses ; TTL 7×24 h, purge exacte |
| `conversationEngine.js` | décision en code (NO_ACTION / CLOSE / WAIT / ANSWER…), consignes injectées dans le prompt, garde post-rédaction (relance commerciale après refus, répétition, montant absent des données), 1 régénération max puis filet déterministe |
| `conversationQueue.js` | file série par conversation + regroupement des messages rapides |
| `repetitionGuard.js` | similarité de réponses, questions déjà posées, détection de relance commerciale |
| `agentLoop.js` | Chat Intelligent multi-outils : bornes (5 étapes, 8 appels IA, timeouts), détection de boucle, PREPARE → confirmation → EXECUTE → VERIFY |

Points d'entrée : `autoResponder.handleIncoming` (chemin prioritaire) et `emotionalCloser.handleCustomerMessage`
(chemin `AUTO_CLOSE_PROSPECTS`) passent par le même moteur. `settings.jarvis=false` restaure l'ancien comportement.

Local-first : `storageAdapter.LOCAL_ONLY_NAMESPACES` (historique, index, états, CRM, activité, sessions closer)
n'est plus poussé vers GitHub (sauf `GITHUB_MIRROR_USER_DATA=true`). Le volume Docker `app_data` du VPS porte ces données.

Registre de refus : `contactCrm.markOptOut/isOptedOut`, respecté par les campagnes WhatsApp/Telegram
(`skipped_optout`) et par les envois autonomes du Chat Intelligent.

Non fait / à valider en conditions réelles : tests avec de vrais comptes WhatsApp/Telegram et de vraies clés IA,
déploiement VPS, build `.exe`, portage Mobile, déploiement du Worker Cloudflare (`cloudflare/license-worker/README.md`),
migration des fonctions IA de secours Firebase (`generateTextFallback`…) vers Cloudflare.

## Prompt global « système autonome » — état par phase (2026-09-20)

| Phase | Réalisé (vérifié par tests locaux) | Non réalisé / limite réelle |
|---|---|---|
| 1 Registre d'outils | 46+ outils avec contrat, risque, prepare/confirmation, journalisation (`toolRegistry`, `toolsExtra`) | noms en camelCase (convention existante), pas snake_case |
| 2 Moteur conversationnel + mémoire | historique 7 j, état de conversation, sujet courant, mémoire compacte | mémoire « sémantique » longue durée : non faite (volontairement légère) |
| 3 Smart Chat -> outils | boucle multi-outils bornée, confirmation, vérification | — |
| 4 Contacts | texte/CSV/Excel -> normalisation -> doublons -> validation -> destinataires ; OCR pluggable | **OCR image : moteur `tesseract.js` non installé** -> échec honnête `OCR_ENGINE_MISSING` (décision d'installation à prendre : ~30 Mo + données de langue) |
| 5 Campagnes | brouillon -> média -> lancement confirmé / programmé, pause, reprise, annulation, statut, rapport CSV via le moteur existant | média de campagne : WhatsApp uniquement ; côté PC (`local-client`) les nouveaux outils ne sont pas portés |
| 6 Queues / workers / scheduler | file durable (priorité, retry+backoff, bail, reprise après crash, idempotence) + worker démarré dans `index.js` | pas de déclencheurs/conditions/workflows génériques (moteur de workflow non fait) |
| 7 Protection / fallback | fiche de continuité idempotente (un fallback par campagne parente), notification, fermeture à la reprise ; protections existantes intactes | le pipeline « Envoyer/deep-link » s'ouvre sur l'appareil de l'utilisateur : **il ne peut pas être exécuté automatiquement par le serveur** |
| 8 WhatsApp/Telegram conversationnel | pertinence avant conversion : aucune promotion non sollicitée, contextes sensibles, groupes (désactivés par défaut), activité humaine (WhatsApp), anti-boucle, données privées | activité humaine **Telegram** non détectée (seul WhatsApp remonte les messages `fromMe`) |
| 9 CRM / médias / rapports / notifications | outils CRM, médias (métadonnées, validation, attache), statistiques, notifications | redimensionnement/compression média, rapports PDF/Excel planifiés : non faits |
| 10 Services métiers | existant conservé | — |
| 11 Local/VPS + sync + reprise | reprise VPS (file durable + campagnes existantes) | **synchronisation Local<->VPS non implémentée** (aucun flux de données entre cibles aujourd'hui) |
| 12 Diagnostics / sécurité / audit | `getSystemStatus` (connexions, file, erreurs réelles), journal d'activité des appels d'outils, coffre existant | pas de couche `SecurityService` unifiée |

Couche AIProvider : cascade existante + OpenAI, Mistral, Claude (activés par `OPENAI_API_KEY`, `MISTRAL_API_KEY`, `ANTHROPIC_API_KEY`).

## Onglet Campagnes unifié (2026-09-20)

Code : `ai-engine/campaignService.js`, `lib/campaignStatus.js`, routes `/api/campaigns*` (index.js), onglet « 📣 Campagnes »
(`public/dashboard.html`). Les outils Smart Chat (`createCampaignDraft`, `launchCampaign`, `scheduleCampaign`, `monitorCampaign`,
`getCampaignProgress`, `generateCampaignReport`…) utilisent le MÊME service : une campagne créée dans le chat apparaît dans l'onglet.

Chaîne : source (liste collée / Excel / CSV / photo OCR) -> parse -> normalisation -> doublons -> validation -> table
(valid / duplicate / invalid / uncertain) -> campagne (message + média WhatsApp + programmation) -> lancement par les moteurs
existants (`campaignEngine` / `telegramCampaignEngine` : cadence, protections, persistance, reprise) -> suivi réel -> rapport CSV.

**Ce que « manuel / continuité » signifie techniquement (à lire avant de tester) :**
le mode manuel existant ouvre un lien `wa.me/...?text=` (ou `t.me/...`) sur l'appareil de l'utilisateur ; l'envoi est validé
dans l'application WhatsApp/Telegram de cet appareil. Le serveur ne peut ni cliquer ni valider ce lien. Automatiser l'envoi
par la session liée reviendrait à contourner la protection réseau, ce qui est exclu. La continuité automatique est donc :
1. détection (`circuit_open`, puis mode assisté au 2e échec de surcharge), arrêt propre, état conservé ;
2. UNE fiche de continuité idempotente + notification ;
3. reprise AUTOMATIQUE par le moteur existant après la temporisation de protection (contrôle de santé de la session),
   uniquement sur les destinataires restants ;
4. la file de relance manuelle (deep-link) reste disponible, avec les restants, si l'utilisateur veut l'utiliser.

Non fait : envoi automatique des liens `wa.me` ; onglet Campagnes dans l'application mobile/PC (`webapp-core`) ; OCR image
(moteur `tesseract.js` à installer) ; interface non vérifiée visuellement dans un navigateur (syntaxe et API testées).

## Mémoire 7 jours refondue, Chat Intelligent sans contrainte, répondeur permanent (2026-09-20)

**Mémoire** (`ai-engine/messageHistory.js`) : un document PAR JOUR (plus de fichier unique plafonné à 2000 messages), écritures
sérialisées par conversation (plus de message perdu en cas de messages simultanés), idempotence par identifiant de message (envoi
Cyrus + écho, import d'historique), vue toujours limitée à [maintenant − 7×24 h, maintenant], purge exacte par jour. L'ancien format
est migré automatiquement au premier accès. Nouvelles sources : historique WhatsApp de la synchronisation initiale, messages rattachés
hors ligne (`append`), messages écrits depuis le téléphone (`fromMe`) et envois de Cyrus (campagnes comprises).
Limite réelle : WhatsApp ne fournit l'historique qu'au tout premier appairage complet ; il n'est pas récupérable rétroactivement.

**Questions sur la mémoire** (`ai-engine/memoryQuery.js`, intention `memory` du chat, outil `queryMemory`) : périodes exactes (hier,
avant-hier, aujourd'hui, il y a N jours, cette semaine), contact, sujet, listes, décomptes, résumé (IA limitée à l'extrait fourni,
repli déterministe). Chaque réponse indique l'étendue réelle de la mémoire et signale ce qui n'est pas couvert.

**Chat Intelligent** : il exécute l'ordre tel que donné (consignes communes dans `personaManager` et `llmFallbackEngine`). Plus de
confirmation par défaut (`JARVIS_CONFIRM_FROM` pour la réactiver), plus de blocage d'un envoi ordonné vers un contact ayant demandé
l'arrêt (simple note), les plans d'objectif sont exécutés directement (`CHAT_CONFIRM_PLANS=true` pour l'ancien comportement),
`includeOptOut` pour inclure ces contacts dans une campagne. Les REFUS des clients restent respectés par le répondeur automatique.

**Répondeur permanent** : `AUTO_REPLY_ALWAYS_ON_TENANTS` (liste) ou réglage `alwaysOn` (outil `setAutoReply`, `POST /api/auto-responder`).
Un compte permanent répond en continu sur WhatsApp ET Telegram (pause explicite possible : `paused`). Le gardien
(`ai-engine/responderKeeper.js`) vérifie chaque minute les sessions, relance une session appairée mais coupée (au plus une tentative
toutes les 5 min), et ces sessions ne sont jamais évincées. État : `GET /api/auto-responder/status`, outil `getAutoReplyStatus`.

## Couche d'assistance générale (2026-09-20) — identité, alertes, conversations privées, canal propriétaire

Le Chat Intelligent reste le cerveau ; WhatsApp du propriétaire n'est qu'une interface vers lui.

| Module | Rôle |
|---|---|
| `contactIdentity.js` | Résolveur central : nom -> vrai numéro -> « Contact non identifié ». Un LID/JID de groupe/id Telegram n'est JAMAIS un numéro ; `scrubTechnicalIds` en filet de sécurité. Annuaire local d'alias (LID <-> numéro appris de WhatsApp). |
| `conversationRouter.js` | Classe chaque message (privé banal / personnel / sensible / urgent / rappel / métier…), décide AUTO_REPLY / AUTO_REPLY_NOTIFY / HUMAN_REQUIRED / SILENT / BUSINESS, réponses d'attente non répétitives, handoff (AI_ACTIVE, HUMAN_REQUIRED, HUMAN_ACTIVE, AI_RESUMED). L'arbitrage IA ne peut que renforcer la prudence. |
| `alertCenter.js` | 6 niveaux, politique (`alertPolicy` dans les réglages : `minOwnerLevel`, `notifyCasual`, `aggregateWindowMs`…), agrégation, idempotence, persistance locale. |
| `pendingActions.js` | Actions en attente `PA-XXXX` (PENDING→APPROVED→EXECUTING→DONE/FAILED, REJECTED, EXPIRED), transitions atomiques. |
| `ownerChannel.js` | Self-chat -> Chat Intelligent, OUI/NON, reprise de conversation, anti-boucle (marqueur invisible, ids d'envoi, plafond/minute, écho). `settings.ownerNumbers` = autres numéros propriétaires, explicitement configurés. |
| `assistantLayer.js` | Colle index.js <-> modules ; démarre les livreurs d'alertes (WhatsApp propriétaire puis tchat du dashboard). |

Réglages : le canal propriétaire suit l'activation du répondeur WhatsApp (`ownerChannel:false` pour le couper). Routage actif
seulement si le répondeur est activé pour le canal ; `assistant:false` le coupe ; `firstContactMode:'private'` traite aussi
la toute première salutation d'un inconnu comme privée (par défaut : accueil commercial si une activité est configurée).
Paiements : `manualPaymentValidator` — preuve -> action `PA-XXXX` -> OUI/NON -> API -> VÉRIFICATION (`ok`/`uid`/`account_created`
dans la réponse ; sinon FAILED et le client n'est pas prévenu). Tests : `contact-identity`, `alert-center`, `conversation-router`,
`payment-owner-flow`, `owner-channel`.
Limites connues : Telegram n'a pas de self-chat exploitable ici (canal propriétaire = WhatsApp) ; routage privé désactivé si le
répondeur du canal est désactivé ; classification par signaux + contexte (pas un LLM) ; tests réels WhatsApp/RIEA non exécutés.

## Campagnes Facebook Ads (Service Métier) — 2026-09-20
Configuration par le Chat Intelligent (intention `adcampaign` -> outil `configureFacebookAdCampaign`, aussi `listFacebookAdCampaigns`,
`setFacebookAdCampaignStatus`) ; stockée dans `service.adCampaigns` (`businessServices.js`). Code : `ai-engine/adCampaigns.js`
(origine, règle, envoi idempotent, tags, mémoire, contexte de continuation), `adCampaignParser.js` (message EXACT extrait sans IA).
Origine RÉELLE seulement : `contextInfo.externalAdReply` (sourceType=ad, sourceId, sourceUrl, ref, ctwaClid), `conversionSource`,
`entryPointConversionSource`. Sans ces données, un contact reconnu par son message d'entrée est étiqueté `source_declared_facebook_ads`
(jamais `source_facebook_ads`). Nouveau contact strict : aucun CRM, aucun message en mémoire (7 j), aucun état, aucun passage au registre.
Limite : la mémoire ne remonte qu'à 7 jours ; un contact plus ancien sans trace locale peut être vu comme nouveau. Hook : `index.js`
(`assistant.adEntry`, avant le routage privé et le répondeur). Tests : `test/ad-campaigns.test.js`.

## Campagnes de groupes administrés — 2026-09-20
Code : `ai-engine/groupCampaigns.js` (ciblage, scheduler, intérêt, preuve, rapport), `groupCampaignParser.js` (mot-clé, durée, horaires,
messages entre « », objectif), outils `createGroupCampaign` / `listGroupCampaigns` / `stopGroupCampaign` / `setGroupCampaignGoal` /
`getGroupCampaignReport` (`toolsExtra.js`), intention `groupcampaign` (`chatOrchestrator.js`, donc aussi via le self-chat), hooks
`assistant.groupEntry` / `assistant.leadDm` (`assistantLayer.js`, `index.js`), tick d'une minute dans `index.js`.
Règles : nom du groupe insensible casse/accents ; seuls les groupes où le compte est RÉELLEMENT admin (contrôle à la création ET à
chaque envoi ; `getGroupsSummary` compare numéro ET LID) ; liste figée ; 1 envoi par créneau/jour (claim avant envoi) ; créneau raté
> 90 min = non envoyé ; créneaux passés le jour de création non rattrapés ; arrêt automatique + 3 jours de grâce pour les réponses.
Intérêt (intentClassifier) -> offre en privé composée UNIQUEMENT du Service métier (prix, `commercial.paymentTerms`) ; champ manquant =
dit + alerte, jamais inventé. Preuve : rattachée par `contactId` EXACT (capture sans légende acceptée -> email demandé) ->
`manualPaymentValidator.registerProof(origin)` -> `PA-XXXX` -> OUI/NON -> API -> vérification -> suivi (leads, objectif).
Limites : le rapport n'additionne que les montants DÉCLARÉS des paiements CONFIRMÉS ; message privé à un LID non joignable = alerte ;
Telegram non couvert ; réponses aux membres dans les groupes non administrés jamais traitées.
