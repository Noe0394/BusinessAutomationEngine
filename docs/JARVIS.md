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
