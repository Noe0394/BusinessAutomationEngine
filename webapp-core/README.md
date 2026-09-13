# webapp-core — cœur applicatif unique (Zero-VPS)

Source de vérité UNIQUE pour l'UI et la logique métier partagées entre
`mobile/webapp/` (Capacitor/Android) et `local-client/` (PC). Remplace les
deux copies séparées et divergentes qui existaient avant cette
restructuration (2026-09-10) — un bug corrigé ici est corrigé sur les deux
plateformes en une seule fois.

## Ce qui est PARTAGÉ (ce dossier)

- `index.html` + `style.css` — une seule interface responsive (thème
  sombre/cyan), pas deux HTML différents. S'adapte à la largeur d'écran
  (téléphone en colonne, PC avec plus d'espace) via CSS uniquement.
- `app-core.js`, `campaigns-core.js`, `relance-core.js`, `connexions-core.js`
  — toute la logique métier (campagnes, Spintax/personnalisation, Relance
  Manuelle Express, liste noire, connexions/historique). Appelle
  exclusivement `window.CyrusEngine` et `window.CyrusStore` — JAMAIS
  directement `fetch()`, `EmbeddedWebView`, IndexedDB ou SQLite. C'est cette
  règle qui rend le code portable entre les deux plateformes.
- `lib/` — utilitaires purs sans dépendance plateforme (spintax,
  personalization, smartTextGenerator, contactsImport, xlsx vendoré).

## Ce qui est SPÉCIFIQUE à chaque plateforme (`adapters/`)

Deux implémentations du même contrat (`adapters/CONTRACT.md`) :
- `adapters/mobile.js` — pont vers le WebView natif Capacitor
  (`whatsappBridge.js`/`telegramBridge.js`, déjà validés) + IndexedDB.
- `adapters/desktop.js` — appels HTTP vers le serveur `local-client/`
  (whatsapp-web.js/GramJS déjà en place) + son SQLite.

Le connexion/appairage reste la seule zone visuellement différente entre les
deux plateformes (QR/WebView sur mobile, formulaire numéro→code sur PC) — géré
via `CyrusEngine.mountConnectUI(channel, container)`, le seul point du
contrat qui laisse chaque adaptateur injecter son propre DOM.

## Non repris dans cette fusion (simplification assumée)

Le fil de discussion 1-à-1 ad-hoc qui existait dans les premières versions de
`mobile/webapp/` (écran de chat WhatsApp/Telegram) n'est pas repris ici :
`public/dashboard.html` (l'interface de référence à dupliquer fidèlement) n'a
lui-même jamais eu cette fonctionnalité — son onglet WhatsApp/Telegram porte
sur les groupes et les campagnes, pas sur une messagerie en temps réel. La
capacité d'envoi/réception reste dans chaque moteur ; c'est uniquement cet
écran de démonstration qui disparaît.

## Firestore (phase suivante, pas encore fait)

`CyrusStore` reste pour l'instant adossé au stockage local de chaque
plateforme (IndexedDB mobile, SQLite desktop) — conformément à la décision de
stabiliser le cœur applicatif sur PC d'abord. La migration vers Firestore
(contacts/campagnes/liste noire/historique/licences partagés entre
appareils) remplacera l'intérieur de `CyrusStore` sans toucher à
`app-core.js`/`campaigns-core.js`/etc., précisément parce que ces fichiers ne
connaissent que l'interface `CyrusStore`, jamais son implémentation.

## Comment ça arrive sur chaque plateforme

`sync.js` (à la racine de ce dossier) copie ce cœur + l'adaptateur concerné
dans `mobile/webapp/www/` et `local-client/public/` — chacun garde son
`webDir`/dossier statique habituel, mais son contenu est désormais généré,
plus jamais édité à la main directement dans ces deux dossiers.
