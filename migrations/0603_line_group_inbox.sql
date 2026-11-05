-- 束 6: グループ受信の投稿者表示と、参加時の案内記録。
ALTER TABLE line_inbox_items ADD COLUMN sender_display_name TEXT;
ALTER TABLE line_inbox_items ADD COLUMN sender_label TEXT;

CREATE TABLE line_group_notices (
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  group_id TEXT NOT NULL,
  first_joined_at TEXT NOT NULL,
  notice_sent_at TEXT,
  PRIMARY KEY (ward_id, group_id)
) WITHOUT ROWID;
