-- 束 1: プロジェクトも既存の消す列で続きから消す。
CREATE TABLE ops_deletion_queue_next (
  queue_id TEXT PRIMARY KEY,
  ward_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('job', 'ward', 'answer', 'project')),
  target_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'complete', 'error')),
  cursor TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK ((target_type = 'ward') OR target_id IS NOT NULL)
);
INSERT INTO ops_deletion_queue_next SELECT * FROM ops_deletion_queue;
DROP TABLE ops_deletion_queue;
ALTER TABLE ops_deletion_queue_next RENAME TO ops_deletion_queue;
CREATE INDEX ops_deletion_queue_pending ON ops_deletion_queue (state, requested_at);
