-- C10: 実行委員名簿を既存の表に加える。行と変更履歴への参照をそのまま保つ。
-- 表名を変えずに作り直し、既存の記録用triggerの参照先を変えない。
CREATE TABLE project_rows_c10_copy AS SELECT * FROM project_rows;
DROP TABLE project_rows;

CREATE TABLE project_rows (
  row_id                TEXT PRIMARY KEY,
  ward_id               TEXT NOT NULL REFERENCES wards (ward_id),
  project_id            TEXT NOT NULL,
  table_key             TEXT NOT NULL CHECK (table_key IN ('sponsors', 'duties', 'layout', 'ledger', 'decisions', 'submissions', 'committee')),
  scope                 TEXT NOT NULL CHECK (scope IN ('current', 'reference')),
  ref_year              INTEGER,
  match_key             TEXT NOT NULL,
  data                  TEXT NOT NULL,
  person_fields         TEXT NOT NULL DEFAULT '[]',
  source_kind           TEXT NOT NULL CHECK (source_kind IN ('original', 'person', 'web_answer', 'ai_proposal')),
  source_ref            TEXT,
  source_locator        TEXT,
  source_year           INTEGER,
  confidence            TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  change_id             TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by_account_id TEXT,
  removed_at            TEXT,
  removed_by_account_id TEXT,
  CHECK (scope = 'reference' OR ref_year IS NULL),
  UNIQUE (ward_id, row_id),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id),
  FOREIGN KEY (ward_id, change_id) REFERENCES project_changes (ward_id, change_id),
  FOREIGN KEY (ward_id, created_by_account_id) REFERENCES accounts (ward_id, account_id),
  FOREIGN KEY (ward_id, removed_by_account_id) REFERENCES accounts (ward_id, account_id)
);
INSERT INTO project_rows SELECT * FROM project_rows_c10_copy;
DROP TABLE project_rows_c10_copy;
CREATE UNIQUE INDEX project_rows_match ON project_rows (ward_id, project_id, table_key, scope, COALESCE(ref_year, 0), match_key)
  WHERE removed_at IS NULL;
