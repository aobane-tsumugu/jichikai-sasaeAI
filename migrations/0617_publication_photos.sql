-- 提供側が品質を確かめて区ごとに有効にする。既定で有効な区は無い。
CREATE TABLE IF NOT EXISTS ward_photo_policy (
  ward_id TEXT PRIMARY KEY REFERENCES wards(ward_id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK(enabled IN (0, 1)),
  revision TEXT NOT NULL,
  author_approved_at TEXT,
  quality_report_sha256 TEXT NOT NULL,
  model_sha256 TEXT NOT NULL,
  profile TEXT NOT NULL,
  updated_by_provider TEXT NOT NULL
);

-- 作り直せる画像はD1内に限定し、別のR2消去経路を増やさない。
CREATE TABLE IF NOT EXISTS publication_photos (
  ward_id TEXT NOT NULL REFERENCES wards(ward_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  original_id TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK(length(source_hash) = 64),
  masked_hash TEXT NOT NULL CHECK(length(masked_hash) = 64),
  masked_png TEXT NOT NULL CHECK(length(masked_png) BETWEEN 1 AND 800000),
  width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 1280),
  height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 1280),
  faces INTEGER NOT NULL CHECK(faces BETWEEN 0 AND 1999),
  model_sha256 TEXT NOT NULL,
  profile TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  PRIMARY KEY(ward_id, photo_id),
  UNIQUE(ward_id, publication_id, original_id),
  FOREIGN KEY(ward_id, original_id) REFERENCES originals(ward_id, original_id) ON DELETE CASCADE,
  FOREIGN KEY(ward_id, project_id) REFERENCES projects(ward_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY(ward_id, publication_id) REFERENCES publication_records(ward_id, publication_id) ON DELETE CASCADE
);

-- PR #62の0615が先に入っている場合も、配った写しを保ちながら顔を隠さない選択に対応する。
DROP TRIGGER IF EXISTS publication_photos_check;
DROP TRIGGER IF EXISTS publication_photos_original_change;
DROP TRIGGER IF EXISTS publication_photos_job_change;
DROP TRIGGER IF EXISTS publication_photos_lower;
DROP TRIGGER IF EXISTS publication_photos_policy_change;
DROP TRIGGER IF EXISTS publication_photos_policy_delete;
CREATE TABLE publication_photos_u34 (
  ward_id TEXT NOT NULL REFERENCES wards(ward_id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  publication_id TEXT NOT NULL,
  photo_id TEXT NOT NULL,
  original_id TEXT NOT NULL,
  source_hash TEXT NOT NULL CHECK(length(source_hash) = 64),
  masked_hash TEXT NOT NULL CHECK(length(masked_hash) = 64),
  masked_png TEXT NOT NULL CHECK(length(masked_png) BETWEEN 1 AND 800000),
  width INTEGER NOT NULL CHECK(width BETWEEN 1 AND 1280),
  height INTEGER NOT NULL CHECK(height BETWEEN 1 AND 1280),
  faces INTEGER NOT NULL CHECK(faces BETWEEN 0 AND 1999),
  model_sha256 TEXT NOT NULL,
  profile TEXT NOT NULL,
  policy_revision TEXT NOT NULL,
  PRIMARY KEY(ward_id, photo_id),
  UNIQUE(ward_id, publication_id, original_id),
  FOREIGN KEY(ward_id, original_id) REFERENCES originals(ward_id, original_id) ON DELETE CASCADE,
  FOREIGN KEY(ward_id, project_id) REFERENCES projects(ward_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY(ward_id, publication_id) REFERENCES publication_records(ward_id, publication_id) ON DELETE CASCADE
);
INSERT INTO publication_photos_u34 SELECT * FROM publication_photos;
DROP TABLE publication_photos;
ALTER TABLE publication_photos_u34 RENAME TO publication_photos;

CREATE TRIGGER publication_photos_check BEFORE INSERT ON publication_photos BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
    JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id
    JOIN publication_records r ON r.ward_id = p.ward_id AND r.project_id = p.project_id
    JOIN document_versions v ON v.ward_id = r.ward_id AND v.version_id = r.version_id AND v.project_id = r.project_id
    JOIN ward_photo_policy s ON s.ward_id = p.ward_id
    WHERE o.ward_id = NEW.ward_id AND o.original_id = NEW.original_id AND o.content_hash = NEW.source_hash
      AND j.project_id = NEW.project_id AND r.publication_id = NEW.publication_id
      AND o.media_type IN ('image/jpeg', 'image/png') AND o.withdrawn_at IS NULL AND o.r2_path IS NOT NULL AND j.withdrawn_at IS NULL
      AND v.scope = 'public' AND v.published_at IS NOT NULL AND r.unpublished_at IS NULL
      AND s.enabled = 1 AND s.author_approved_at IS NOT NULL AND length(s.quality_report_sha256) = 64
      AND s.revision = NEW.policy_revision AND s.model_sha256 = NEW.model_sha256 AND s.profile = NEW.profile
  ) THEN RAISE(ABORT, 'photo_source_or_policy_changed') END;
END;

-- 通常の取り下げ・消去がそのまま派生にも効く。失効した画像を残さない。
CREATE TRIGGER publication_photos_original_change AFTER UPDATE OF withdrawn_at, r2_path, content_hash ON originals BEGIN
  DELETE FROM publication_photos WHERE ward_id = NEW.ward_id AND original_id = NEW.original_id;
END;
CREATE TRIGGER publication_photos_job_change AFTER UPDATE OF withdrawn_at, project_id ON jobs BEGIN
  DELETE FROM publication_photos WHERE ward_id = NEW.ward_id AND original_id IN
    (SELECT original_id FROM originals WHERE ward_id = NEW.ward_id AND job_id = NEW.job_id);
END;
CREATE TRIGGER publication_photos_lower AFTER UPDATE OF unpublished_at ON publication_records
WHEN NEW.unpublished_at IS NOT NULL BEGIN
  DELETE FROM publication_photos WHERE ward_id = NEW.ward_id AND publication_id = NEW.publication_id;
END;
CREATE TRIGGER publication_photos_policy_change AFTER UPDATE ON ward_photo_policy BEGIN
  DELETE FROM publication_photos WHERE ward_id = NEW.ward_id;
END;
CREATE TRIGGER publication_photos_policy_delete AFTER DELETE ON ward_photo_policy BEGIN
  DELETE FROM publication_photos WHERE ward_id = OLD.ward_id;
END;

-- 選択と手直しの記録。画像は作り直せるので日次の写しへ入れない。
CREATE TABLE report_photo_drafts (
  ward_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  original_id TEXT NOT NULL,
  revision TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('processing', 'ready', 'failed')),
  mode TEXT NOT NULL CHECK(mode IN ('auto', 'manual', 'none')),
  masks TEXT NOT NULL DEFAULT '[]',
  prepared TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY(ward_id, project_id, original_id),
  FOREIGN KEY(ward_id, project_id) REFERENCES projects(ward_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY(ward_id, original_id) REFERENCES originals(ward_id, original_id) ON DELETE CASCADE
);
CREATE TRIGGER report_photo_original_change AFTER UPDATE OF withdrawn_at, r2_path, content_hash ON originals BEGIN
  DELETE FROM report_photo_drafts WHERE ward_id = NEW.ward_id AND original_id = NEW.original_id;
END;
CREATE TRIGGER report_photo_job_change AFTER UPDATE OF withdrawn_at, project_id ON jobs BEGIN
  DELETE FROM report_photo_drafts WHERE ward_id = NEW.ward_id AND original_id IN
    (SELECT original_id FROM originals WHERE ward_id = NEW.ward_id AND job_id = NEW.job_id);
END;
CREATE TRIGGER report_photo_policy_change AFTER UPDATE ON ward_photo_policy BEGIN
  DELETE FROM report_photo_drafts WHERE ward_id = NEW.ward_id;
END;

