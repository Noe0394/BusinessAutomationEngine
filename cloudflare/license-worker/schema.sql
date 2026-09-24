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
