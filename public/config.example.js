// Modèle pour public/config.js — voir dashboard.html (chargé juste avant le
// script principal). Copier ce fichier en "config.js" et renseigner l'URL
// réelle du Space Hugging Face UNIQUEMENT quand le dashboard est déployé
// séparément du backend (ex. interface statique sur Vercel, backend H24 sur
// Hugging Face Spaces). Sur un déploiement même-origine classique (Render),
// laisser window.CYRUS_API_BASE à '' — ou ne pas déployer ce fichier du
// tout, dashboard.html tolère son absence (404 silencieux, comportement
// même-origine inchangé).
window.CYRUS_API_BASE = 'https://VOTRE-NOM-VOTRE-SPACE.hf.space';
