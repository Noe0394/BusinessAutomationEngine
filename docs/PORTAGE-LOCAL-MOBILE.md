# Portage des mises à jour VPS vers PC (`local-client/`) et téléphone (`mobile/webapp/`)

**Consigne utilisateur (2026-09-20)** : toutes les mises à jour faites sur le VPS doivent être appliquées
INTÉGRALEMENT, plus tard, aux branches locales PC et téléphone. Ce fichier est la liste de référence :
toute nouvelle livraison VPS y ajoute une ligne. Le portage n'est PAS commencé (différé à la demande de l'utilisateur).

Statuts : `À FAIRE` = non commencé, `PARTIEL` = commencé, `FAIT` = livré et vérifié.
Le PC et le téléphone gardent leur mode « zéro serveur » : le portage adapte, il ne branche pas ces apps sur le VPS.

| # | Mise à jour VPS (branche `feat/jarvis-engine`, fusionnée dans `main`) | Fichiers VPS principaux | PC | Téléphone |
|---|---|---|---|---|
| 1 | Moteur conversationnel Jarvis (refus respecté, anti-répétition, NO_ACTION, file/debounce, agent multi-outils, exécution directe des ordres sans contradiction) | `ai-engine/jarvis/*`, `chatOrchestrator.js`, `toolRegistry.js` | À FAIRE | À FAIRE |
| 2 | Mémoire 7×24 h par jour (segments par jour, verrous, historique WhatsApp à l'appairage, messages sortants, outil `queryMemory`) | `ai-engine/messageHistory.js`, `memoryQuery.js`, adapters Baileys | À FAIRE | À FAIRE |
| 3 | Répondeur permanent (compte « toujours actif », gardien de sessions, réglages `/api/auto-responder`) | `ai-engine/alwaysOn.js`, `responderKeeper.js`, `autoResponder.js` | À FAIRE | À FAIRE |
| 4 | Import de numéros : coller une liste, Excel/CSV, photo OCR, normalisation, doublons, validation, compteurs et tableau des statuts, intégrés aux onglets WhatsApp et Telegram | `ai-engine/contactsPipeline.js`, `ocrProvider.js`, `public/dashboard.html` (`impBuild`) | À FAIRE | À FAIRE |
| 5 | Campagnes suivies dans les onglets WhatsApp/Telegram : statuts, programmation, pause/reprise/annulation, rapport CSV, protection + reprise automatique + continuité manuelle | `ai-engine/campaignService.js`, `lib/campaignStatus.js`, `queues/*`, `public/dashboard.html` (`cmpMount`) | À FAIRE | À FAIRE |
| 6 | File de tâches + worker (lancement programmé) | `ai-engine/taskQueue*` | À FAIRE | À FAIRE |
| 7 | Licences et IA sur Cloudflare (Worker + D1) à la place de Firebase : clients déjà basculés côté `local-client/lib` et mobile pour l'URL, à revérifier | `cloudflare/license-worker/`, `lib/cloudflareSync.js` | PARTIEL | PARTIEL |
| 8 | Clé créée dans le générateur Cloudflare reconnue tout de suite par le VPS (synchronisation immédiate) | `licenses.js` | À FAIRE (vérifier `local-client/lib/license.js`) | À FAIRE |
| 9 | CORS : origine identique au Host acceptée (domaine DuckDNS) | `index.js` | Sans objet (pas de CORS local) | Sans objet |
| 10 | Couche d'assistance générale : identité des contacts (JID/LID ≠ numéro), routage privé/métier, centre d'alertes, canal propriétaire (self-chat → Chat Intelligent), actions en attente `PA-XXXX` + OUI/NON, vérification API, import de listes appliqué à la source d'envoi | `ai-engine/{contactIdentity,alertCenter,conversationRouter,ownerChannel,pendingActions,assistantLayer,manualPaymentValidator}.js`, `adapters/whatsappEngineBaileys.js` (indices d'identité, self-chat), `lib/whatsappRecipients.js` (déjà copié dans `local-client/lib`), `public/dashboard.html` (`impBuild`) | PARTIEL (`whatsappRecipients.js` seulement) | À FAIRE |

## Règles de portage à respecter
- Reprendre le comportement, pas le code VPS tel quel : le PC et le téléphone restent locaux (WhatsApp local, SQLite/IndexedDB).
- Copier à la main les fichiers purs partagés (`local-client/lib/` contient des copies, voir CLAUDE.md) et les resynchroniser.
- Compte de test unique pour tout test réel : celui de la clé de test (`.env`, `CYRUS_TEST_LICENSE_KEY`), jamais de compte admin.
- Données mobiles limitées : grouper les builds/installations APK en un seul cycle.
- Le design de référence reste celui du dashboard VPS.
