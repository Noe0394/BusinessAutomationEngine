// Backend VPS exposé en HTTPS via Caddy + sslip.io (voir Caddyfile et
// setup-vps.sh) — sslip.io résout "34-68-84-124.sslip.io" directement vers
// l'IP publique du VPS (34.68.84.124) sans achat de nom de domaine, ce qui
// permet à Let's Encrypt d'émettre un vrai certificat (impossible sur une
// IP nue). Plus de blocage "mixed content" : ce dashboard (HTTPS, Vercel)
// peut désormais joindre normalement ce backend.
window.CYRUS_API_BASE = 'https://34-68-84-124.sslip.io';
