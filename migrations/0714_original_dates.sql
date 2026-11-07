-- 資料自身の日付は受付時刻と分ける。古い資料の日付は不明のまま残す。
ALTER TABLE originals ADD COLUMN document_date TEXT;
ALTER TABLE originals ADD COLUMN document_date_source TEXT;

-- 同じ準備の同じ二つの資料は、項目をまたいでも一度だけ比べる。
CREATE TABLE original_comparisons (
  ward_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  first_original_id TEXT NOT NULL,
  second_original_id TEXT NOT NULL,
  result TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ward_id, project_id, first_original_id, second_original_id),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (ward_id, first_original_id) REFERENCES originals (ward_id, original_id) ON DELETE CASCADE,
  FOREIGN KEY (ward_id, second_original_id) REFERENCES originals (ward_id, original_id) ON DELETE CASCADE
);
