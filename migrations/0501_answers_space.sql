-- 束 5: 名簿、回答、プロジェクトの空間。
-- 区をまたぐ参照を作らず、全ての問い合わせで ward_id を指定する。
CREATE TABLE ward_roster_entries (
  roster_entry_id TEXT PRIMARY KEY,
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  roster_set_id TEXT NOT NULL,
  household TEXT NOT NULL,
  household_key TEXT NOT NULL,
  district TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (ward_id, roster_entry_id),
  UNIQUE (ward_id, roster_set_id, household_key)
);
CREATE INDEX ward_roster_district ON ward_roster_entries (ward_id, roster_set_id, district, household);

CREATE TABLE ward_roster_settings (
  ward_id TEXT PRIMARY KEY REFERENCES wards (ward_id),
  active_set_id TEXT NOT NULL,
  columns_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) WITHOUT ROWID;

CREATE TABLE project_answers (
  answer_id TEXT PRIMARY KEY,
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  project_id TEXT NOT NULL,
  household TEXT NOT NULL,
  district TEXT NOT NULL,
  people_count INTEGER NOT NULL CHECK (people_count >= 0),
  helper_name TEXT NOT NULL DEFAULT '',
  helper_times TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL CHECK (source IN ('web', 'phone', 'sheet', 'line')),
  original_id TEXT,
  sheet_row_index INTEGER,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by_account_id TEXT,
  UNIQUE (ward_id, answer_id),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id),
  FOREIGN KEY (ward_id, created_by_account_id) REFERENCES accounts (ward_id, account_id)
);
CREATE INDEX project_answers_list ON project_answers (ward_id, project_id, created_at);
CREATE INDEX project_answers_district ON project_answers (ward_id, project_id, district, household);
CREATE UNIQUE INDEX project_answers_sheet_row ON project_answers (ward_id, project_id, original_id, sheet_row_index)
  WHERE original_id IS NOT NULL AND sheet_row_index IS NOT NULL;

CREATE TABLE project_spaces (
  ward_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  passphrase_salt TEXT,
  passphrase_hash TEXT,
  updated_by_account_id TEXT NOT NULL,
  PRIMARY KEY (ward_id, project_id),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id),
  FOREIGN KEY (ward_id, updated_by_account_id) REFERENCES accounts (ward_id, account_id)
) WITHOUT ROWID;

CREATE TABLE project_space_invites (
  invite_id TEXT PRIMARY KEY,
  ward_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  district TEXT,
  role TEXT NOT NULL CHECK (role IN ('member', 'leader')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by_account_id TEXT NOT NULL,
  UNIQUE (ward_id, invite_id),
  UNIQUE (ward_id, token_hash),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id),
  FOREIGN KEY (ward_id, created_by_account_id) REFERENCES accounts (ward_id, account_id)
);
CREATE INDEX project_space_invites_live ON project_space_invites (ward_id, project_id, expires_at, used_at, revoked_at);

CREATE TABLE project_space_members (
  member_id TEXT PRIMARY KEY,
  ward_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('member', 'leader')),
  district TEXT,
  token_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  UNIQUE (ward_id, member_id),
  UNIQUE (ward_id, token_hash),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id)
);
CREATE INDEX project_space_members_live ON project_space_members (ward_id, project_id, expires_at, revoked_at);
