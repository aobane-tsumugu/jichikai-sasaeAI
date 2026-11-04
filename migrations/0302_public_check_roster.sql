-- 束 3: 公開の案を確認するために役員が受け取る名簿の形。
-- 元の名簿は原本として別に保管し、照合に使う氏名と電話だけを区ごとに持つ。
CREATE TABLE check_roster (
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  entry_id TEXT NOT NULL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  PRIMARY KEY (ward_id, entry_id)
) WITHOUT ROWID;
CREATE INDEX check_roster_name ON check_roster (ward_id, name);
CREATE INDEX check_roster_phone ON check_roster (ward_id, phone);
