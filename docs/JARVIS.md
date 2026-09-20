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
