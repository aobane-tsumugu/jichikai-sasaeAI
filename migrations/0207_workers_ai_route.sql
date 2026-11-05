-- 束 2: 区ごとの予備経路の設定。
CREATE TABLE ward_ai_route_flags (
  ward_id TEXT PRIMARY KEY REFERENCES wards (ward_id),
  use_workers_route INTEGER NOT NULL DEFAULT 0 CHECK (use_workers_route IN (0, 1)),
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
