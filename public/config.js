// ATTENTION — BLOCAGE "MIXED CONTENT" ATTENDU : ce dashboard est servi en
// HTTPS depuis Vercel, mais le backend VPS ci-dessous n'est joignable qu'en
// HTTP brut (http://34.68.84.124:3000, aucun certificat TLS configuré sur ce
// VPS). Tous les navigateurs modernes bloquent SILENCIEUSEMENT tout
// fetch/XHR depuis une page HTTPS vers une URL http:// (politique de
// sécurité "mixed content", non contournable côté client) — en l'état,
// AUCUN appel /api/... ne fonctionnera depuis https://cyrus-super-assistant.vercel.app
// tant que ce VPS n'est pas exposé en HTTPS (reverse proxy Caddy/Nginx +
// certificat Let's Encrypt sur un nom de domaine pointant vers 34.68.84.124
// — une IP nue ne peut pas obtenir de certificat Let's Encrypt, un nom de
// domaine est nécessaire). Valeur renseignée telle que demandée ; à corriger
// dès qu'un domaine + HTTPS sont en place sur ce VPS.
window.CYRUS_API_BASE = 'http://34.68.84.124:3000';
