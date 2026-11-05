-- 手伝いだけの申し込みは、世帯の回答や名簿とは別に持つ。
CREATE TABLE project_help_offers (
  offer_id TEXT PRIMARY KEY,
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  times TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (ward_id, offer_id),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id) ON DELETE CASCADE
);
CREATE INDEX project_help_offers_list ON project_help_offers (ward_id, project_id, created_at);

-- 既存の「閉じる」処理と同じ書き込みの中で消す。開き直しても名前は戻らない。
CREATE TRIGGER project_help_offers_close
AFTER UPDATE OF closed_at ON projects
WHEN OLD.closed_at IS NULL AND NEW.closed_at IS NOT NULL
BEGIN
  DELETE FROM project_help_offers WHERE ward_id = NEW.ward_id AND project_id = NEW.project_id;
END;
