-- 一対一の写真それぞれに受領を返し、質問と同じReplyを二度使わない。
ALTER TABLE line_photo_items ADD COLUMN receipt_reply_token TEXT;
ALTER TABLE line_photo_items ADD COLUMN receipt_claimed_at TEXT;

-- グループで人が行事を選んだ場所を覚える。一対一は複数の行事を送るので固定しない。
CREATE TABLE line_photo_sources (
  ward_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('group', 'room')),
  source_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  PRIMARY KEY (ward_id, destination, source_type, source_id),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id) ON DELETE CASCADE
) WITHOUT ROWID;
