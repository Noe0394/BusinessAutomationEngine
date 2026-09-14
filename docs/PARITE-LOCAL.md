## 🎙️ Chantier "Traitement Vocal Autonome" (`ai-engine/voiceProcessor.js`)

**Fait** :
- `ai-engine/voiceProcessor.js` (nouveau) : `transcribeAudio()` (cascade
  Groq Whisper → Gemini Audio, clés déjà existantes réutilisées, aucune
  nouvelle clé requise pour le STT), `translateToFrench()` (réutilise la
  cascade TEXTE existante `llmFallbackEngine.js`, heuristique de détection
  rapide pour éviter un aller-retour inutile si déjà en français, testée sur
  plusieurs cas), `synthesizeSpeech()` (cascade ElevenLabs → Google TTS,
  AUCUN niveau gratuit-sans-clé garanti contrairement au texte — dégrade
  proprement vers `null` si aucune clé configurée). File d'attente à
  concurrence limitée (sémaphore, `MAX_CONCURRENT_VOICE_JOBS`, défaut 3)
  pour absorber un pic de notes vocales pendant une grande campagne (§3).
  **Écart assumé** vs. la formulation littérale du cahier des charges :
  aucune garantie de latence "<2 secondes" n'est promise (dépend du
  fournisseur LLM/réseau réellement utilisé, jamais garanti nulle part
  ailleurs dans ce dépôt non plus) — un cache court (10 min,
  anti-doublon exact) existe côté `emotionalCloser.js`, pas ici.
- `adapters/whatsappEngineBaileys.js` : `sendVoiceNote()` (PTT réel) et
  `downloadIncomingMedia()` (API canonique Baileys `downloadMediaMessage`).
  `adapters/telegram.js` : `sendVoiceNote()` (GramJS `sendFile` +
  `voiceNote:true`) — le téléchargement Telegram utilise directement
  `msg.downloadMedia()`, natif à l'objet message GramJS, aucun wrapper
  nécessaire.
