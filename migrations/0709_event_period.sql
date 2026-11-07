-- 実施を始まる日と終わる日で持つ。既存の日付と更新の記録をそのまま移す。
CREATE TABLE project_deadlines_next (
  ward_id               TEXT NOT NULL REFERENCES wards (ward_id),
  project_id            TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('event_day', 'event_end', 'answer_due', 'submit_due', 'board_meeting_day')),
  due_on                TEXT NOT NULL CHECK (due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by_account_id TEXT,
  PRIMARY KEY (ward_id, project_id, kind),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id),
  FOREIGN KEY (ward_id, updated_by_account_id) REFERENCES accounts (ward_id, account_id)
) WITHOUT ROWID;

INSERT INTO project_deadlines_next (ward_id, project_id, kind, due_on, updated_at, updated_by_account_id)
SELECT ward_id, project_id, kind, due_on, updated_at, updated_by_account_id FROM project_deadlines;

INSERT INTO project_deadlines_next (ward_id, project_id, kind, due_on, updated_at, updated_by_account_id)
SELECT ward_id, project_id, 'event_end', due_on, updated_at, updated_by_account_id
FROM project_deadlines WHERE kind = 'event_day';

DROP TABLE project_deadlines;
ALTER TABLE project_deadlines_next RENAME TO project_deadlines;
