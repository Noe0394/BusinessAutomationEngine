CREATE TABLE IF NOT EXISTS licenses (
  key             TEXT PRIMARY KEY,
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL,
  expires_at      TEXT,
  note            TEXT NOT NULL DEFAULT '',
  allowed_modules TEXT NOT NULL DEFAULT '[]',
  bound_device_id TEXT,
  bound_at        TEXT,
  extra           TEXT NOT NULL DEFAULT '{}',
  updated_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_licenses_created ON licenses (created_at DESC);

-- Comptes élèves et clés d'accès (portage des collections cyrus_students / cyrus_access_keys)
CREATE TABLE IF NOT EXISTS cyrus_students (
  id             TEXT PRIMARY KEY,
  full_name      TEXT,
  email          TEXT,
  phone          TEXT,
  sku            TEXT,
  amount         REAL,
  currency       TEXT NOT NULL DEFAULT 'FCFA',
  transaction_id TEXT,
  paid_at        TEXT,
  tenant_id      TEXT NOT NULL DEFAULT 'default',
  access_key      TEXT,
  modules        TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_students_phone ON cyrus_students (phone);
CREATE INDEX IF NOT EXISTS idx_students_email ON cyrus_students (email);
CREATE TABLE IF NOT EXISTS cyrus_access_keys (
  access_key TEXT PRIMARY KEY,
  student_id TEXT NOT NULL,
  sku        TEXT,
  issued_at  TEXT NOT NULL
);

-- Jobs vidéo asynchrones (soumission puis interrogation)
CREATE TABLE IF NOT EXISTS video_jobs (
  id         TEXT PRIMARY KEY,
  job        TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- Configuration clé/valeur (métadonnées de mise à jour du client PC)
CREATE TABLE IF NOT EXISTS app_config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Anti-force-brute de l'administration (échecs par adresse)
CREATE TABLE IF NOT EXISTS admin_attempts (
  ip       TEXT PRIMARY KEY,
  fails    INTEGER NOT NULL,
  first_at INTEGER NOT NULL
);

-- Jetons Facebook chiffres cote Worker; la cle AES-256 n'est qu'un secret Wrangler.
CREATE TABLE IF NOT EXISTS facebook_accounts (
  license_key       TEXT PRIMARY KEY,
  device_id         TEXT NOT NULL,
  user_token_cipher TEXT,
  page_token_cipher TEXT,
  page_id           TEXT,
  page_name         TEXT,
  connected_at      TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS facebook_oauth_states (
  state      TEXT PRIMARY KEY,
  license_key TEXT NOT NULL,
  device_id   TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facebook_oauth_expires ON facebook_oauth_states (expires_at);

-- Regles, prospects et progression de la capture Facebook sur mobile.
-- Chaque enregistrement reste isole par licence et appareil deja lie.
CREATE TABLE IF NOT EXISTS facebook_keyword_rules (
  license_key TEXT NOT NULL, device_id TEXT NOT NULL, page_id TEXT NOT NULL, id TEXT NOT NULL,
  keyword TEXT NOT NULL, reply_message TEXT NOT NULL DEFAULT '',
  auto_reply INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
  PRIMARY KEY (license_key, device_id, page_id, id)
);
CREATE INDEX IF NOT EXISTS idx_fb_rules_device ON facebook_keyword_rules (license_key, device_id, page_id, created_at);

CREATE TABLE IF NOT EXISTS facebook_leads (
  license_key TEXT NOT NULL, device_id TEXT NOT NULL, page_id TEXT NOT NULL, psid TEXT NOT NULL,
  name TEXT, source TEXT NOT NULL DEFAULT 'comment', last_text TEXT NOT NULL DEFAULT '',
  post_id TEXT, keyword TEXT, reply_status TEXT NOT NULL DEFAULT 'not_sent',
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (license_key, device_id, page_id, psid)
);
CREATE INDEX IF NOT EXISTS idx_fb_leads_device ON facebook_leads (license_key, device_id, page_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS facebook_seen_comments (
  license_key TEXT NOT NULL, device_id TEXT NOT NULL, page_id TEXT NOT NULL, comment_id TEXT NOT NULL,
  post_id TEXT NOT NULL, psid TEXT NOT NULL, name TEXT, rule_id TEXT, comment_text TEXT NOT NULL,
  keyword TEXT, reply_message TEXT, status TEXT NOT NULL DEFAULT 'captured',
  reply_error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (license_key, device_id, page_id, comment_id)
);
CREATE INDEX IF NOT EXISTS idx_fb_comments_pending ON facebook_seen_comments (license_key, device_id, page_id, status, created_at);

CREATE TABLE IF NOT EXISTS facebook_capture_state (
  license_key TEXT NOT NULL, device_id TEXT NOT NULL, page_id TEXT, last_scan_at INTEGER,
  scan_started_at INTEGER, pending_posts TEXT, post_offset INTEGER NOT NULL DEFAULT 0,
  lock_until INTEGER, updated_at INTEGER NOT NULL,
  PRIMARY KEY (license_key, device_id)
);
CREATE TABLE IF NOT EXISTS facebook_capture_cursors (
  license_key TEXT NOT NULL, device_id TEXT NOT NULL, post_id TEXT NOT NULL,
  after_cursor TEXT NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (license_key, device_id, post_id)
);
