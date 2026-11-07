-- 紙はまず区に入る。行事のほかに、役員が知っておくことへもつなげる。
-- 基本の十五項目はコードの定数に持ち、この表には区ごとの上書きと、区が足した項目だけを置く。
CREATE TABLE ward_know_items (
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  item_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  reviewed_at TEXT,
  added INTEGER NOT NULL DEFAULT 0 CHECK (added IN (0, 1)),
  removed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (ward_id, item_id)
) WITHOUT ROWID;

-- 一枚の原本を、複数の行き先へつなげる。行事は jobs.project_id のまま持つ。
CREATE TABLE ward_material_links (
  ward_id TEXT NOT NULL,
  link_id TEXT NOT NULL,
  original_id TEXT NOT NULL,
  target_kind TEXT NOT NULL CHECK (target_kind IN ('know_item', 'roster')),
  target_id TEXT NOT NULL,
  linked_by TEXT NOT NULL CHECK (linked_by IN ('ai', 'person')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (ward_id, link_id),
  UNIQUE (ward_id, original_id, target_kind, target_id),
  FOREIGN KEY (ward_id, original_id) REFERENCES originals (ward_id, original_id) ON DELETE CASCADE
) WITHOUT ROWID;
CREATE INDEX ward_material_links_target ON ward_material_links (ward_id, target_kind, target_id);
