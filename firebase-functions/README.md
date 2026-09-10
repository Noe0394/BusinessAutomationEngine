# Cloud Functions de licence/IA (base partagée VPS ↔ Firebase)

Ce dossier est un projet Firebase **indépendant** — pas construit, pas
exécuté, pas déployé automatiquement par le VPS ni par `local-client/`.

## ⚠️ Ce projet Firebase (`rien-afrique`) est PARTAGÉ avec une autre application

`rien-afrique` héberge déjà une vraie application en production, **RIEA
AFRIQUE** (comptes utilisateurs, marketplace, communauté, certifications,
parrainage...), avec ses propres Cloud Functions
(`sendBroadcastPush`, `publishDailyContent`, `sendScheduledMessages`,
`subscribeToDailyContent`) et son propre ruleset Firestore, gérés ailleurs
(pas dans ce dépôt). Deux règles absolues pour tout travail dans ce
dossier :

1. **Ne jamais déployer sans `--only functions:<nom précis>`.** Un
   `firebase deploy --only functions` (sans noms) tente de RÉCONCILIER
   toutes les fonctions du projet avec le code local — cette absence de
   filtre a déjà déclenché une alerte de suppression sur les 4 fonctions
   RIEA AFRIQUE lors du premier déploiement (heureusement bloquée par le
   CLI en mode non-interactif, rien n'a été supprimé).
2. **Ne jamais déployer `firestore.rules` depuis ce dossier.** Fait le
   2026-09-09 par erreur : un fichier `firestore.rules` ne contenant que la
   règle pour `licenses/{key}` a **remplacé tout le ruleset de production
   RIEA AFRIQUE pendant ~42 minutes** (17:05-17:47), bloquant tout accès
   client direct à Firestore pour cette application. Restauré depuis (voir
   `firestore.rules` dans ce dossier — conservé pour mémoire, plus jamais
   référencé par `firebase.json`). Ce n'est de toute façon pas nécessaire :
   les fonctions ci-dessous utilisent l'Admin SDK, qui contourne
   entièrement les règles Firestore — aucune règle cliente n'est requise
   pour protéger `licenses/`.

## Ce que ce dossier fait

Firestore (collection `licenses`) est une base de licences **partagée** en
temps réel avec le VPS (voir `../lib/firebaseSync.js` côté VPS et
`licenses.js#watchLicenses`) — pas une simple copie de secours : une
licence peut être créée ou un appareil activé **depuis n'importe quel
côté**, l'autre s'aligne automatiquement, y compris si le VPS a disparu
durablement (impayé, résiliation — voir décision du 2026-09-09).

- `verifyLicenseOffline` (`POST`, public) — vérifie une clé + un appareil.
  Peut lier un **nouvel** appareil si la clé n'est pas encore appairée
  (compromis de sécurité assumé sur demande explicite : voir commentaire
  dans `index.js`).
- `createLicenseOffline` (`POST`, protégée par l'en-tête `x-admin-secret`,
  secret `ADMIN_SECRET`) — équivalent du portail admin du VPS, pour créer
  une licence même si le VPS est mort.
- `generateTextFallback` / `generateImageFallback` (`POST`, protégées par
  `x-license-key`/`x-device-id`) — génération IA (Groq / fal.ai), un seul
  fournisseur par type (pas la cascade complète de
  `lib/ai/llmFallbackEngine.js` côté VPS).

Depuis le 2026-09-09, `local-client/` appelle CES fonctions **en
priorité**, le VPS servant de repli (voir `local-client/lib/license.js` et
`lib/aiGateway.js`) — inversion du modèle initial où le VPS était
prioritaire.

## Mise en place (déjà faite pour `rien-afrique`, à refaire pour un autre projet)

1. Projet Firebase existant + Firestore (mode natif) + plan Blaze (requis
   pour les secrets/appels sortants HTTP).
2. `firebase login` puis, depuis ce dossier, `firebase use --add`.
3. Compte de service (Paramètres du projet → Comptes de service → Générer
   une nouvelle clé privée) — chemin renseigné dans `FIREBASE_SERVICE_
   ACCOUNT_PATH` (`.env` du VPS), JAMAIS dans ce dépôt Git.
4. `firebase functions:secrets:set GROQ_API_KEY` / `FAL_KEY` /
   `ADMIN_SECRET` (valeurs des deux premières identiques au `.env` du VPS —
   duplication volontaire, voir limite ci-dessous).
5. `npm install` dans ce dossier.
6. `firebase deploy --only functions:verifyLicenseOffline,functions:createLicenseOffline,functions:generateTextFallback,functions:generateImageFallback`
   — JAMAIS sans ces noms explicites, JAMAIS avec `,firestore:rules`.
7. Renseigner les URLs affichées dans `local-client/.env`
   (`FIREBASE_LICENSE_URL`, `FIREBASE_TEXT_URL`, `FIREBASE_IMAGE_URL`) et
   `FIREBASE_ADMIN_SECRET` dans le `.env` du VPS.

## Limite assumée

Les clés fournisseurs IA (Groq/fal.ai) existent à DEUX endroits (`.env` du
VPS + secrets Firebase) : les garder synchronisées en cas de rotation est
une charge opérationnelle manuelle.

## Ce que ce mode dégradé NE fait PAS (volontairement, MVP)

Pas la cascade complète de fournisseurs IA du VPS (un seul fournisseur par
type ici) ; pas de stockage média Firebase Storage pour les images
générées (fal.ai renvoie une URL directe, potentiellement temporaire).
