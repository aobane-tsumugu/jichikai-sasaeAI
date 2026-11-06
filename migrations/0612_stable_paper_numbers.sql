-- U26: 移行時の並びを紙の番号として残す。消した番号は使い直さない。
ALTER TABLE wards ADD COLUMN paper_project_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE projects ADD COLUMN paper_no INTEGER;
ALTER TABLE projects ADD COLUMN paper_document_seq INTEGER NOT NULL DEFAULT 0;
ALTER TABLE documents ADD COLUMN paper_no INTEGER;

UPDATE projects SET paper_no = (
  SELECT COUNT(*) FROM projects AS older
  WHERE older.ward_id = projects.ward_id
    AND (older.created_at < projects.created_at
      OR (older.created_at = projects.created_at AND older.project_id <= projects.project_id))
);
UPDATE wards SET paper_project_seq = (
  SELECT COALESCE(MAX(paper_no), 0) FROM projects WHERE projects.ward_id = wards.ward_id
);
UPDATE documents SET paper_no = (
  SELECT COUNT(*) FROM documents AS older
  WHERE older.ward_id = documents.ward_id AND older.project_id = documents.project_id
    AND (older.created_at < documents.created_at
      OR (older.created_at = documents.created_at AND older.document_id <= documents.document_id))
);
UPDATE projects SET paper_document_seq = (
  SELECT COALESCE(MAX(paper_no), 0) FROM documents
  WHERE documents.ward_id = projects.ward_id AND documents.project_id = projects.project_id
);
CREATE UNIQUE INDEX projects_paper_no ON projects (ward_id, paper_no);
CREATE UNIQUE INDEX documents_paper_no ON documents (ward_id, project_id, paper_no);

-- 採番と作成を同じ書き込みで行う。区・行事に最後の番号を残す。
CREATE TRIGGER projects_assign_paper_no AFTER INSERT ON projects
WHEN NEW.paper_no IS NULL
BEGIN
  UPDATE wards SET paper_project_seq = paper_project_seq + 1 WHERE ward_id = NEW.ward_id;
  UPDATE projects SET paper_no = (SELECT paper_project_seq FROM wards WHERE ward_id = NEW.ward_id)
    WHERE ward_id = NEW.ward_id AND project_id = NEW.project_id;
END;
CREATE TRIGGER documents_assign_paper_no AFTER INSERT ON documents
WHEN NEW.paper_no IS NULL
BEGIN
  UPDATE projects SET paper_document_seq = paper_document_seq + 1
    WHERE ward_id = NEW.ward_id AND project_id = NEW.project_id;
  UPDATE documents SET paper_no = (SELECT paper_document_seq FROM projects
      WHERE ward_id = NEW.ward_id AND project_id = NEW.project_id)
    WHERE ward_id = NEW.ward_id AND project_id = NEW.project_id AND document_id = NEW.document_id;
END;
