-- 束 1: Web と電話で受けた回答を消す求めを、日次の写しの書き直しまで列で続ける。
CREATE TABLE ops_deletion_queue_next (
  queue_id TEXT PRIMARY KEY,
  ward_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('job', 'ward', 'answer')),
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
