-- 消去済みのAI処理を再び選ばず、古い実行も後始末できるようにする。
ALTER TABLE job_runs ADD COLUMN session_deleted_at TEXT;
UPDATE job_runs SET session_deleted_at = (
  SELECT j.session_deleted_at FROM jobs j WHERE j.ward_id = job_runs.ward_id
    AND j.job_id = job_runs.job_id AND j.session_id = job_runs.session_id
) WHERE ward_id IS NOT NULL AND session_id <> '';

CREATE TABLE ops_deletion_queue_next (
  queue_id TEXT PRIMARY KEY,
  ward_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('job', 'ward', 'answer', 'project', 'inquiry', 'help_offer')),
  target_id TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'running', 'complete', 'error')),
  cursor TEXT,
  last_error TEXT NOT NULL DEFAULT '',
  requested_at TEXT NOT NULL,
  completed_at TEXT,
  CHECK ((target_type = 'ward') OR target_id IS NOT NULL)
);
INSERT INTO ops_deletion_queue_next
  (queue_id, ward_id, target_type, target_id, state, cursor, last_error, requested_at, completed_at)
  SELECT queue_id, ward_id, target_type, target_id, state, cursor, last_error, requested_at, completed_at
  FROM ops_deletion_queue WHERE ward_id IS NOT NULL;
DROP TABLE ops_deletion_queue;
ALTER TABLE ops_deletion_queue_next RENAME TO ops_deletion_queue;
CREATE INDEX ops_deletion_queue_pending ON ops_deletion_queue (state, requested_at);
ALTER TABLE ops_deletion_marks ADD COLUMN target_type TEXT;
ALTER TABLE ops_deletion_marks ADD COLUMN target_id TEXT;

-- 現在の記録を消すのと同じ書き込みで、過去の写しの消去を引き受ける。
CREATE TRIGGER withdrawn_job_deletion AFTER UPDATE OF withdrawn_at ON jobs
WHEN OLD.withdrawn_at IS NULL AND NEW.withdrawn_at IS NOT NULL
  AND EXISTS (SELECT 1 FROM wards WHERE ward_id = NEW.ward_id AND is_active = 1)
BEGIN
  INSERT INTO ops_deletion_queue (queue_id, ward_id, target_type, target_id, requested_at)
  SELECT lower(hex(randomblob(16))), NEW.ward_id, 'job', NEW.job_id, NEW.withdrawn_at
  WHERE NOT EXISTS (SELECT 1 FROM ops_deletion_queue WHERE ward_id = NEW.ward_id
    AND target_type IN ('ward', 'project', 'job')
    AND (target_type = 'ward' OR (target_type = 'project' AND target_id = NEW.project_id)
      OR (target_type = 'job' AND target_id = NEW.job_id)));
END;
CREATE TRIGGER inquiry_record_deletion AFTER DELETE ON inquiry_records
WHEN EXISTS (SELECT 1 FROM wards WHERE ward_id = OLD.ward_id AND is_active = 1)
BEGIN
  INSERT INTO ops_deletion_queue (queue_id, ward_id, target_type, target_id, requested_at)
  VALUES (lower(hex(randomblob(16))), OLD.ward_id, 'inquiry', OLD.inquiry_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
CREATE TRIGGER help_offer_deletion AFTER DELETE ON project_help_offers
WHEN EXISTS (SELECT 1 FROM wards WHERE ward_id = OLD.ward_id AND is_active = 1)
  AND NOT EXISTS (SELECT 1 FROM ops_deletion_queue WHERE ward_id = OLD.ward_id
    AND (target_type = 'ward' OR (target_type = 'project' AND target_id = OLD.project_id)))
BEGIN
  INSERT INTO ops_deletion_queue (queue_id, ward_id, target_type, target_id, requested_at)
  VALUES (lower(hex(randomblob(16))), OLD.ward_id, 'help_offer', OLD.offer_id, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'));
END;
INSERT INTO ops_deletion_queue (queue_id, ward_id, target_type, target_id, requested_at)
SELECT lower(hex(randomblob(16))), j.ward_id, 'job', j.job_id, j.withdrawn_at FROM jobs j
WHERE j.ward_id IS NOT NULL AND j.withdrawn_at IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM ops_deletion_queue q WHERE q.ward_id = j.ward_id AND q.target_type = 'job' AND q.target_id = j.job_id);
