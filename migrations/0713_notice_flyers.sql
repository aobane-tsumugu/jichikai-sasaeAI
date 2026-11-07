-- 役員が選んだチラシと、付けないという選択を文書ごとに残す。
-- 公開の可否はpublication_recordsで調べ、元の資料のパスは公開しない。
CREATE TABLE notice_flyers (
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  project_id TEXT NOT NULL,
  version_id TEXT NOT NULL,
  flyer_id TEXT,
  r2_path TEXT,
  preview_r2_path TEXT,
  PRIMARY KEY (ward_id, version_id),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (ward_id, version_id) REFERENCES document_versions (ward_id, version_id) ON DELETE CASCADE,
  CHECK ((flyer_id IS NULL AND r2_path IS NULL AND preview_r2_path IS NULL)
    OR (flyer_id IS NOT NULL AND r2_path IS NOT NULL AND preview_r2_path IS NOT NULL))
) WITHOUT ROWID;
