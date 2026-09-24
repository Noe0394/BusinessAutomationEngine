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

  -- Liste noire manuelle (opt-out) - distincte de tout anti-doublons
  -- temporaire : un identifiant ici est exclu de toute NOUVELLE campagne
  -- (voir lib/campaigns.js#createCampaign) jusqu'à retrait explicite. La
  -- colonne "channel" distingue WhatsApp/Telegram (un même numéro peut être
  -- bloqué sur l'un et pas l'autre).
  CREATE TABLE IF NOT EXISTS blocklist (
    channel TEXT NOT NULL,
    identifier TEXT NOT NULL,
    added_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (channel, identifier)
  );

  CREATE TABLE IF NOT EXISTS facebook_queue_jobs (
    id TEXT PRIMARY KEY,
    status TEXT NOT NULL,
    total INTEGER NOT NULL,
    sent INTEGER NOT NULL DEFAULT 0,
    recipients_json TEXT NOT NULL DEFAULT '[]',
    results_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT,
    error TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_facebook_queue_jobs_created ON facebook_queue_jobs(created_at DESC);
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

// ---------- Liste noire ----------
function addToBlocklist(channel, identifier) {
  db.prepare(`
    INSERT INTO blocklist (channel, identifier) VALUES (?, ?)
    ON CONFLICT(channel, identifier) DO NOTHING
  `).run(channel, identifier);
}

function removeFromBlocklist(channel, identifier) {
  db.prepare('DELETE FROM blocklist WHERE channel = ? AND identifier = ?').run(channel, identifier);
}

function getBlocklist(channel) {
  return db.prepare('SELECT * FROM blocklist WHERE channel = ? ORDER BY added_at DESC').all(channel);
}

function isBlocked(channel, identifier) {
  return Boolean(db.prepare('SELECT 1 FROM blocklist WHERE channel = ? AND identifier = ?').get(channel, identifier));
}

// ---------- Historique des envois (page Connexions) ----------
// Les deux canaux partagent la table `messages` (jid préfixé "tg:" côté
// Telegram, voir lib/telegram.js#sendMessage) - un simple filtre sur le
// préfixe distingue le canal pour l'affichage, sans colonne dédiée.
function listSentHistory(limit = 100) {
  return db.prepare(`
    SELECT jid, body, created_at FROM messages WHERE direction = 'out'
    ORDER BY created_at DESC LIMIT ?
  `).all(limit).map((row) => ({
    channel: row.jid.startsWith('tg:') ? 'telegram' : 'whatsapp',
    identifier: row.jid.replace(/^tg:/, '').replace(/@(c\.us|s\.whatsapp\.net)$/, ''),
    body: row.body,
    sentAt: row.created_at,
  }));
}

function saveFacebookQueueJob(job) {
  db.prepare(`
    INSERT INTO facebook_queue_jobs
      (id, status, total, sent, recipients_json, results_json, created_at, updated_at, completed_at, error)
    VALUES (@id, @status, @total, @sent, @recipients, @results, @createdAt, @updatedAt, @completedAt, @error)
    ON CONFLICT(id) DO UPDATE SET
      status = excluded.status,
      total = excluded.total,
      sent = excluded.sent,
      recipients_json = excluded.recipients_json,
      results_json = excluded.results_json,
      updated_at = excluded.updated_at,
      completed_at = excluded.completed_at,
      error = excluded.error
  `).run({
    id: job.id,
    status: job.status,
    total: job.total,
    sent: job.sent || 0,
    recipients: JSON.stringify(job.recipients || []),
    results: JSON.stringify(job.results || []),
    createdAt: job.createdAt,
    updatedAt: job.updatedAt || new Date().toISOString(),
    completedAt: job.completedAt || null,
    error: job.error || null,
  });
}

function parseFacebookQueueJob(row) {
  if (!row) return null;
  let recipients = [];
  let results = [];
  try { recipients = JSON.parse(row.recipients_json || '[]'); } catch {}
  try { results = JSON.parse(row.results_json || '[]'); } catch {}
  return {
    id: row.id, status: row.status, total: row.total, sent: row.sent,
    recipients, results, createdAt: row.created_at, updatedAt: row.updated_at,
    completedAt: row.completed_at, error: row.error,
  };
}

function getFacebookQueueJob(id) {
  return parseFacebookQueueJob(db.prepare('SELECT * FROM facebook_queue_jobs WHERE id = ?').get(id));
}

function listFacebookQueueJobs(limit = 30) {
  return db.prepare('SELECT * FROM facebook_queue_jobs ORDER BY created_at DESC LIMIT ?').all(limit).map(parseFacebookQueueJob);
}

function pruneFacebookQueueJobs(limit = 30) {
  db.prepare(`
    DELETE FROM facebook_queue_jobs
    WHERE status <> 'running' AND id NOT IN (
      SELECT id FROM facebook_queue_jobs ORDER BY created_at DESC LIMIT ?
    )
  `).run(limit);
}

function interruptRunningFacebookQueueJobs() {
  const rows = db.prepare("SELECT * FROM facebook_queue_jobs WHERE status = 'running'").all();
  const now = new Date().toISOString();
  for (const row of rows) {
    const job = parseFacebookQueueJob(row);
    const attempted = new Set();
    job.results = job.results.map((result) => {
      if (result.status === 'sending') {
        attempted.add(String(result.to));
        return { ...result, status: 'unknown', error: 'Le client s’est arrêté pendant la transmission; vérifie la conversation avant tout nouvel envoi.' };
      }
      if (result.status !== 'not_sent') attempted.add(String(result.to));
      return result;
    });
    for (const recipient of job.recipients) {
      if (!attempted.has(String(recipient))) job.results.push({ to: String(recipient), status: 'not_sent', error: 'Le client s’est arrêté avant cet envoi.', timestamp: now });
    }
    job.status = 'interrupted';
    job.error = 'Le client s’est arrêté pendant la file. Vérifie les résultats avant toute nouvelle tentative.';
    job.completedAt = now;
    job.updatedAt = now;
    saveFacebookQueueJob(job);
  }
}

module.exports = {
  db,
  upsertContact,
  recordMessage,
  listContacts,
  listMessages,
  getContactName,
  addToBlocklist,
  removeFromBlocklist,
  getBlocklist,
  isBlocked,
  listSentHistory,
  saveFacebookQueueJob,
  getFacebookQueueJob,
  listFacebookQueueJobs,
  pruneFacebookQueueJobs,
  interruptRunningFacebookQueueJobs,
};
