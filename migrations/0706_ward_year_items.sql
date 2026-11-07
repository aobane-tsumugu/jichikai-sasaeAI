-- 区の一年。基本の型はコードの定数に持ち、この表には区ごとの上書き（外した）と、区で足した行だけを置く。
CREATE TABLE ward_year_items (
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  item_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  month INTEGER CHECK (month IS NULL OR month BETWEEN 1 AND 12),
  date_text TEXT NOT NULL DEFAULT '',
  added INTEGER NOT NULL DEFAULT 0 CHECK (added IN (0, 1)),
  removed_at TEXT,
  source_original_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (ward_id, item_id)
) WITHOUT ROWID;
