# Contrat d'adaptateur — `window.CyrusEngine` / `window.CyrusStore`

Chaque plateforme (`adapters/mobile.js`, `adapters/desktop.js`) doit fournir
EXACTEMENT ces deux objets globaux avant que `app-core.js` ne s'exécute
(donc chargés avant lui dans `index.html`). Aucune fonction du cœur partagé
ne doit jamais tester `if (Capacitor)` ou `if (fetch)` pour deviner la
plateforme — c'est tout l'intérêt de ce contrat.

## `window.CyrusEngine` — le fil WhatsApp/Telegram lui-même

```
getStatus(channel) -> Promise<{ connected, qr, qrImage, configured, error }>
  Tous les champs sont optionnels sauf `connected`. `qr` (chaîne brute) et
  `qrImage` (data URL PNG) ne concernent que WhatsApp ; `configured`/`error`
  surtout Telegram (API_ID/HASH absents, erreur de login).

onStateChange(channel, callback)
  callback({ connected, ... }) - le MÊME shape que getStatus(), appelé à
  chaque changement. Desktop : implémenté par polling interne (setInterval)
  de son API HTTP. Mobile : par les évènements EmbeddedWebView. L'appelant ne
  sait jamais lequel des deux se passe.

mountConnectUI(channel, containerEl)
  Seule fonction du contrat qui injecte du DOM spécifique à la plateforme.
  Desktop : formulaire numéro→code→mot de passe (Telegram) ou juste un <img>
  QR (WhatsApp, déjà fourni par getStatus().qrImage - peut réutiliser un
  <img> générique commun, voir connexions-core.js). Mobile : ne rend RIEN
  dans containerEl (la WebView est une vraie vue native positionnée par
  dessus, voir EmbeddedWebViewPlugin#setBounds) - se contente de mémoriser
  `containerEl` pour calculer ses coordonnées écran au bon moment.

sendMessage(channel, to, text) -> Promise<{ ok, error }>
  `to` : JID WhatsApp complet ou identifiant Telegram (@username ou
  numéro), déjà résolu par l'appelant - l'adaptateur ne fait AUCUNE
  normalisation, voir lib/personalization.js pour ça en amont. L'adaptateur
  gère lui-même l'attente d'un accusé de réception le cas échéant (mobile :
  évènement `send-result` du pont WebView, avec timeout) - l'appelant ne
  voit jamais cette mécanique, juste `{ ok, error }` en retour.

getGroups(channel) -> Promise<[{ id, name, participantsCount }]>
getGroupMembers(channel, groupId) -> Promise<[{ id, name, isAdmin }]>
  `name` peut être vide (WhatsApp ne fournit pas toujours un nom de membre
  sans lookup contact) - jamais undefined, toujours '' au minimum.

logout(channel) -> Promise
  Déconnexion RÉELLE (efface la session, pas un simple masquage UI) - voir
  EmbeddedWebViewPlugin#logout (mobile) / POST /api/whatsapp/logout|
  /api/telegram/logout (desktop).
```

## `window.CyrusStore` — tout ce qui n'est PAS le fil WhatsApp/Telegram

Phase actuelle (2026-09-10) : adossé au stockage local de chaque plateforme
(IndexedDB mobile, SQLite desktop via HTTP). Migrera vers Firestore dans une
phase ultérieure SANS changer cette interface - voir `webapp-core/README.md`.

Forme canonique d'une campagne (les deux adaptateurs DOIVENT traduire vers
cette forme, même si leur stockage interne diffère) :
```
{
  id, channel, name, status,           // status: draft|running|paused|completed|cancelled
  text, delayMinMs, delayMaxMs,
  recipients: [{ to, name, status }],  // status: pending|sent|failed
  updatedAt,
}
```

```
getContacts(channel) -> Promise<[{ identifier, name }]>
putContacts(channel, contacts) -> Promise
  Ajoute/met à jour (upsert par identifiant) - n'efface jamais les contacts
  existants non listés.

listCampaigns(channel) -> Promise<[Campaign]>
getCampaign(id) -> Promise<Campaign|null>
getLatestCampaign(channel) -> Promise<Campaign|null>
  La plus récente par `updatedAt` - c'est sur elle que la Relance Manuelle
  Express reprend les destinataires encore pending/failed.
createCampaign(channel, { name, text, delayMinMs, delayMaxMs, recipients }) -> Promise<Campaign>
  `recipients` : tableau de { identifier, name } bruts (pas encore
  personnalisés). Applique le filtrage liste noire AVANT toute écriture.
saveCampaignProgress(campaignId, recipients) -> Promise
  Met à jour uniquement `recipients`/`updatedAt` d'une campagne existante
  (appelé à chaque envoi par la boucle de campagnes-core.js).
startCampaign(id) / pauseCampaign(id) / cancelCampaign(id) -> Promise

markManualSent(channel, campaignIdOrNull, to) -> Promise
  `campaignIdOrNull` = null si la relance vient d'un import direct (pas
  d'une campagne) - voir relance-core.js.

getBlocklist(channel) -> Promise<[{ identifier }]>
addToBlocklist(channel, identifier) -> Promise
removeFromBlocklist(channel, identifier) -> Promise
filterBlocked(channel, contacts) -> Promise<contacts filtrés>

recordSent(channel, identifier, source) -> Promise   // source: 'campaign'|'manual'
wasSentRecently(channel, identifier, windowMs) -> Promise<boolean>
getSentLog(channel, limit) -> Promise<[{ channel, identifier, source, sentAt }]>

exportRows(rows, filename, format) -> Promise         // format: 'xlsx'|'csv'
  SEULE fonction de `CyrusStore` qui n'est pas une donnée métier - le
  mécanisme de téléchargement diffère trop entre plateformes (Capacitor
  Filesystem+Share vs téléchargement navigateur direct) pour vivre dans le
  cœur partagé.
```
