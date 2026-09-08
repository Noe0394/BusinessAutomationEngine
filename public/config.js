// Backend VPS exposé en HTTPS via Caddy + sslip.io (voir Caddyfile et
// setup-vps.sh) — sslip.io résout "116-202-170-250.sslip.io" directement vers
// l'IP publique du VPS (116.202.170.250) sans achat de nom de domaine, ce qui
// permet à Let's Encrypt d'émettre un vrai certificat (impossible sur une
// IP nue). Plus de blocage "mixed content" : ce dashboard (HTTPS, Vercel)
// peut désormais joindre normalement ce backend.
window.CYRUS_API_BASE = 'https://116-202-170-250.sslip.io';
