# Feuille de route CYRUS — état au 2026-09-20 (fin de session)

Document de reprise pour les prochaines implémentations. **Aucun secret ici** (dépôt GitHub PUBLIC) : les noms et emplacements des secrets sont dans `.env.SECRETS-INDEX.md` (ignoré par Git).

## 1. Déployé sur la VM (branche `feat/jarvis-engine`, commit `2fef2a3`, déploiement n°8, `/health` ok)

### Couche d'assistance générale
- Résolution d'identité de contact (JID/LID jamais affiché comme numéro), classification privé/business, centre d'alertes (INFO→CRITICAL, agrégation, `triggerAdminNotification`), auto-discussion propriétaire WhatsApp → Chat Intelligent existant, anti-boucle, idempotence.
- Paiements : `pendingActionId` (PA-XXXX), OUI/NON strict, vérification API RIEA (exécuter → vérifier), état de passage à l'humain.
- Règles de prompt : `isSavedContact`/`contactName`, `user_refused_action`, promesse « je transmets au vendeur » → alerte propriétaire.

### Campagnes
- Facebook Ads (Service métier `adCampaigns`, message initial exact, referral réel, jamais d'origine inventée).
- Groupes WhatsApp administrés (ciblage par mot-clé avec vérification admin PN+LID, planification, détection d'intérêt, preuves de paiement, rapports).

### Import de contacts (problème répété >10 fois, résolu à la racine)
- Extracteur unique `ai-engine/contactExtractor.js` (Excel toutes feuilles, CSV/TSV/TXT/VCF/JSON, collage, image OCR) branché sur toutes les routes ; liste d'envoi par défaut WhatsApp ET Telegram ; import direct sans second clic.
- Causes réelles corrigées : scripts du dashboard obfusqués séparément (fusion en un seul bloc + tests garde-fous), numéros sans `+`, 4 parseurs Excel codés en dur, fusion au lieu de remplacement, pagination serveur (200), détection d'en-têtes.
- Tests réels en Chrome headless : `test/e2e-import-browser.test.js` (2 tests).

### Conversations gérées par l'IA
- Contexte de paiement/accès du service injecté dans le prompt, troncature Groq gpt-oss corrigée (tokens de raisonnement inclus dans `max_tokens`), plafond `loopGuard` 6→30, réponses privées composées par l'IA (gardes : pas de chiffres/liens/@, pas d'affirmation sur l'activité du propriétaire).

### Orchestrateur (`goal-chat-route`, cœur du système)
- `test/goal-chat-route.test.js` réécrit hors ligne (31/31), `test/orchestrator-intents.test.js` (60 formulations).
- Intentions ajoutées : `ownerqueue`, `adcampaign`, `groupcampaign` ; corrections de regex (`\b` cassé après lettre accentuée).
- Arbitrage d'intention par IA : n'était **jamais** exécuté en production (`d.llm` absent) → branché (`arbitrationLlm`, niveau raisonnement).
- Niveaux IA (`lib/ai/llmFallbackEngine.js`) : `standard` (cascade économique) et `reasoning` (Claude/OpenAI si clés, sinon Groq high → Gemini Pro → …). `getProviderStatus()` exposé dans `POST /api/admin/diag/assistant-check`. Tests : `test/ai-tiers.test.js` (8).

### Tests
- 367/369 sur la suite complète ; les 2 échecs = e2e Chrome qui dépassent le délai en parallèle (PC à faible RAM) ; ils passent seuls.

## 2. À faire demain (par priorité)

1. **Test réel de l'orchestrateur** sur le compte de la clé de test uniquement (cf. `docs/TESTS-REELS.md`) : auto-discussion propriétaire, ordres du Chat Intelligent (campagne, pause/reprise, réponse à un contact, rapport), un vrai paiement avec e-mail jetable.
2. **Renforcer l'orchestrateur** (« à 1 000 000 % ») : étendre la matrice d'intentions avec des phrases réelles issues des logs de la VM ; robustesse de la boucle d'agent (échecs d'outil, reprise, doubles confirmations) ; tests de non-régression pour chaque bug réel rencontré.
3. **IA plus forte** : ajouter `ANTHROPIC_API_KEY` et/ou `OPENAI_API_KEY` dans le `.env` de la VM (rebuild obligatoire car le `.env` est copié dans l'image). Sans elles, le niveau raisonnement = Groq puis Gemini Pro.
4. **Test réel campagne de groupes** : nécessite un feu vert explicite avant tout envoi dans de vrais groupes.
5. **Mot de passe admin VM** : `ADMIN_PASSWORD` non fourni → diagnostics admin non exécutables.
6. **Portage PC + mobile** de tout ce qui précède : `docs/PORTAGE-LOCAL-MOBILE.md` (lignes 10–12 + ajouter niveaux IA/orchestrateur). Non commencé.
7. **Fiabiliser les 2 tests e2e** (délais plus larges ou exécution séquentielle) pour une suite 100 % verte.
8. Chantier licences Cloudflare (générateur) : volontairement le DERNIER.

## 3. Règles permanentes à respecter
- Répondre en français ; données mobiles limitées → grouper les cycles build/déploiement/test réseau.
- Compte de test unique = clé de licence de test (`.env` : `CYRUS_TEST_LICENSE_KEY`) ; pas de compte admin.
- Firebase `rien-afrique` / RIEA : zone interdite (jamais de règles, jamais de déploiement large ; RIEA uniquement via l'API HTTP `X-API-Key`).
- Jamais de secret dans un fichier commité (dépôt public).
- Déploiement VM = manuel : `git pull origin feat/jarvis-engine` (utilisateur `cyrus2026`) puis `sudo systemd-run --unit=cyrus-deployN /tmp/run-deploy.sh` ; vérifier `docker ps`, `/health`, présence du code. Prochain nom d'unité : `cyrus-deploy9`.
- Pièges d'édition : ne jamais mettre de code avec antislashs dans un heredoc Bash (utiliser Write/Edit) ; normaliser CRLF dans les scripts de patch.
- Toute livraison VPS ajoute une ligne à `docs/PORTAGE-LOCAL-MOBILE.md`.
