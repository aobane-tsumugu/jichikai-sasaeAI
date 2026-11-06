-- U64: 提出したときの本文と、要望を進める仕事へのつながりを残す。
-- 既存の表に置き、区の写し・書き出し・消去の対象を保つ。
ALTER TABLE city_request_details ADD COLUMN submission_history TEXT NOT NULL DEFAULT '[]';
ALTER TABLE inquiry_records ADD COLUMN request_project_id TEXT;

-- 以前の専用画面の下書きは、共通の回答がない場合だけ引き継ぐ。
-- 提出した本文だったとは判断しない。既存の共通の回答も変えない。
INSERT INTO documents (document_id, ward_id, project_id, kind, title, scope)
SELECT lower(hex(randomblob(16))), c.ward_id, c.project_id, 'report', '提出する回答', 'staff'
FROM city_request_details c
WHERE c.ward_id IS NOT NULL AND c.answer_draft <> '' AND NOT EXISTS (
  SELECT 1 FROM documents d WHERE d.ward_id = c.ward_id AND d.project_id = c.project_id AND d.kind = 'report'
);
INSERT INTO document_versions (version_id, ward_id, project_id, document_id, version_no, scope, body, based_on_state_version, origin, created_at, created_by_account_id, title)
SELECT lower(hex(randomblob(16))), c.ward_id, c.project_id, d.document_id, 1, 'staff',
  json_object('text', c.answer_draft, 'items', json('[]')), p.state_version, 'person', c.updated_at, c.updated_by_account_id, '提出する回答'
FROM city_request_details c JOIN projects p ON p.ward_id = c.ward_id AND p.project_id = c.project_id
JOIN documents d ON d.ward_id = c.ward_id AND d.project_id = c.project_id AND d.kind = 'report'
WHERE c.ward_id IS NOT NULL AND c.answer_draft <> '' AND NOT EXISTS (
  SELECT 1 FROM document_versions v WHERE v.ward_id = d.ward_id AND v.document_id = d.document_id
);
