-- 束 2: 一枚の紙の欄を、印字符号ごとに別のプロジェクトへ渡す。
ALTER TABLE jobs ADD COLUMN paper_source_job_id TEXT;
CREATE UNIQUE INDEX jobs_paper_source_project ON jobs (ward_id, paper_source_job_id, project_id)
  WHERE paper_source_job_id IS NOT NULL;

CREATE TABLE paper_reading_slices (
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  job_id TEXT NOT NULL,
  source_job_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (ward_id, job_id),
  FOREIGN KEY (ward_id, job_id) REFERENCES jobs (ward_id, job_id),
  FOREIGN KEY (ward_id, source_job_id) REFERENCES jobs (ward_id, job_id)
);
CREATE INDEX paper_reading_slices_source ON paper_reading_slices (ward_id, source_job_id);
