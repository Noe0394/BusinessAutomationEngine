# Autonomie locale Cyrus Super Assistant

État de l’audit et des adaptations du 23 septembre 2026.

## Architecture observée

- **PC** : WhatsApp et Telegram utilisent leurs sessions locales ; contacts,
  messages et campagnes sont conservés dans SQLite sous `%APPDATA%/CyrusLocalClient`.
- **Mobile** : les connexions et l’interface tournent dans la WebView ; les
  données applicatives sont dans IndexedDB, avec identifiant et clé dans
  `localStorage`.
- **IA** : le routage local appelle les fournisseurs configurés directement
  depuis le PC. La passerelle Cloudflare demeure disponible pour le mobile et
  les médias. Ces usages demandent Internet et, selon le fournisseur, des clés
  ou quotas ; « sans VPS » ne signifie donc pas « sans réseau ».
- **Licences** : avant cette adaptation, le PC et le mobile exigeaient une
  vérification réseau à chaque lancement. Le Worker Cloudflare + D1 est le
  registre en ligne et la source de révocation.
- **Webhooks** : le webhook Facebook existant est dans le serveur racine. Le
  client PC/mobile n’expose pas de callback public ; les connexions WhatsApp et
  Telegram locales fonctionnent sans webhook entrant hébergé par Cyrus.

## Changements effectués

- PC et mobile vérifient désormais hors-ligne un jeton Ed25519 lié à la clé,
  à l’appareil, aux modules autorisés et aux dates d’expiration.
- Le Worker signe une preuve valable 14 jours hors-ligne si le secret
  `LICENSE_SIGNING_PRIVATE_KEY` est configuré. Une vérification réseau positive
  renouvelle le cache ; un refus explicite efface la preuve et invalide la
  session. Une panne réseau seule laisse fonctionner le cache jusqu’à sa date
  de grâce.
- Le jeton PC est conservé dans `%APPDATA%/CyrusLocalClient/license-token.json` ;
  sur mobile, il est conservé à côté de la licence dans `localStorage`.
- La clé publique de vérification est embarquée dans les deux clients. La clé
  privée n’est pas dans le dépôt ; elle doit rester un secret du Worker.

## Prérequis restant avant activation en production

Le code Worker local n’a pas encore été déployé. `wrangler.toml` contient
toujours le texte fictif `REMPLACER_PAR_L_ID_RETOURNE_PAR_wrangler_d1_create`
comme identifiant D1 et la commande `wrangler` n’est pas disponible dans cet
environnement. Il faut retrouver l’identifiant D1 exact du Worker déjà en
production, configurer `LICENSE_SIGNING_PRIVATE_KEY` comme secret Wrangler,
puis publier le Worker mis à jour. Tant que ces étapes ne sont pas terminées,
les vérifications en ligne existantes continuent, mais aucun jeton neuf n’est
émis et le mode hors-ligne n’est pas amorcé pour les nouvelles installations.
La paire dédiée a été générée ; sa clé privée est temporairement stockée dans
`%TEMP%/cyrus-license-signing-private.b64` pour éviter de l’imprimer ou de la
versionner. Après son transfert dans le secret Wrangler, ce fichier temporaire
devra être supprimé.

Le webhook Meta reste attaché au backend public existant. Pour le déplacer vers
un PC, il faudra exposer un callback avec un tunnel Cloudflare et une URL stable
acceptée par Meta, ou garder un consommateur public qui pousse les événements
vers le poste. Le mode polling convient aux API qui le proposent, mais ne
remplace pas le webhook Meta.

## Vérifications locales

- `node --test test/offline-license.test.js test/cloudflare-license.test.js` — 14/14.
- `node --check` sur les modules PC, Worker et mobile modifiés.
- `npm run build` (dashboard racine).
- `node --test --test-concurrency=1` — 580/580.
- `npm test` en concurrence a produit deux échecs temporaires dans les tests
  Chrome sous charge (`localStorage` indisponible après navigation) ; les deux
  tests passent seuls et la suite complète passe en série.
