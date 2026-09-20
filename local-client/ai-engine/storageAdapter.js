const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../lib/paths');

// ADAPTATEUR local-client de ai-engine/storageAdapter.js (VPS) — MÊME
// contrat get/set/listIds, stockage simplifié : fichier JSON local
// uniquement, SANS miroir GitHub (le disque de ce PC n'est pas éphémère
// comme celui du VPS/Render qui a motivé le miroir GitHub côté VPS — voir
// lib/paths.js, %APPDATA%\CyrusLocalClient, déjà le dossier de données
// persistantes établi pour tout ce client).

function sanitizeId(rawId) {
  const cleaned = String(rawId || '').trim().replace(/[^A-Za-z0-9_-]/g, '_');
  return cleaned || 'unknown';
}

function baseDir(namespace) {
  return path.join(DATA_DIR, 'ai_engine_data', sanitizeId(namespace));
}

function docPath(namespace, docId) {
  return path.join(baseDir(namespace), `${sanitizeId(docId)}.json`);
}

async function get(namespace, docId, defaultValue) {
  try {
    const raw = fs.readFileSync(docPath(namespace, docId), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return defaultValue !== undefined ? defaultValue : null;
  }
}

function set(namespace, docId, data) {
  fs.mkdirSync(baseDir(namespace), { recursive: true });
  fs.writeFileSync(docPath(namespace, docId), JSON.stringify(data, null, 2), 'utf8');
  return data;
}

function listIds(namespace) {
  try {
    return fs.readdirSync(baseDir(namespace)).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5));
  } catch (err) {
    return [];
  }
}

function remove(namespace, docId) {
  try { fs.unlinkSync(docPath(namespace, docId)); } catch (err) { /* déjà absent */ }
  return true;
}

module.exports = { get, set, listIds, remove };
