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
