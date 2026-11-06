-- 区が分からない問い合わせも提供側で受ける。ward_idは提供側の受付の保管区画。
CREATE TABLE provider_contacts (
  ward_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  receipt TEXT NOT NULL UNIQUE,
  token_hash TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('access', 'broken', 'usage', 'other')),
  ward_name TEXT NOT NULL,
  name TEXT NOT NULL,
  reach TEXT NOT NULL,
  created_at TEXT NOT NULL,
  closed_at TEXT,
  target_ward_id TEXT,
  target_account_id TEXT,
  verified_how TEXT,
  verified_person TEXT,
  verified_by TEXT,
  verified_at TEXT,
  grant_id TEXT,
  grant_secret TEXT,
  grant_expires_at TEXT,
  PRIMARY KEY (ward_id, contact_id),
  UNIQUE (ward_id, token_hash)
);
CREATE TABLE provider_contact_messages (
  ward_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  sender TEXT NOT NULL CHECK (sender IN ('person', 'provider')),
  body TEXT NOT NULL,
  photo_key TEXT,
  photo_type TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ward_id, message_id),
  FOREIGN KEY (ward_id, contact_id) REFERENCES provider_contacts (ward_id, contact_id) ON DELETE CASCADE
);
CREATE TABLE provider_contact_throttle (
  ward_id TEXT NOT NULL,
  identity_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  sends INTEGER NOT NULL,
  PRIMARY KEY (ward_id, identity_hash)
);
CREATE TABLE provider_ward_contacts (
  ward_id TEXT PRIMARY KEY REFERENCES wards (ward_id) ON DELETE CASCADE,
  phone TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT ''
);
