-- 束 2: 原本の同じ物判定を、受け箱またはプロジェクトの中に限定する。
-- 既存原本の判定範囲は、紐づく入った物のプロジェクトに合わせる。
ALTER TABLE originals ADD COLUMN dedupe_scope TEXT NOT NULL DEFAULT '';

UPDATE originals
   SET dedupe_scope = COALESCE(
     (SELECT project_id FROM jobs
       WHERE jobs.ward_id = originals.ward_id AND jobs.job_id = originals.job_id),
     ''
   );

DROP INDEX originals_hash_active;
CREATE UNIQUE INDEX originals_hash_active
  ON originals (ward_id, dedupe_scope, content_hash)
  WHERE withdrawn_at IS NULL;
