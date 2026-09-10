// Identifiant d'appareil stable pour ce PC, généré une seule fois et
// persisté dans AppData (voir paths.js) — envoyé à chaque appel au VPS
// (x-device-id) pour le verrouillage un-appareil-par-clé de licences.js.
// Sans persistance, un simple redémarrage regénérerait un nouvel identifiant
// et déclencherait systématiquement DEVICE_MISMATCH sur la 2e vérification.
const fs = require('fs');
const crypto = require('crypto');
const { DEVICE_ID_PATH } = require('./paths');

function getDeviceId() {
  try {
    const existing = fs.readFileSync(DEVICE_ID_PATH, 'utf8').trim();
    if (existing) return existing;
  } catch (err) {
    // Pas encore de fichier : première exécution sur ce PC.
  }

  const id = crypto.randomUUID();
  fs.writeFileSync(DEVICE_ID_PATH, id, 'utf8');
  return id;
}

module.exports = { getDeviceId };
