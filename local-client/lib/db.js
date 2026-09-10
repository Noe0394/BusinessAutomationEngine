// Base de données locale (point 1 de la feuille de route) — contacts,
// messages et campagnes de CE PC uniquement, jamais synchronisés vers le
// VPS. node:sqlite (natif à Node.js ≥ 22.5, API synchrone) plutôt que
// better-sqlite3 : ce PC n'a ni Visual Studio Build Tools ni binaire
// pré-compilé disponible pour la version de Node installée, et
// better-sqlite3 nécessite l'un des deux (compilation native via node-gyp).
// node:sqlite est intégré à Node lui-même — aucune compilation, aucune
// dépendance supplémentaire, et un futur packaging pkg (voir README.md) n'a
// plus de module natif à gérer séparément. API quasi identique
// (prepare/run/get/all, paramètres nommés @xxx) — seul changement de code
// nécessaire : le constructeur. Statut "expérimental" côté Node.js, à
// surveiller lors des montées de version de Node.
const { DatabaseSync } = require('node:sqlite');
const { DB_PATH } = require('./paths');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    jid TEXT PRIMARY KEY,
    nom TEXT,
    telephone TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jid TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('in', 'out')),
    body TEXT,
    media_path TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_messages_jid ON messages(jid);

  -- config_json : { text, delayMinMs, delayMaxMs, recipients: [...] } — voir
  -- lib/campaigns.js. results_json : tableau parallèle à config.recipients,
  -- un statut par destinataire (pending/sent/error), mis à jour au fil de
  -- l'envoi pour permettre la reprise après coupure (redémarrage du client).
  CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'draft',
    config_json TEXT NOT NULL DEFAULT '{}',
    results_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

function upsertContact({ jid, nom, telephone }) {
  db.prepare(`
    INSERT INTO contacts (jid, nom, telephone) VALUES (@jid, @nom, @telephone)
    ON CONFLICT(jid) DO UPDATE SET
      nom = COALESCE(excluded.nom, contacts.nom),
      telephone = COALESCE(excluded.telephone, contacts.telephone)
  `).run({ jid, nom: nom || null, telephone: telephone || null });
}

function recordMessage({ jid, direction, body, mediaPath }) {
  db.prepare(`
    INSERT INTO messages (jid, direction, body, media_path) VALUES (?, ?, ?, ?)
  `).run(jid, direction, body || null, mediaPath || null);
}

function listContacts() {
  return db.prepare('SELECT * FROM contacts ORDER BY created_at DESC').all();
}

function listMessages(jid, limit = 100) {
  return db.prepare('SELECT * FROM messages WHERE jid = ? ORDER BY created_at DESC LIMIT ?').all(jid, limit);
}

// Signature compatible avec lib/whatsappRecipients.js#normalizeRecipientEntry
// (racine du dépôt, réutilisé tel quel par lib/campaigns.js) : cette fonction
// y sert de cache de noms, exactement comme adapters/whatsapp.js#getContactName
// côté backend principal — sauf que la source ici est SQLite, pas une Map en
// mémoire vidée à chaque redémarrage.
function getContactName(jid) {
  const row = db.prepare('SELECT nom FROM contacts WHERE jid = ?').get(jid);
  return (row && row.nom) || null;
}

module.exports = { db, upsertContact, recordMessage, listContacts, listMessages, getContactName };
