-- 後から加える仕事紹介と、一回の処理の上限。
ALTER TABLE ops_ward_limits
  ADD COLUMN session_budget_cents INTEGER NOT NULL DEFAULT 10000 CHECK (session_budget_cents BETWEEN 1 AND 1000000);

CREATE TABLE project_activity_pages (
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  project_id TEXT NOT NULL,
  draft_body TEXT NOT NULL DEFAULT '{}',
  published_body TEXT,
  published_at TEXT,
  updated_at TEXT NOT NULL,
  updated_by_account_id TEXT NOT NULL,
  PRIMARY KEY (ward_id, project_id),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id),
  FOREIGN KEY (ward_id, updated_by_account_id) REFERENCES accounts (ward_id, account_id)
) WITHOUT ROWID;

CREATE INDEX project_activity_pages_public
  ON project_activity_pages (ward_id, published_at, project_id);
