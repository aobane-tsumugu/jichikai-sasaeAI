-- 役員グループへの一日一度の知らせ。本文やグループのIDは残さない。
CREATE TABLE line_officer_digests (
  ward_id TEXT NOT NULL REFERENCES wards (ward_id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  sent_at TEXT,
  recipients INTEGER NOT NULL CHECK (recipients > 0),
  usage_before INTEGER NOT NULL CHECK (usage_before >= 0),
  inquiry_count INTEGER NOT NULL CHECK (inquiry_count > 0),
  PRIMARY KEY (ward_id, day)
) WITHOUT ROWID;
