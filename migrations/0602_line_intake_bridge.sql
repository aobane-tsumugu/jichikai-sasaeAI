-- 束 6: 受け箱は束 2 の入った物を参照し、別の原本を持たない。
ALTER TABLE line_inbox_items ADD COLUMN job_id TEXT;
CREATE UNIQUE INDEX line_inbox_items_job ON line_inbox_items (ward_id, job_id) WHERE job_id IS NOT NULL;
DROP TABLE line_inbox_projects;