- `index.js#POST /api/ai-studio/sessions/:id/messages` (Copywriter Studio
  IA — tchat vendeur) : une pièce jointe AUDIO remplace désormais le texte
  par sa transcription+traduction (au lieu d'être traitée comme une image) ;
  `userMessage.voiceTranscript` exposé pour l'affichage "🎙️ transcrit" côté
  frontend (§2.2 du cahier des charges) — **frontend (dashboard.html) non
  modifié**, cette valeur existe côté API mais n'est pas encore affichée
  visuellement (pas demandé explicitement, `public/dashboard.html` reste la
  référence de design à ne jamais retoucher sans consigne précise).
- `index.js#handleIncomingCustomerMessage` : détection de note vocale
  entrante (WhatsApp `audioMessage.ptt`, Telegram `.voice`) → téléchargement
  → transcription/traduction → traitée EXACTEMENT comme un message texte
  par le pipeline existant (message-triage/emotionalCloser/ANSWER_STUDENT_QUERY,
  aucune logique dupliquée). Réponse dans la MÊME modalité que le client
  (TTS best-effort si le client a parlé, repli texte propre sinon).
- `.env.example` : `GROQ_WHISPER_MODEL`, `ELEVENLABS_API_KEY`/`_VOICE_ID`,
  `GOOGLE_TTS_API_KEY`, `MAX_CONCURRENT_VOICE_JOBS`.

**Testé** : heuristique de détection français (`looksLikelyFrench`) sur
plusieurs cas (français/anglais/wolof-like) — correcte. Reste (STT/TTS
réels, téléchargement Baileys/GramJS réel) **non testable dans cet
environnement** (aucune note vocale WhatsApp/Telegram réelle disponible,
aucune clé API audio configurée) — vérifié uniquement par relecture +
`node --check`, conformément à la pratique déjà établie dans ce dépôt pour
ce type d'intégration plateforme-spécifique.

**Non fait** : conversion Opus locale côté mobile/PC pour économiser la
donnée avant envoi au pipeline de transcription (§3, "Optimisation de Bande
Passante") — nécessite du code natif/ffmpeg côté client, hors de portée
d'une session VPS-only ; réplication local-client/mobile de tout ce
chantier (même raison que les chantiers précédents) ; affichage visuel du
micro/de la transcription dans `public/dashboard.html`.

---

## 🗣️ Chantiers "Human-like Dialogue" (`personaManager.js`) + "Closing Humanisé" (`emotionalCloser.js`)

**`ai-engine/personaManager.js`** (nouveau) — élimine le ton robotique côté
VENDEUR (Copywriter Studio IA) : `rephrase({kind, rawText, facts, domain})`
repasse CHAQUE texte technique (question de brief, plan prêt, confirmation)
par un appel LLM contraint par une consigne de personnalité fixe
("Associé Virtuel", ton adaptatif e-commerce/service/formation via
`inferDomain(businessProfile)`), sans jamais inventer de faits (`facts`
toujours injecté tel quel). `detectAffirmative`/`detectDecline` (regex FR,
zéro réseau) pilotent un vrai changement de comportement :

- **`ai-engine/chatOrchestrator.js#handleGoal` restructuré** : le plan
  ('goal', ex. campagne) n'est PLUS exécuté automatiquement dès qu'il est
  prêt (comportement de la session précédente) — l'Agent reformule
  chaleureusement et DEMANDE confirmation ; l'exécution ne démarre qu'au
  message suivant si le vendeur confirme ("oui", "vas-y", "go"...), et
  tourne alors EN ARRIÈRE-PLAN (`runGoalPlanInBackground`, fire-and-forget) —
  réponse immédiate ("Fluid Streaming", §2 du cahier des charges), résultat
  final poussé dans le tchat via `platformOrchestrator.notifyTenantChat` une
  fois l'exécution terminée. Les actions "un coup" (paiement, compte élève)
  restent exécutées dès que prêtes — coût/risque sans commune mesure avec
  une campagne envoyée à de vrais contacts.
- `offerClarifier.js#planOffer` et `chatOrchestrator.js#planPayment/planAccount` :
  prompt LLM enrichi de `personaManager.personaSystemPrompt(domain)`.
- **Testé de bout en bout avec mocks** (tenant/dossier temporaire) : le
  scénario "vendre 10 formations" → question canal → **plan affiché SANS
  exécution** → "oui vas-y" → **ack immédiat** → exécution réelle confirmée
  ~1,5s plus tard en arrière-plan. Qualité du TEXTE dégradée dans cet
  environnement de test (aucune clé API configurée, Pollinations à quota
  dépassé) — mécanique 100% correcte, filet de repli sur texte brut vérifié
  fonctionnel.

**`ai-engine/emotionalCloser.js`** (nouveau) — répond aux messages entrants
d'un PROSPECT/CLIENT final (WhatsApp/Telegram), posture Conseiller-Vendeur
empathique. **Découverte clé** : `lib/intelligence/human-context-engine.js`
avait déjà un moteur d'analyse émotionnelle très complet (sentiment/
intention/objection PRICE·TRUST·TIME/hésitation/urgence, registre de
stratégies avec angle+objectif par objection, cascade de décision à 4
niveaux) — réutilisé tel quel (`analyzeMessage`, `selectStrategy`,
`detectIntuition`) plutôt que dupliqué. Ce qui manquait et a été ajouté :
- Les gabarits de stratégie existants ont des placeholders JAMAIS remplis
  (`{valeur1}`, `{avantage1}`...) — `composeClosingReply` les remplace par
  un appel LLM guidé par l'angle/objectif de la stratégie + les VRAIS faits
  business (offre/prix/plafond de remise/statut paiement, jamais inventés).
- **Alertes de Relais** (§2 cahier des charges) : `shouldEscalate` (signal
  B2B/sur-mesure explicite OU `detectIntuition` renvoyant une hésitation
  persistante malgré un intérêt élevé) → notifie le vendeur dans son tchat
  (`platformOrchestrator.notifyTenantChat`, formulation reprise du cahier
  des charges) et **arrête définitivement l'auto-réponse pour ce client**
  (`session.escalated`, persisté) tant qu'aucune reprise manuelle n'existe
  (non implémentée — TODO).
- **Collecte de feedback sur décision** : intent DECLINE → question ouverte
  chaleureuse, réponse du tour suivant capturée telle quelle et remontée au
  vendeur (`profile.feedback[]` + notification tchat "💡 ...").
- Cache court (10 min) anti-doublon de messages identiques — PAS une
  garantie de latence <2s (dépend du fournisseur LLM réel, jamais promis
  faussement ici malgré la formulation du cahier des charges).
- **Testé de bout en bout** (tenant isolé) : escalade B2B → notification
  vendeur avec le texte exact attendu → clients suivants correctement
  ignorés ; déclin → question de feedback → réponse capturée et remontée.
  Détection d'intention/objection/stratégie vérifiée sur plusieurs cas
  (achat, objection prix, déclin, B2B) — tous corrects.
- Câblé dans `index.js#handleIncomingCustomerMessage` derrière un NOUVEAU
  flag `AUTO_CLOSE_PROSPECTS` (défaut `false`, même prudence que
  `AUTO_ANSWER_STUDENT_QUERIES` — jamais d'envoi auto à de vrais clients
  sans activation explicite), prioritaire sur `AUTO_ANSWER_STUDENT_QUERIES`
  quand actif.

**Non fait** : réplication local-client/mobile (mêmes raisons que les
chantiers précédents) ; mécanisme de désescalade manuelle (reprise de
l'auto-closing par le vendeur après une alerte) ; push/déploiement (pas
redemandé explicitement pour ce tour, contrairement au tour précédent).

---

## 🔗 Chantier "Orchestrateur Inter-Modules" (`ai-engine/platformOrchestrator.js`, suite immédiate du chantier ci-dessous)

**§1.1 Anti-spam/basculement transparent** — `lib/circuitBreaker.js` détectait
DÉJÀ les signaux de surcharge (429/FLOOD_WAIT/timeout) et mettait la file en
pause avec reprise automatique par palier (statuts `normal`/`degraded_network`/
`circuit_open`, voir `queues/campaignEngine.js`/`telegramCampaignEngine.js`) —
il manquait (1) la notification dans le tchat (2) la distinction trouble
persistant vs. aléa isolé. Ajouté :
- `CampaignEngine`/`TelegramCampaignEngine` : 4e paramètre constructeur
  `onNetworkStatusChange`, appelé aux 3 points de transition
  (`_recordSendLatency`, catch de surcharge, `_waitForNetworkHold`). Dès le
  2e échec de surcharge CONSÉCUTIF : `campaign.assistedMode = true` (Mode
  Semi-Automatique — pointe vers "Relance Manuelle Express", déjà existant
  dans `public/dashboard.html`, jamais réinventé).
- `adapters/whatsappManager.js`/`telegramManager.js` : câblent ce callback
  vers `ai-engine/platformOrchestrator.js#onCampaignNetworkStatusChange`.
- `ai-engine/platformOrchestrator.js` (nouveau) : bus d'événements
  (`EventEmitter` Node standard — §2 du cahier des charges, "sans créer de
  dépendances rigides") + traduction en message de tchat exact (formulation
  du cahier des charges reprise mot pour mot) poussé dans la session
  Copywriter Studio IA la plus récente du tenant. **Testé de bout en bout**
  (tenant/dossier temporaire isolé, nettoyé après coup) : le message généré
  correspond exactement à l'exemple du cahier des charges.

**§1.2 Génération de contenu -> vente, de bout en bout** — chaînage LÉGER
(pas de nouvel état, réutilise la continuation de conversation déjà en
place) : `index.js` détecte le suffixe "... et mets-le en vente" sur une
demande d'affiche/vidéo/livre (`SALE_SUFFIX_RE`, `userMessage.saleIntent`) ;
une fois le contenu RÉELLEMENT généré (bouton cliqué, ou job vidéo terminé),
l'assistant demande le prix — la réponse du vendeur est alors prise en
charge NORMALEMENT par `chatOrchestrator.js#handlePayment` (déjà construit)
qui génère l'instruction de paiement. Jamais de prix inventé (même
philosophie que `offerClarifier.js`).

