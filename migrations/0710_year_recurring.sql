-- 通年の予定は月を決めず、くり返しを文で持つ。
ALTER TABLE ward_year_items ADD COLUMN recurrence_text TEXT NOT NULL DEFAULT '';

-- 当番を作り直すときにも、最初に選んだ曜日を使う。
CREATE TABLE rota_schedules (
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  project_id TEXT NOT NULL,
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),
  PRIMARY KEY (ward_id, project_id),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id) ON DELETE CASCADE
) WITHOUT ROWID;
