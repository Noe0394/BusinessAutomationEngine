// Service worker minimal : seule sa PRÉSENCE (avec un gestionnaire "fetch"
// enregistré) suffit à rendre l'application installable ("Ajouter à l'écran
// d'accueil") sur Chrome/Android/Edge — voir public/manifest.json et le
// <link rel="manifest"> dans public/dashboard.html.
//
// Aucune mise en cache ici : CYRUS SUPER ASSISTANT est une application 100%
// dynamique (sessions WhatsApp/Telegram en direct, données isolées par
// licence, campagnes en cours) — mettre quoi que ce soit en cache
// risquerait de servir des données périmées ou celles d'un autre tenant.
// Chaque requête part donc TOUJOURS au réseau, sans interception de
// contenu (le gestionnaire "fetch" ci-dessous est intentionnellement vide).
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Intentionnellement vide : laisse le navigateur traiter la requête
  // normalement (réseau direct) — voir le commentaire en tête de fichier.
});
