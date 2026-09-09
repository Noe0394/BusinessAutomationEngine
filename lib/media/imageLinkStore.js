const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Hébergement éphémère d'images/vidéos pour aperçu visuel WhatsApp/Telegram
// (voir index.js, routes GET /v/:id et GET /v/:id/raw, consommées par
// public/dashboard.html et le frontend Vercel). Même principe que
// adapters/media_publisher.js#registerTempVideo/getTempVideo : une URL
// publique qu'un service externe va chercher lui-même — pas un hébergement
// permanent (voir CLAUDE.md : infra Node/Docker/VPS, persistance disque
// local + sauvegarde GitHub optionnelle uniquement, pas de stockage tiers).
//
// Persisté sur DISQUE (volume Docker dédié, voir docker-compose.yml
// "generated_media") plutôt qu'en mémoire comme avant cette révision : un
// simple redémarrage du conteneur (redéploiement de code, rotation de
// clé...) cassait sinon IMMÉDIATEMENT tout lien déjà partagé au frontend
// Vercel, même bien avant l'expiration du TTL de 6h ci-dessous — celui-ci
// reste inchangé, seul le support change (disque au lieu de RAM), donc
// aucune accumulation indéfinie de fichiers.
const TTL_MS = 6 * 60 * 60 * 1000;
const MEDIA_CACHE_DIR = process.env.MEDIA_CACHE_DIR || 'generated_media';
fs.mkdirSync(MEDIA_CACHE_DIR, { recursive: true });

// Un id valide est TOUJOURS un hex de 32 caractères généré par register()
// ci-dessous — rejeté avant toute lecture disque : sans cette validation,
// un id arbitraire venant de req.params.id (voir index.js) pourrait
// s'échapper de MEDIA_CACHE_DIR via path.join (ex: "../../etc/passwd"),
// risque qui n'existait pas avec l'ancienne Map en mémoire (clé opaque,
// jamais utilisée comme chemin de fichier).
const ID_PATTERN = /^[0-9a-f]{32}$/;

function binPath(id) {
  return path.join(MEDIA_CACHE_DIR, `${id}.bin`);
}

function metaPath(id) {
  return path.join(MEDIA_CACHE_DIR, `${id}.json`);
}

function removeEntry(id) {
  fs.rmSync(binPath(id), { force: true });
  fs.rmSync(metaPath(id), { force: true });
}

function purgeExpired() {
  const now = Date.now();
  let files;
  try {
    files = fs.readdirSync(MEDIA_CACHE_DIR);
  } catch (err) {
    return;
  }

  files
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.slice(0, -'.json'.length))
    .forEach((id) => {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
        if (meta.expiresAt < now) removeEntry(id);
      } catch (err) {
        // Fichier meta corrompu/illisible : purgé aussi, pour ne jamais
        // rester bloqué dessus indéfiniment.
        removeEntry(id);
      }
    });
}

// Balayage périodique (voir purgeExpired ci-dessus) : sur un serveur peu
// sollicité, un register() (seul déclencheur avant cette révision) peut ne
// jamais survenir alors que d'anciens fichiers ont déjà expiré depuis
// longtemps.
let purgeTimer = null;
function startPeriodicPurge() {
  if (purgeTimer) return;
  purgeTimer = setInterval(purgeExpired, 30 * 60 * 1000);
  if (purgeTimer.unref) purgeTimer.unref();
}
startPeriodicPurge();

function register(buffer, mimetype, meta) {
  purgeExpired();
  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(binPath(id), buffer);
  fs.writeFileSync(metaPath(id), JSON.stringify({
    mimetype,
    meta: meta || {},
    expiresAt: Date.now() + TTL_MS,
  }));
  return id;
}

function get(id) {
  if (!ID_PATTERN.test(id)) return null;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(metaPath(id), 'utf8'));
  } catch (err) {
    return null;
  }

  if (parsed.expiresAt < Date.now()) {
    removeEntry(id);
    return null;
  }

  let buffer;
  try {
    buffer = fs.readFileSync(binPath(id));
  } catch (err) {
    return null;
  }

  return { buffer, mimetype: parsed.mimetype, meta: parsed.meta };
}

module.exports = {
  register,
  get,
};
