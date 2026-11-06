-- L-258: 当てる間だけ持つ文。原本、記録、写しにはしない。
CREATE TABLE line_photo_context_texts (
  ward_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('user', 'group', 'room')),
  source_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  text TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (ward_id, destination, event_id),
  FOREIGN KEY (ward_id) REFERENCES wards(ward_id) ON DELETE CASCADE
);
CREATE INDEX line_photo_context_window ON line_photo_context_texts
  (ward_id, destination, source_type, source_id, received_at);
ALTER TABLE line_photo_batches ADD COLUMN match_attempted_at TEXT;
ALTER TABLE line_photo_batches ADD COLUMN match_finished_at TEXT;
ALTER TABLE line_photo_batches ADD COLUMN match_claimed_until TEXT;
ALTER TABLE line_photo_batches ADD COLUMN match_reason TEXT;
ALTER TABLE line_photo_batches ADD COLUMN match_pack_version TEXT;
