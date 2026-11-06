-- 配った紙の題は、後の行事名の変更から分けて保存する。
ALTER TABLE document_versions ADD COLUMN project_title TEXT;
