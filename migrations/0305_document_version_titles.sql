-- 題も本文と同じ文書の記録に残し、下書きの題を直しても配った物の題を変えない。
ALTER TABLE document_versions ADD COLUMN title TEXT;

-- 既存の題は、移行時点で文書に残っている題を引き継ぐ。
UPDATE document_versions
SET title = (
  SELECT d.title FROM documents d
  WHERE d.ward_id = document_versions.ward_id AND d.document_id = document_versions.document_id
);
