const crypto = require('crypto');

// Hébergement éphémère d'images pour aperçu visuel WhatsApp/Telegram (voir
// index.js, routes GET /v/:id et GET /v/:id/raw, consommées par
// public/dashboard.html — Relance Manuelle Express, module Image-to-Link).
// Même principe que adapters/media_publisher.js#registerTempVideo/getTempVideo
// (déjà en production pour la création de conteneur Reels Instagram, qui a
// exactement le même besoin : une URL publique qu'un service externe va
// chercher lui-même) : stockage en mémoire, perdu à chaque redéploiement,
// avec expiration automatique — pas une alternative à un stockage
// persistant tiers (Firebase/Supabase storage), volontairement absent de
// cette architecture (voir CLAUDE.md : infra Node/Docker/VPS, persistance
// disque local + sauvegarde GitHub optionnelle uniquement). Ces liens
// servent une session de relance manuelle EN COURS, pas un hébergement
// permanent — 6h de durée de vie couvre largement une session, sans
// accumuler indéfiniment des images en mémoire.
const TTL_MS = 6 * 60 * 60 * 1000;

const store = new Map();

function purgeExpired() {
  const now = Date.now();
  for (const [id, entry] of store.entries()) {
    if (entry.expiresAt < now) store.delete(id);
  }
}

function register(buffer, mimetype, meta) {
  purgeExpired();
  const id = crypto.randomBytes(16).toString('hex');
  store.set(id, { buffer, mimetype, meta: meta || {}, expiresAt: Date.now() + TTL_MS });
  return id;
}

function get(id) {
  const entry = store.get(id);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) {
    store.delete(id);
    return null;
  }
  return entry;
}

module.exports = {
  register,
  get,
};
