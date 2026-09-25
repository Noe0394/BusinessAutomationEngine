# Tests réels Jarvis (ÉTAPES 9 et 10)

## Compte de test — RÈGLE PROJET
**Compte unique pour tout test d'intégration sur Render : `KEY-B4403774-2026`.** Configurer
`.env` (`CYRUS_TEST_LICENSE_KEY`) avec cette valeur avant les essais live. Ne jamais utiliser
une autre licence ni créer une autre licence pour ces tests. Les tests unitaires restent isolés,
avec des moteurs simulés, et ne doivent pas appeler le compte Render.

## Prérequis (une seule fois, données mobiles : regrouper)
1. Vérifier que le commit testé est déployé sur Render (`https://business-automation-engine.onrender.com/health`) et utiliser exclusivement la licence `KEY-B4403774-2026`.
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
Restent à exécuter en conditions réelles (WhatsApp/Telegram, Render) : scénarios 1 à 12 ci-dessus.

## ⚠️ Piège appris le 2026-09-20 : ne JAMAIS tester la vérification d'une clé avec un faux appareil
`/api/auth/verify-key` (VPS) et `/verify` (Cloudflare) **lient la clé au premier appareil qui se présente** si elle n'est pas encore
liée. Un test avec `deviceId` bidon lie la clé de test à cet appareil, et la liaison se réplique (VPS -> Cloudflare -> GitHub).
Pour tester un refus, utiliser une clé temporaire créée pour l'occasion (puis la supprimer), jamais la clé de test réelle.
Restauration si cela arrive : `licenses.unbindDevice(clé)` puis `licenses.verifyKey(clé, <vrai id d'appareil>)` sur le VPS,
`POST /admin/unbind` + `POST /admin/sync` sur Cloudflare, et corriger la copie GitHub de `licenses.json`.

## Passage réel — couche d'assistance générale (à exécuter EN UNE FOIS après déploiement)
Prérequis : branche déployée sur Render, répondeur WhatsApp activé sur le compte de test, un second téléphone
(« contact »), le téléphone du compte de test pour son self-chat. Ne rien pousser vers RIEA/Firebase.

| # | Action | Attendu |
|---|---|---|
| 1 | Contact : « Salut, tu vas bien ? » | réponse naturelle, AUCUNE notification |
| 2 | Contact : « Est-ce que ta maman est à la maison ? » | réponse d'attente sans invention ; self-chat : « 🔔 <nom> vient de t'écrire… » |
| 3 | Contact : 5 messages en 10 s | 1 notification puis 1 récapitulatif, pas 5 |
| 4/5/6 | Contact enregistré / numéro seul / contact sans nom | nom / « +226 … » / « Contact WhatsApp non identifié » — jamais de longue série de chiffres |
| 7 | Self-chat : « Bonjour » | réponse dans le self-chat (signature invisible) |
| 8 | Self-chat : « Qui m'a écrit aujourd'hui ? » | liste réelle |
| 9 | Self-chat : « Donne-moi les conversations qui nécessitent mon intervention » | états réels |
| 10 | Contact : « Voici mon reçu 5000 FCFA email: <email de test> » puis self-chat « OUI » | PA-XXXX notifié ; appel API ; client notifié SEULEMENT si l'API confirme. ⚠️ crée un vrai accès RIEA : utiliser un email jetable |
| 11 | Idem puis « NON » | aucune activation, client invité à renvoyer une preuve ; nouvelle preuve = nouveau PA |
| 12 | Onglet WhatsApp/Telegram : coller une liste, Excel, photo | tableau + compteur « ajoutés à la liste d'envoi » ; cible « Liste importée » cochée ; envoi utilise la liste |
Diagnostic : `docker exec cyrus-super-assistant-backend node scripts/jarvis-inspect.js <tenant>`.
