-- U91: 準備に結び付かない連絡事項を、自治会の年ごとに一つの入れ物に保存する。
ALTER TABLE projects ADD COLUMN is_ward_notices INTEGER NOT NULL DEFAULT 0 CHECK (is_ward_notices IN (0, 1));
CREATE UNIQUE INDEX projects_ward_notices_year ON projects (ward_id, year) WHERE is_ward_notices = 1;

-- 入れ物は閉じないので、住民に知らせたときに記録の検索へ残す。
CREATE TRIGGER archive_index_ward_notice AFTER UPDATE OF published_at ON document_versions
WHEN old.published_at IS NULL AND new.published_at IS NOT NULL AND new.scope = 'public'
BEGIN
  INSERT INTO archive_search_entries (ward_id, project_id, record_type, year, locator, content, created_at)
  SELECT p.ward_id, p.project_id, 'decision', p.year, '住民への連絡', new.body, new.published_at
    FROM projects p JOIN documents d ON d.ward_id = p.ward_id AND d.project_id = p.project_id
   WHERE p.ward_id = new.ward_id AND p.project_id = new.project_id AND p.is_ward_notices = 1
     AND d.document_id = new.document_id AND d.kind = 'notice';
END;
