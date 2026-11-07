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

-- 本文は自由記述なので、作った時に参照できた原本を依存先として保つ。
-- 出どころを厳密に分けられない本文は、削除時に本文全体を伏せる。
ALTER TABLE document_versions ADD COLUMN source_original_ids TEXT NOT NULL DEFAULT '[]';
UPDATE document_versions SET source_original_ids = (SELECT json_group_array(o.original_id)
  FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
  WHERE o.ward_id = document_versions.ward_id AND (j.project_id = document_versions.project_id
    OR o.original_id IN (SELECT source_ref FROM project_rows WHERE ward_id = document_versions.ward_id AND project_id = document_versions.project_id
      UNION SELECT source_ref FROM project_item_values WHERE ward_id = document_versions.ward_id AND project_id = document_versions.project_id)))
WHERE ward_id IS NOT NULL;
CREATE TRIGGER document_original_sources_insert AFTER INSERT ON document_versions
BEGIN
  UPDATE document_versions SET source_original_ids = (SELECT json_group_array(original_id) FROM (
    SELECT value AS original_id FROM json_each(NEW.source_original_ids)
    UNION SELECT o.original_id FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
      WHERE o.ward_id = NEW.ward_id AND o.withdrawn_at IS NULL AND (j.project_id = NEW.project_id
        OR o.original_id IN (SELECT source_ref FROM project_rows WHERE ward_id = NEW.ward_id AND project_id = NEW.project_id
          UNION SELECT source_ref FROM project_item_values WHERE ward_id = NEW.ward_id AND project_id = NEW.project_id))))
  WHERE ward_id = NEW.ward_id AND version_id = NEW.version_id;
END;
CREATE TRIGGER document_original_sources_update AFTER UPDATE OF body ON document_versions
WHEN NEW.body <> OLD.body AND NEW.body <> '{"text":"消去の希望により、この内容を消しました。","items":[]}'
BEGIN
  UPDATE document_versions SET source_original_ids = (SELECT json_group_array(original_id) FROM (
    SELECT value AS original_id FROM json_each(NEW.source_original_ids)
    UNION SELECT o.original_id FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
      WHERE o.ward_id = NEW.ward_id AND o.withdrawn_at IS NULL AND (j.project_id = NEW.project_id
        OR o.original_id IN (SELECT source_ref FROM project_rows WHERE ward_id = NEW.ward_id AND project_id = NEW.project_id
          UNION SELECT source_ref FROM project_item_values WHERE ward_id = NEW.ward_id AND project_id = NEW.project_id))))
  WHERE ward_id = NEW.ward_id AND version_id = NEW.version_id;
END;

-- 既存の提出本文も、参照している本文から出どころを引き継ぐ。
UPDATE city_request_details SET submission_history = (
  SELECT json_group_array(json(CASE WHEN v.version_id IS NOT NULL
    THEN json_set(item.value, '$.sourceOriginalIds', json(v.source_original_ids)) ELSE item.value END))
  FROM json_each(city_request_details.submission_history) item
  LEFT JOIN document_versions v ON v.ward_id = city_request_details.ward_id
    AND v.version_id = json_extract(item.value, '$.versionId')
) WHERE ward_id IS NOT NULL;
