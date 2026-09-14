# Extension CYRUS — Pont WhatsApp & Telegram Web

Permet à CYRUS SUPER ASSISTANT d'envoyer réellement des messages WhatsApp et
Telegram **sans aucun clic manuel** — contournement impossible autrement
depuis un simple onglet navigateur (same-origin policy : une page web ne
peut pas scripter `web.whatsapp.com`/`web.telegram.org` sans cette
extension). Utile sur les **deux modes** :

- **Mode Local** (`/local`) : seule voie d'envoi 100% automatique — sans
  elle, tout passe par le Mode Manuel Express (clic humain requis).
- **Mode VPS** (`/vps`) : filet de secours pour la Relance Manuelle Express
  quand la session Baileys tombe (rate-limit, révocation) — permet au
  moteur intelligent de continuer à progresser vers l'objectif fixé sans
  attendre un re-pairage manuel.

Sans elle, les deux modes retombent automatiquement sur le **Mode Manuel
Express** (lien `wa.me` pré-rempli, clic humain requis) — rien ne casse,
l'extension est un vrai bonus, pas une dépendance obligatoire.

## Installation (mode développeur, pas encore publiée sur le Chrome Web Store)

1. Ouvrir `chrome://extensions` (ou `edge://extensions` sur Edge).
2. Activer **le mode développeur** (interrupteur en haut à droite).
3. Cliquer **"Charger l'extension non empaquetée"**.
4. Sélectionner le dossier `browser-extension/` de ce dépôt.
5. L'extension apparaît avec l'icône CYRUS. Elle reste installée tant
   qu'elle n'est pas retirée manuellement — aucune réinstallation nécessaire
   à chaque session.
6. Sur `https://cyrus-super-assistant.vercel.app/local/`, onglet
   **Connexions**, WhatsApp ET Telegram affichent automatiquement "🟢
   Extension CYRUS installée" une fois détectée (vérification automatique,
   aucune action requise côté site).
7. Cliquer **"📷 Connecter WhatsApp"** / **"✈️ Connecter Telegram"** : ouvre
   un onglet dédié — se connecter une seule fois (QR pour WhatsApp,
   numéro+code pour Telegram), comme pour toute nouvelle session Web. La
   session reste active tant que l'onglet n'est pas fermé/déconnecté
   manuellement.

## Comment ça marche (pour comprendre ou auditer le code)

- `injected-bridge.js` (WhatsApp) / `injected-bridge-telegram.js`
  (Telegram) s'exécutent **dans la page** `web.whatsapp.com`/
  `web.telegram.org` (MAIN world) — ports fidèles de
  `mobile/webapp/www/whatsappBridge.js` (pont Capacitor natif, déjà validé
  sur appareil réel) et `mobile/webapp/www/telegramBridge.js` (premier jet,
  état de connexion confirmé réel mais l'envoi n'a jamais été exercé de
  bout en bout — à traiter comme moins éprouvé que le pont WhatsApp).
  Utilisent les modules internes exposés par chaque client Web lui-même
  (`window.require('WAWebSendMsgChatAction')`,
  `window.rootScope.managers.appMessagesManager` etc.), pas une simulation
  de frappe/clic.
- `content-relay.js` (isolated world, partagé entre les deux domaines)
  relaie les évènements du pont actif vers le service worker de
  l'extension (`chrome.runtime`), et les commandes reçues vers la page
  (`window.postMessage`) — nécessaire car un script MAIN world n'a pas
  accès à `chrome.runtime`.
- `background.js` gère un onglet par canal (WhatsApp et Telegram
  indépendants) et répond aux requêtes de la page CYRUS via
  `externally_connectable` (voir `manifest.json`) : `ping`, `getStatus`,
  `sendMessage`, `getGroups`, `getGroupMembers`, `open` — chaque appel prend
  un `channel: 'whatsapp'|'telegram'`.
- Côté site, `webapp-core/lib/extensionBridge.js` appelle l'extension par
  son ID fixe (clé publique intégrée dans `manifest.json` → ID stable quel
  que soit le chemin du dossier chargé) ; `adapters/browser.js` l'utilise
  en priorité pour les deux canaux, avec repli automatique sur le Mode
  Manuel Express si absente ou non connectée.

## Limite assumée : PC uniquement

Les extensions navigateur ne sont pas installables par un utilisateur
classique sur Chrome Android ni Safari iOS — cette extension ne couvre que
le **desktop**. Sur téléphone, le mode Local reste en Mode Manuel Express
(clic humain final dans WhatsApp). Voir la mémoire de session sur ce sujet
si une couverture mobile 100% automatique est un jour demandée (nécessite
l'API WhatsApp Business Cloud officielle, hors périmètre actuel).

## Publication future (Chrome Web Store)

Non fait à ce stade (compte développeur Chrome Web Store requis, hors
périmètre d'un agent automatisé). `extension-key.pem` (racine de ce
dossier, **jamais committé**, voir `.gitignore`) est la clé privée qui
garantit un ID d'extension stable même après publication — la conserver
précieusement, sa perte oblige à redistribuer une nouvelle extension avec
un ID différent (tous les utilisateurs devraient réinstaller).
