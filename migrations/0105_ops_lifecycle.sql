-- 束 1: 運用上の停止、ログイン試行、消去の処理待ち。
-- ward_id は区の ID。提供側のログイン試行だけは "provider" を使い、秘密を保存しない。

ALTER TABLE wards ADD COLUMN is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1));

CREATE TABLE login_attempts (
  ward_id TEXT NOT NULL,
  attempt_key TEXT NOT NULL,
  attempt_id TEXT NOT NULL,
  attempted_at TEXT NOT NULL,
  PRIMARY KEY (ward_id, attempt_key, attempt_id)
) WITHOUT ROWID;
CREATE INDEX login_attempts_recent ON login_attempts (ward_id, attempt_key, attempted_at);

CREATE TABLE ops_deletion_queue (
  queue_id TEXT PRIMARY KEY,
  ward_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('job', 'ward')),
  target_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'complete', 'error')),
  cursor TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK ((target_type = 'ward') OR target_id IS NOT NULL)
);
CREATE INDEX ops_deletion_queue_pending ON ops_deletion_queue (state, requested_at);

-- 完了後は対象を結びつける ID を残さず、処理済みの印だけを保つ。
CREATE TABLE ops_deletion_marks (
  mark_id TEXT PRIMARY KEY,
  ward_id TEXT NOT NULL,
  scope TEXT NOT NULL CHECK (scope IN ('record', 'ward')),
  deleted_at TEXT NOT NULL
);
CREATE INDEX ops_deletion_marks_ward ON ops_deletion_marks (ward_id, deleted_at);
