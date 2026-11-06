-- 総会の答えは人数と分けて持つ。空の委任先を議長に置き換えない。
ALTER TABLE project_answers ADD COLUMN meeting_status TEXT
  CHECK (meeting_status IS NULL OR meeting_status IN ('attend', 'proxy', 'absent'));
ALTER TABLE project_answers ADD COLUMN proxy_name TEXT;
