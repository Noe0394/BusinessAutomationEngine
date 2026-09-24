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

-- Registre maître global des contacts Cyrus. Les licences sont remplacées
-- par un hash stable dans les relations; aucune clé de licence brute n'est
-- conservée ici. Les JID/LID et identifiants Telegram restent des alias
-- techniques à portée utilisateur et ne deviennent jamais des téléphones.
CREATE TABLE IF NOT EXISTS contact_master_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS global_contacts (
  id TEXT PRIMARY KEY,
  phone_e164 TEXT UNIQUE,
  name TEXT,
  country TEXT,
  country_code TEXT,
  country_name TEXT,
  country_source TEXT,
  country_confidence REAL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  platforms_json TEXT NOT NULL DEFAULT '[]',
  first_activity TEXT,
  last_activity TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_global_contacts_country ON global_contacts(country_code);
CREATE INDEX IF NOT EXISTS idx_global_contacts_status ON global_contacts(status);
CREATE INDEX IF NOT EXISTS idx_global_contacts_activity ON global_contacts(last_activity DESC, id);
CREATE INDEX IF NOT EXISTS idx_global_contacts_registered ON global_contacts(created_at DESC, id);

CREATE TABLE IF NOT EXISTS global_contact_identifiers (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  identifier_type TEXT NOT NULL,
  identifier_hash TEXT NOT NULL,
  masked_value TEXT,
  user_ref TEXT,
  platform TEXT NOT NULL,
  source TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1,
  first_seen TEXT NOT NULL,
  last_seen TEXT NOT NULL,
  UNIQUE(identifier_type, identifier_hash),
  FOREIGN KEY(contact_id) REFERENCES global_contacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_global_contact_identifiers_contact ON global_contact_identifiers(contact_id);
CREATE INDEX IF NOT EXISTS idx_global_contact_identifiers_user ON global_contact_identifiers(user_ref, platform);

CREATE TABLE IF NOT EXISTS global_contact_relations (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  user_ref TEXT NOT NULL,
  service_id TEXT,
  service_name TEXT,
  platform TEXT NOT NULL,
  source TEXT NOT NULL,
  group_id TEXT,
  group_name TEXT,
  campaign_id TEXT,
  campaign_name TEXT,
  conversation_id TEXT,
  first_used TEXT NOT NULL,
  last_used TEXT NOT NULL,
  context_json TEXT NOT NULL DEFAULT '{}',
  FOREIGN KEY(contact_id) REFERENCES global_contacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_global_relations_contact ON global_contact_relations(contact_id, last_used DESC);
CREATE INDEX IF NOT EXISTS idx_global_relations_user ON global_contact_relations(user_ref, last_used DESC);
CREATE INDEX IF NOT EXISTS idx_global_relations_service ON global_contact_relations(service_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_global_relations_platform ON global_contact_relations(platform, contact_id);
CREATE INDEX IF NOT EXISTS idx_global_relations_source ON global_contact_relations(source, contact_id);
CREATE INDEX IF NOT EXISTS idx_global_relations_group ON global_contact_relations(group_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_global_relations_campaign ON global_contact_relations(campaign_id, contact_id);
CREATE INDEX IF NOT EXISTS idx_global_relations_first ON global_contact_relations(first_used, contact_id);
CREATE INDEX IF NOT EXISTS idx_global_relations_last ON global_contact_relations(last_used, contact_id);

CREATE TABLE IF NOT EXISTS global_contact_facets (
  id TEXT PRIMARY KEY,
  contact_id TEXT NOT NULL,
  relation_id TEXT NOT NULL,
  facet_type TEXT NOT NULL,
  facet_value TEXT NOT NULL,
  evidence TEXT NOT NULL,
  confidence REAL NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(contact_id, relation_id, facet_type, facet_value),
  FOREIGN KEY(contact_id) REFERENCES global_contacts(id) ON DELETE CASCADE,
  FOREIGN KEY(relation_id) REFERENCES global_contact_relations(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_global_facets_value ON global_contact_facets(facet_type, facet_value, contact_id);

-- Index inversé déterministe (un token par mot observé) pour les recherches
-- sur les noms et contextes réels, sans indexer le texte des conversations.
CREATE TABLE IF NOT EXISTS global_contact_search_terms (
  contact_id TEXT NOT NULL,
  relation_id TEXT NOT NULL DEFAULT '',
  field_name TEXT NOT NULL,
  term TEXT NOT NULL,
  PRIMARY KEY(contact_id, relation_id, field_name, term),
  FOREIGN KEY(contact_id) REFERENCES global_contacts(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_global_contact_search_term ON global_contact_search_terms(term, contact_id);

CREATE TABLE IF NOT EXISTS global_contact_events (
  idempotency_key TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  contact_id TEXT,
  user_ref TEXT,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_global_contact_events_pending ON global_contact_events(status, received_at);
