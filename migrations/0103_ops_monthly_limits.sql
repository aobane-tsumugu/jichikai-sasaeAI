-- 提供側が区ごとの月の目安上限を設定する。
CREATE TABLE ops_ward_limits (
  ward_id           TEXT PRIMARY KEY REFERENCES wards (ward_id),
  monthly_limit_cents INTEGER NOT NULL DEFAULT 0 CHECK (monthly_limit_cents >= 0),
  updated_at        TEXT NOT NULL
);
