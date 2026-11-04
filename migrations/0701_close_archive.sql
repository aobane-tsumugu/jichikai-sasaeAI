-- 束 7: 閉じる時の地図と報告。全て区とプロジェクトの組で扱う。
CREATE TABLE project_close_map (
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  project_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  period TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  progress TEXT NOT NULL CHECK (progress IN ('open', 'started', 'done')),
  requested_by TEXT NOT NULL DEFAULT '',
  difficulty TEXT NOT NULL DEFAULT '',
  next_year TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by_account_id TEXT NOT NULL,
  PRIMARY KEY (ward_id, project_id, task_id),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id),
  FOREIGN KEY (ward_id, task_id) REFERENCES project_map_tasks (ward_id, task_id),
  FOREIGN KEY (ward_id, updated_by_account_id) REFERENCES accounts (ward_id, account_id)
) WITHOUT ROWID;

CREATE TABLE project_close_reports (
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  project_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('public', 'staff')),
  body TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by_account_id TEXT NOT NULL,
  PRIMARY KEY (ward_id, project_id, scope),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id),
  FOREIGN KEY (ward_id, updated_by_account_id) REFERENCES accounts (ward_id, account_id)
) WITHOUT ROWID;
