# Client local CYRUS (package PC installable, on-premise)

Projet **indépendant** du backend racine et de `server/` : son propre
`package.json`, jamais construit ni déployé sur le VPS. Chaque PC client
exécute sa propre instance : session WhatsApp (`whatsapp-web.js`/Puppeteer)
et base SQLite locale (`%APPDATA%\CyrusLocalClient\local.db`, via
`node:sqlite` — aucune compilation native requise).

En fonctionnement normal, ce client n'appelle le VPS central QUE pour deux
choses (jamais pour WhatsApp, jamais pour les données locales) :

- **Vérification de licence** au démarrage (`POST /api/auth/verify-key`,
  route déjà existante côté backend racine).
- **Génération IA** (texte/images), via `POST /api/ai/generate-text` et
  `POST /api/media/generate-image` — le VPS garde seul les clés
  Groq/Gemini/OpenRouter/Hugging Face/fal.ai, jamais présentes ici.

**Failover** : si le VPS est injoignable (panne réseau, pas un simple refus
de licence), et que `FIREBASE_LICENSE_URL`/`FIREBASE_TEXT_URL`/
`FIREBASE_IMAGE_URL` sont configurés, ce client bascule automatiquement sur
les Cloud Functions de secours — voir `../firebase-functions/README.md`
pour la mise en place complète (nécessite un projet Firebase créé par vous,
je ne peux pas le faire à votre place). Sans ces variables, une panne VPS
bloque simplement l'accès (comportement précédent, inchangé).

Aucun secret serveur (mots de passe admin, jetons GitHub, clés IA) n'entre
dans ce dossier — condition pour packager ce projet en `.exe` distribué à
des clients sans risque de fuite.

## Démarrage (développement)

```bash
cd local-client
npm install
cp .env.example .env   # renseignez LICENSE_KEY et VPS_BASE_URL (voir .env.example)
npm start
```

Le terminal affiche le QR code WhatsApp à scanner, et le navigateur par
défaut s'ouvre automatiquement sur `http://localhost:4100` (onglets Statut
/ Contacts / Campagnes).

## État actuel — ce qui marche déjà (testé)

- Connexion WhatsApp locale + QR code (`lib/whatsapp.js`).
- Vérification de licence bloquante au démarrage, avec bascule Firebase sur
  panne réseau VPS (`lib/license.js`, `lib/failover.js`) — logique de
  bascule validée par test (panne simulée), le trajet Firebase réel reste à
  tester une fois un projet Firebase déployé.
- Passerelle IA texte/image vers le VPS avec la même bascule
  (`lib/aiGateway.js`).
- Base SQLite locale : contacts, messages, **campagnes** — création,
  démarrage/pause/annulation, envoi séquentiel avec délai aléatoire,
  reprise automatique si la session WhatsApp se reconnecte
  (`lib/campaigns.js`, `lib/db.js`).
- Vérification de mise à jour au démarrage (`lib/updateCheck.js`,
  `GET /api/check-update` côté VPS) — échoue proprement si la route n'est
  pas encore déployée côté VPS, ne bloque jamais le démarrage.
- Dashboard avec import de contacts (CSV simple) et gestion de campagnes
  (`public/index.html`, `public/app.js`).
- **Packaging `.exe`** : configuration `@yao-pkg/pkg` en place
  (`npm run build:exe`, voir `package.json`) — le build lui-même est
  actuellement bloqué par un manque de RAM sur la machine de développement,
  pas par le code (aucun module natif à gérer : `node:sqlite` a réglé ce
  problème avant même de packager).

## Ce qu'il reste à faire

1. **Provisionner Firebase** (voir `../firebase-functions/README.md`) pour
   activer réellement le failover — actuellement le code est prêt mais
   personne ne peut le tester sans un vrai projet Firebase.
2. **Terminer le build `.exe`** dès que de la RAM est disponible :
   `npm run build:exe`.
3. **Auto-update réel** — `lib/updateCheck.js` ne fait QUE détecter/
   journaliser qu'une mise à jour existe ; télécharger et appliquer
   silencieusement le nouvel exe (remplacement de binaire verrouillé sous
   Windows tant qu'il tourne) reste à écrire.
4. **Interface plus complète** — import CSV réel (fichier, pas juste
   copier-coller), historique des messages par contact dans le dashboard.