**§2 Bus d'événements unifié** — implémenté via `ai-engine/platformOrchestrator.js#bus`
(Node `EventEmitter`), actuellement un seul événement (`campaign:network_status`)
mais le patron est posé pour de futurs émetteurs (média/PDF/ventes) sans
coupler les modules entre eux.

**Non fait sur ce sous-chantier** : réplication local-client/mobile (mêmes
raisons que le chantier ci-dessous — leurs moteurs de campagne locaux
n'ont pas encore `onNetworkStatusChange`) ; le "Gestionnaire de Sécurité &
Queues" du schéma reste, pour l'instant, `lib/circuitBreaker.js` +
`assistedMode` (pas un module séparé — inutile de dupliquer ce qui
fonctionne déjà).

---

## 🤖 Chantier "Chat-Driven Agent Orchestrator" (suivi vivant, session du 2026-09-14 soir, en parallèle du chantier parité ci-dessous)

> Rafraîchi périodiquement pendant l'implémentation (toutes les ~10 min, sur
> demande explicite de l'utilisateur) pour qu'une session future puisse
> reprendre sans tout relire. Décisions actées avec l'utilisateur : réponse
> `generate_payment_link` = instructions Mobile Money simples (pas
> d'agrégateur de paiement, voir `.env.example`) ; réplication demandée sur
> les 3 cibles (VPS/local-client/mobile) EN UNE SEULE PASSE, sans tests
> intermédiaires (risque assumé par l'utilisateur).

**Découverte clé avant d'écrire le moindre code** : ce dépôt a DÉJÀ une
couche "Chat-to-Action" complète et branchée en production côté VPS —
`lib/intelligence/{task-parser,automation-engine,action-executor,goal-chat,
vps-bridge}.js`, montée dans `index.js` (`app.use('/', requireAccess,
createVpsBridge({runtime: createVpsRuntime({...}), ...}))`, ligne ~4732) et
exposée via `/api/intelligence/{chat,goal-chat,execute,objective,actions}`.
Le registre `action-executor.js` a déjà 12 actions (SEND_CAMPAGNE,
FOLLOW_UP, CREATE_USER_ACCOUNT, GENERATE_ACCESS_KEY, GENERATE_REPORT...).
**Ce système n'est PAS branché sur la vraie fenêtre de tchat du dashboard**
(le "Copywriter Studio IA", `/api/ai-studio/sessions/:id/messages`, qui lui
utilise directement `llmFallbackEngine` + des planners dédiés
image/vidéo/livre) — les deux couches existent en parallèle sans se parler.
Décision d'architecture : NE PAS dupliquer task-parser/action-executor/
goal-chat, les ÉTENDRE (nouvelles actions manquantes) et les BRANCHER sur le
Copywriter Studio IA via `ai-engine/chatOrchestrator.js` (nouveau, fin
glue/routing) — c'est ce fichier qui devient le point d'entrée unique demandé
par le cahier des charges.

### Fait
- `lib/ai/llmFallbackEngine.js` : ajout du fournisseur DeepSeek dans la
  cascade (Groq → Gemini → DeepSeek → OpenRouter → Hugging Face →
  Pollinations). `.env.example` mis à jour (`DEEPSEEK_API_KEY`,
  `DEEPSEEK_MODEL`) — satisfait le point "rotation Gemini/Groq/DeepSeek" du
  cahier des charges (la rotation/repli existait déjà pour Groq/Gemini,
  seul DeepSeek manquait comme fournisseur nommé explicitement).
- `ai-engine/storageAdapter.js` (nouveau) : store générique {namespace,docId}
  → JSON, calqué fidèlement sur `lib/aiStudioStore.js` (fichier local +
  miroir GitHub fire-and-forget). Écart assumé et documenté dans le fichier
  vs. la formulation littérale "PostgreSQL/Redis" du cahier des charges :
  ce dépôt n'utilise ni l'un ni l'autre nulle part, introduire une DB pour
  ce seul module serait une infra spéculative non alignée avec le reste du
  projet (voir mémoire globale `preserve-existing-infrastructure`).
- `ai-engine/offerClarifier.js` (nouveau) : `detectNewOfferIntent`,
  `planOffer` (questions structurées produit physique/service/formation,
  même patron que `index.js#planOrAsk`/planImage), `getBusinessProfile`,
  `saveOffer` (persisté via storageAdapter, namespace `business_profiles`).
- `.env.example` : ajout section Mobile Money (`MOBILE_MONEY_ORANGE/MTN/
  MOOV/WAVE`, `MOBILE_MONEY_BENEFICIARY_NAME`) pour `generate_payment_link`.
- `docs/PARITE-LOCAL.md` (ce fichier) : section de suivi créée.

### Fait (suite)
- **Découverte majeure en cours de route** : `local-client/index.js` a DÉJÀ
  son propre "Chat Intelligent" (`POST /api/intelligence/goal-chat`, même
  `lib/intelligence/{task-parser,goal-chat}.js` que le VPS) — copié et
  fonctionnel, MAIS conçu différemment par choix assumé : `run-plan` n'y
  exécute RIEN automatiquement, le client redirige vers l'onglet Campagnes
  (voir commentaire en tête de cette route). `action-executor.js` n'existe
  donc PAS côté local-client (jamais copié — pas nécessaire vu ce choix de
  design). Décision : respecter ce choix déjà fait plutôt que de le
  court-circuiter en répliquant l'auto-exécution VPS telle quelle.
- `lib/intelligence/task-parser.js` : nouveau type d'objectif `PAYMENT`
  (mots-clés lien de paiement/Mobile Money/remise) — pour cohérence
  interne du parser, la vraie exécution de `payment`/`account` dans le
  Copywriter Studio IA passe cela dit par une extraction LLM dédiée (voir
  `chatOrchestrator.js#planPayment/planAccount` ci-dessous), pas par ce
  chemin goal-chat (montant/destinataire = texte libre, pas juste
  cible+canaux).
- `lib/intelligence/action-executor.js` (registre à 18 actions désormais) :
  ajout de SCHEDULE_FOLLOWUP, GENERATE_PAYMENT_LINK, NEGOTIATE_DISCOUNT
  (plafond `MAX_DISCOUNT_PERCENT`, défaut 15%), GRANT_MODULE_ACCESS,
  ANSWER_STUDENT_QUERY, DELIVER_LESSON_CONTENT. Nouvelle dépendance injectée
  `deps.llm` (fonction texte async, jamais un `require` direct vers
  `lib/ai/llmFallbackEngine.js` — casserait le bundle navigateur mobile).
  Testé en isolation (mock env) : GENERATE_PAYMENT_LINK et NEGOTIATE_DISCOUNT
  fonctionnent (voir transcript de session, formats de sortie vérifiés).
- `lib/intelligence/runtimes/vps-runtime.js` : ajout `scheduleFollowUp`
  (délègue à `queues/scheduled_messages.js`, même file que
  `/api/scheduled-messages`) + `llm` transmis à `createActionExecutor`.
- `lib/intelligence/vps-bridge.js` : `createVpsBridge(...)` retourne
  désormais `{ router, engineFor, goalChatSessions, runtime }` (au lieu du
  seul router) — pour que `chatOrchestrator.js` réutilise le MÊME moteur
  d'automatisation par tenant que `/api/intelligence/*`, sans en construire
  un second (aurait fragmenté l'idempotence par runId).
- `firebase-functions/index.js` : `grantAccessOnPurchase` et
  `grantModuleAccess` IMPLÉMENTÉES (collections `cyrus_students`/
  `cyrus_access_keys`, préfixées pour zéro collision avec RIEA AFRIQUE) —
  comblent un vrai trou (la fonction était APPELÉE par
  `action-executor.js#CREATE_USER_ACCOUNT` depuis l'origine mais n'a
  JAMAIS existé côté Cloud Functions, repli local systématique jusqu'ici).
  + DeepSeek ajouté à la cascade IA Firebase (même convention que VPS).
  **NON DÉPLOYÉES** (attend confirmation explicite utilisateur, voir règle
  `preserve-existing-infrastructure` — projet Firebase partagé).
- `ai-engine/chatOrchestrator.js` (nouveau) : point d'entrée unique.
  `detectIntent()` (offer/report/payment/account/goal, zéro réseau) + 5
  handlers. 'goal' délègue à goal-chat et EXÉCUTE AUTOMATIQUEMENT (pas de
  bouton, contrairement à l'UI Goal Chat existante — autonomie demandée par
  le cahier des charges). 'payment'/'account' : extraction LLM ciblée à un
  tour (même patron que `index.js#planOrAsk`) puis exécution directe via
  `runtime.actionExecutor.execute(...)`. Testé en isolation avec des mocks
  (`runtime`/`engineFor`) : le scénario exact du cahier des charges ("Je
  veux vendre 10 formations aujourd'hui" → clarifie canal manquant → plan
  6 étapes → exécution auto → cartes ✅) fonctionne de bout en bout.
- **Branché dans `index.js`** : `POST /api/ai-studio/sessions/:id/messages`
  (Copywriter Studio IA — LE vrai tchat du dashboard) consulte désormais
  `chatOrchestrator.handle(...)` EN PREMIER, avant le pipeline image/vidéo/
  livre/chat existant ; retombe proprement dessus si aucune commande
  détectée (`orchestrated === null`).
- Tous les fichiers touchés passent `node --check` sans erreur.

### Fait (suite 2) — filtrage privé/pro + tuteur pédagogique auto
- `lib/intelligence/message-triage.js` (nouveau, dual-env) : `classify(text)`
  (privé/pro, lexique FR, prudent par défaut — un message ambigu reste
  'personal') + `recordFaqSignal(profile, question)` (onboarding passif
  ÉTROIT : capture les questions clients récurrentes pour une FAQ légère,
  jamais l'invention de produits/prix — ça reste l'autorité exclusive de
  offerClarifier). Testé en isolation : classification correcte sur les cas
  types (salutation/question prix/etc.) ; dédoublonnage FAQ approximatif par
  préfixe, limitation connue et documentée (deux formulations très proches
  d'une même question peuvent rester non fusionnées).
- `adapters/whatsappManager.js` / `adapters/telegramManager.js` :
  `setIncomingMessageHandler(fn)` — un SECOND abonné à `onIncomingMessage`
  (le premier, déjà en place, reste `campaignEngine` pour la pause de
  campagne — les deux coexistent, tableau de listeners, pas un remplacement).
- `index.js` : câblage réel — `handleIncomingCustomerMessage` classe CHAQUE
  message WhatsApp/Telegram entrant (tous tenants), alimente le profil
  business (FAQ) si 'business'. **Décision de sécurité assumée** : aucune
  réponse automatique envoyée à un vrai client par défaut — variable d'env
  `AUTO_ANSWER_STUDENT_QUERIES` (absente/`false` par défaut) doit valoir
  exactement `"true"` pour activer l'envoi réel via ANSWER_STUDENT_QUERY.
  Un agent qui se met à répondre automatiquement à de vrais numéros
  WhatsApp/Telegram sans que l'utilisateur ne l'ait explicitement activé
  serait une action à risque, pas juste une fonctionnalité de plus — cohérent
  avec la prudence déjà démontrée par l'utilisateur sur ce projet (incident
  Firebase du 2026-09-09, règles "ne jamais toucher l'existant sans vérifier").
- Tous les fichiers touchés (13 au total) passent `node --check` sans
  erreur ; `chatOrchestrator`, `action-executor` (nouvelles actions) et
  `message-triage` testés unitairement en isolation (mocks), y compris le
  scénario complet "Je veux vendre 10 formations aujourd'hui" de bout en
  bout (clarifie canal → plan 6 étapes → exécution auto → cartes ✅).

### Bilan de cette session sur ce chantier — VPS = cœur du moteur livré et cohérent
Le cahier des charges initial s'est révélé BEAUCOUP plus large qu'un simple
nouveau fichier (recherche a révélé une couche "Chat-to-Action" déjà
existante mais non branchée, un vrai trou Firebase jamais comblé, un système
de chat admin découplé du reste) — traité en réutilisant/étendant l'existant
plutôt qu'en dupliquant, mais la réplication complète sur 3 cibles EN UNE
SEULE SESSION (demandée explicitement) n'a pas pu être menée à un niveau de
qualité fiable pour local-client/mobile en plus du cœur VPS. Décision :
livrer un moteur VPS complet, cohérent et vérifié plutôt que 3 moteurs
bâclés. Reste explicitement HORS de cette session (voir avec l'utilisateur
pour une suite) :

1. Réplication vers `local-client/` : `offerClarifier.js` adapté (aiGateway
   au lieu de llmFallbackEngine), `task-parser.js`/`goal-chat.js` déjà
   présents à mettre à jour avec le type PAYMENT, un `chatOrchestrator`
   équivalent branché sur une future route de tchat (n'existe pas encore
   côté local-client contrairement au VPS — le "Chat Intelligent" existant
   y redirige vers l'onglet Campagnes au lieu d'exécuter, par choix déjà
   assumé, voir plus haut).
2. Réplication vers `mobile/webapp/www/` (webapp-core) : `action-executor.js`
   existe déjà là-bas (copie) — resynchroniser avec les 6 nouvelles actions ;
   pas de tchat Copywriter Studio IA côté mobile non plus à ce jour (webapp
   client-side, appellerait Firebase directement comme aiGateway.js).
3. Déploiement Firebase (`grantAccessOnPurchase`/`grantModuleAccess`,
   secret `DEEPSEEK_API_KEY`) — code écrit et vérifié syntaxiquement,
   **jamais déployé**, attend confirmation explicite utilisateur (règle
   `preserve-existing-infrastructure`, projet `rien-afrique` partagé).
4. Aucun test réel réseau/production sur ce chantier (uniquement relecture +
   vérification syntaxique + tests unitaires en isolation avec mocks) —
   cohérent avec la pratique déjà établie dans ce dépôt.

---

# 🎯 CYRUS SUPER ASSISTANT — PARITÉ VPS ↔ LOCAL (Suivi vivant)

> Document de travail/maintenance créé le 2026-09-14, session du soir.
> **Pense redémarrable** : une session future peut reprendre le travail ici
> sans tout relire. S'actualise au fur et à mesure.

## Contexte (rappel rapide)

Décision produit ferme (voir aussi mémoire globale Claude Code,
`cyrus-local-matches-vps-design.md` et `cyrus-single-vercel-webapp-architecture.md`) :
- Vercel = **Mode VPS uniquement** (`public/dashboard.html`, jamais retouché
  visuellement — c'est la référence de design ET de fonctionnalités).
- Le Mode Local/Zero-VPS existe comme **deux packages séparés**, chacun avec
  sa propre UI, tous deux restylés pour ressembler EXACTEMENT à
  `dashboard.html` (palette claire, violet `#6c4fd6`, vert WhatsApp
  `#25D366`, bleu Telegram `#2AABEE`) :
  - `local-client/` — PC, package Node.js/Express packagé en `.exe`
    (`npm run build:exe`, voir `local-client/package.json`).
  - `mobile/webapp/www/` — Android, webapp Capacitor packagée en APK.
- Objectif demandé explicitement par l'utilisateur : **parité fonctionnelle
  à 100%** avec le Mode VPS partout où c'est techniquement portable.

## ✅ Fait cette session (2026-09-14) — vérifié syntaxiquement, jamais testé en conditions réelles

| Fonctionnalité | PC (local-client) | Mobile (mobile/webapp/www) |
|---|---|---|
| Déconnecter avec retour visuel (bug initial) | ✅ | — |
| Studio IA (texte/image) | ✅ (nouvel onglet) | déjà présent avant |
| Pont Telegram (extension navigateur) | — | abandonné (voir plus bas, webapp-core/browser-extension dormants) |
| Chat Intelligent + Human Context | ✅ déjà présent | ✅ porté (lib/cyrusStoreShim.js + lib/intelligence/*.js copiés de webapp-core/) |
| Design aligné sur dashboard.html | ✅ | ✅ |
| Pièce jointe campagne WhatsApp+Telegram | ✅ | ✅ (whatsappBridge.js porté depuis les vraies sources whatsapp-web.js ; telegramBridge.js best-effort, jamais éprouvé) |
| Délai strict Telegram DM 30-60s | ✅ (lib/campaigns.js) | ✅ (campaign.js) |
| Rapport final de campagne | ✅ | ✅ |
| Ebook enrichi (couverture/logo/filigrane/chapitres illimités) | ✅ (route locale enrichie) | ✅ (nouvelle Cloud Function, **non déployée**, voir blocage ci-dessous) |
| Raccourcis clavier Relance (Espace/Flèche) | ✅ | non porté (pas de clavier physique sur mobile, décision assumée) |
| Diffusion directe groupe/canal Telegram | ✅ (bug ID négatif tronqué corrigé) | ✅ |
| Batching (lot + pause après lot) | ✅ | ✅ |
| Gestionnaire multi-campagnes (file d'attente par canal) | ✅ | ❌ non porté (architecture mobile à sens unique, chantier à part, voir plus bas) |
| Studio Média Prédictif (intention→direction créative→Canvas→3 propositions→multi-formats→vidéo Ken Burns) | ✅ complet (`local-client/public/media-studio.js`) | ✅ complet (`mobile/webapp/www/media-studio.js`) |

**Exclusions définitives, ne pas retenter sans une demande explicite** :
Facebook et TikTok (client_secret OAuth stocké côté serveur VPS, structurellement
impossible à distribuer dans un client public), capture Prospects (webhook Meta
sur URL HTTPS publique impossible derrière un NAT domestique), vidéo IA
serveur + storyboard multi-scènes + "lien 1-clic partageable" du Studio Média
(nécessitent un hébergement public `/v/:id` avec aperçu Open Graph, qu'aucun
des deux packages locaux ne peut fournir), mixer vidéo perso/habillage
TikTok-Reels (ffmpeg — voir section dédiée plus bas).

## 🔜 Ce qui reste à faire, dans l'ordre

### 1. Compiler l'exe PC — BLOQUÉ ce soir (RAM occupée)
```
cd local-client
npx pkg . --targets node22-win-x64 --output dist/cyrus-local-client.exe
```
**Ne PAS relancer tant que la RAM n'est pas libre** — la tentative du
2026-09-14 a été tuée par manque de mémoire (0,43 Go libre sur 3,89 Go,
plusieurs sessions `claude` + VS Code actives en même temps) et a laissé un
`.exe` corrompu à moitié écrit (déjà nettoyé, `dist/` est vide actuellement).
Avant de relancer : vérifier la RAM libre (`Get-CimInstance Win32_OperatingSystem`
en PowerShell, colonne `FreePhysicalMemory`) et fermer les sessions/fenêtres
inutiles. Une fois compilé, **lancer l'exe une fois pour de vrai** (jamais
fait depuis l'ajout de Telegram/blocklist/connexions/Studio IA/Studio Média)
avant de le distribuer.

### 2. Builder + tester l'APK mobile — nécessite le téléphone en USB
Aucun appareil Android connecté actuellement (`adb devices` vide). Quand le
téléphone est branché :
```
cd mobile/webapp/android
./gradlew assembleDebug
```
Puis installer et tester en **un seul cycle groupé** (contrainte données
mobiles de l'utilisateur, voir mémoire globale) : Chat Intelligent, pièce
jointe WhatsApp/Telegram, diffusion groupe, Studio Média (image ET vidéo —
`MediaRecorder`/`canvas.captureStream()` jamais vérifié sur un vrai
appareil), ebook (nécessite le déploiement Firebase, voir point 3).

### 3. Déployer la nouvelle Cloud Function Firebase — attend confirmation utilisateur
`firebase-functions/index.js` a une nouvelle fonction `generateEbookFallback`
(+ `firebase-functions/lib/pdf/ebookGenerator.js` copié, + `pdfkit` ajouté à
`firebase-functions/package.json`). **Jamais déployée.** Avant de déployer :
relire la règle du projet `rien-afrique` (mémoire globale
`preserve-existing-infrastructure` — projet Firebase PARTAGÉ avec RIEA
AFRIQUE) : déployer UNIQUEMENT cette fonction par son nom, jamais un
`firebase deploy` large.
```
cd firebase-functions
npm install   # pdfkit vient d'être ajouté, jamais installé ici
firebase deploy --only functions:generateEbookFallback
```
Demander confirmation explicite à l'utilisateur avant de lancer ce déploiement.

### 4. YouTube (OAuth Desktop) — attend une action de l'utilisateur
Décision prise : porter YouTube (connexion + publication) en local via
l'OAuth "Application de bureau" de Google (PKCE, pas de secret confidentiel
à protéger, contrairement à Facebook/TikTok). **Bloqué sur l'utilisateur** :
il doit créer lui-même un nouvel identifiant OAuth dans Google Cloud Console
(voir instructions détaillées déjà données dans la conversation — projet
`rien-afrique`, API et services → Identifiants → Créer des identifiants → ID
client OAuth → type "Application de bureau") et fournir le Client ID +
Client Secret (ou les mettre directement dans `local-client/.env` sous
`YOUTUBE_DESKTOP_CLIENT_ID`/`YOUTUBE_DESKTOP_CLIENT_SECRET`). Une fois reçus :
implémenter le flux loopback (ouvrir le navigateur système vers l'URL de
consentement Google, écouter `http://127.0.0.1:<port_libre>` le temps de
récupérer `?code=...`, échanger via `googleapis`) dans un nouveau
`local-client/lib/youtube.js`, inspiré de `adapters/media_publisher.js`
(racine du dépôt) pour la partie upload (`youtube.upload` scope, déjà connu).
Pas prévu côté mobile pour l'instant (pas demandé explicitement).

### 5. Multi-campagnes sur mobile — chantier à part, pas commencé
`mobile/webapp/www/campaign.js` ne modélise qu'UNE campagne active à la fois
par canal (pas de liste de campagnes distinctes en base IndexedDB). Porter
la file d'attente comme côté PC (`lib/campaigns.js#advanceQueue`) demande de
revoir ce modèle de données en profondeur — risqué sans pouvoir tester sur
appareil réel. À évaluer avec l'utilisateur avant de s'engager dessus.

## Rappel permanent (RAM de cette machine)

Ce PC de développement n'a que ~3,9 Go de RAM. Les builds lourds (`pkg` pour
l'exe, Gradle pour l'APK) échouent silencieusement ou laissent des fichiers
corrompus si plusieurs sessions Claude Code / fenêtres VS Code tournent en
parallèle. Toujours vérifier la RAM libre avant de lancer une compilation,
et ne jamais lancer deux builds lourds (exe + APK) en même temps.
