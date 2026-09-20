# Tests réels Jarvis (ÉTAPES 9 et 10)

## Compte de test — RÈGLE PROJET
**Tous les tests réels (WhatsApp, Telegram, IA, licences) se font avec le compte rattaché à la clé de
licence de test** (indiqué par l'utilisateur le 2026-09-20 ; clé dans `.env`, variable `CYRUS_TEST_LICENSE_KEY` — le dépôt est public, ne jamais la commiter). Ne pas tester sur un autre compte,
ne pas générer de clé de test supplémentaire pour cet usage.

## Prérequis (une seule fois, données mobiles : regrouper)
1. Déployer la branche `feat/jarvis-engine` sur la VM (procédure de `CLAUDE.md`), variables `.env` : `AUTO_REPLY_DEBOUNCE_MS`, `JARVIS_CONFIRM_FROM`.
2. Activer l'auto-réponse du compte de test (WhatsApp et/ou Telegram) dans les réglages, avec un Service Métier ayant **un prix configuré et aucune date de session**.
3. Un second téléphone (ou deux) pour jouer les clients.

## Scénarios (un seul passage groupé) — attendu / comment vérifier
| # | Message du « client » | Attendu | Vérification |
|---|---|---|---|
| 1 | « Bonjour, combien coûte la formation ? » | prix configuré, sans invention | réponse reçue ; `jarvis-inspect` : état INFORMATION |
| 2 | « Non merci, pas intéressé » | 1 message de clôture courtois, aucun prix/relance | état REFUSED, opt-out |
| 3 | « J'ai dit non » puis « Merci » | AUCUNE réponse | aucun message reçu (`no_action` dans l'activité) |
| 4 | « C'est trop cher pour moi » (autre contact) | objection traitée sans répéter le prix | réponse ≠ pitch |
| 5 | « Je vais réfléchir » | acquiescement, pas de relance | état WAITING |
| 6 | « Je veux m'inscrire mais demain » | « je vous attends demain », pas de question d'inscription | attente=demain |
| 7 | 3 messages rapides (« Bonjour » / « Je voudrais » / « le prix ») | UNE seule réponse | 1 message reçu |
| 8 | « Quelle est la date de la prochaine session ? » | « je n'ai pas cette information… » | aucune date inventée |
| 9 | Même question 3 fois | pas de répétition mot pour mot, proposition de contact humain | messages différents |
| 10 | 2 clients écrivent en même temps | chacun reçoit SA réponse | pas de mélange |
| 11 | Chat admin : « compte mes contacts puis écris à <n°> … » | aperçu → « oui » → envoi vérifié avec identifiant réel | réf. dans la réponse |
| 12 | Couper le réseau IA (clé invalide) | repli cascade, message honnête, jamais de faux succès | logs |

Après les scénarios : `node scripts/jarvis-inspect.js <tenant>` (dans le conteneur : `docker exec cyrus-super-assistant-backend node scripts/jarvis-inspect.js <tenant>`).

## Résultats
À remplir après exécution (statut réel de chaque ligne, jamais « simulé »).

### Passage du 2026-09-20 — vrai modèle IA, transport SIMULÉ (`node scripts/jarvis-live-scenarios.js`)
13/13 conformes après correction d'un défaut réel (un message d'erreur « crédits insuffisants » de Pollinations
était envoyé comme réponse client ; désormais rejeté, repli sur un message d'attente honnête).
Restent à exécuter en conditions réelles (WhatsApp/Telegram, VM) : scénarios 1 à 12 ci-dessus.

## ⚠️ Piège appris le 2026-09-20 : ne JAMAIS tester la vérification d'une clé avec un faux appareil
`/api/auth/verify-key` (VPS) et `/verify` (Cloudflare) **lient la clé au premier appareil qui se présente** si elle n'est pas encore
liée. Un test avec `deviceId` bidon lie la clé de test à cet appareil, et la liaison se réplique (VPS -> Cloudflare -> GitHub).
Pour tester un refus, utiliser une clé temporaire créée pour l'occasion (puis la supprimer), jamais la clé de test réelle.
Restauration si cela arrive : `licenses.unbindDevice(clé)` puis `licenses.verifyKey(clé, <vrai id d'appareil>)` sur le VPS,
`POST /admin/unbind` + `POST /admin/sync` sur Cloudflare, et corriger la copie GitHub de `licenses.json`.
