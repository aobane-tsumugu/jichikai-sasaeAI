-- 束 6: 公式 LINE の受け箱。区ごとのチャンネル対応と受信物だけを置く。
CREATE TABLE line_channels (
  ward_id       TEXT NOT NULL REFERENCES wards (ward_id),
  destination   TEXT NOT NULL UNIQUE,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (ward_id, destination)
) WITHOUT ROWID;

CREATE TABLE line_webhook_receipts (
  ward_id       TEXT NOT NULL REFERENCES wards (ward_id),
  event_id      TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  PRIMARY KEY (ward_id, event_id)
) WITHOUT ROWID;
CREATE INDEX line_webhook_receipts_expiry ON line_webhook_receipts (ward_id, expires_at);

CREATE TABLE line_inbox_items (
  ward_id             TEXT NOT NULL REFERENCES wards (ward_id),
  item_id              TEXT NOT NULL,
  event_id             TEXT NOT NULL,
  sender_id            TEXT NOT NULL,
  original_kind        TEXT NOT NULL CHECK (original_kind IN ('text', 'image')),
  original_text        TEXT,
  original_object_key  TEXT,
  received_at          TEXT NOT NULL,
  matched_project_id   TEXT,
  matched_project_name TEXT,
  match_reason         TEXT,
  disposition          TEXT NOT NULL DEFAULT 'unmatched' CHECK (disposition IN ('unmatched', 'matched')),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (ward_id, item_id),
  UNIQUE (ward_id, event_id)
) WITHOUT ROWID;
CREATE INDEX line_inbox_items_open ON line_inbox_items (ward_id, disposition, received_at);

CREATE TABLE line_unrelated_daily_counts (
  ward_id    TEXT NOT NULL REFERENCES wards (ward_id),
  day        TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
  PRIMARY KEY (ward_id, day)
) WITHOUT ROWID;

CREATE TABLE line_inbox_projects (
  ward_id     TEXT NOT NULL REFERENCES wards (ward_id),
  project_id  TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (ward_id, project_id)
) WITHOUT ROWID;
