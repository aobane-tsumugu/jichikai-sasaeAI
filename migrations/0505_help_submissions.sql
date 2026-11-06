-- 別の人の同名の申込みを分け、同じフォームの再送だけをまとめる。
ALTER TABLE project_help_offers ADD COLUMN submission_id TEXT;
CREATE UNIQUE INDEX project_help_offers_submission
  ON project_help_offers (ward_id, project_id, submission_id) WHERE submission_id IS NOT NULL;
