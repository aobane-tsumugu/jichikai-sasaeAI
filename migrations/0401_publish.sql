-- 束 4: 配った版、配布先と部数、公式 LINE の送信結果。
-- 文書の本文は document_versions に残す。ここには配布の記録だけを足す。
CREATE TABLE publication_records (
  ward_id          TEXT NOT NULL REFERENCES wards (ward_id),
  publication_id   TEXT NOT NULL,
  project_id       TEXT NOT NULL,
  document_id      TEXT NOT NULL,
  version_id       TEXT NOT NULL,
  version_no       INTEGER NOT NULL CHECK (version_no >= 1),
  recipient_scope  TEXT NOT NULL DEFAULT 'member_households' CHECK (recipient_scope IN ('member_households', 'all_households')),
  distribution     TEXT NOT NULL DEFAULT '{}',
  line_status      TEXT NOT NULL CHECK (line_status IN ('pending', 'sent', 'failed', 'not_configured')),
  line_recipients  INTEGER,
  line_sent_at     TEXT,
  line_error       TEXT,
  published_at     TEXT NOT NULL,
  unpublished_at   TEXT,
  published_by_account_id TEXT NOT NULL,
  UNIQUE (ward_id, publication_id),
  UNIQUE (ward_id, document_id, version_no),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id),
  FOREIGN KEY (ward_id, document_id) REFERENCES documents (ward_id, document_id),
  FOREIGN KEY (ward_id, version_id) REFERENCES document_versions (ward_id, version_id),
  FOREIGN KEY (ward_id, published_by_account_id) REFERENCES accounts (ward_id, account_id)
);
CREATE INDEX publication_records_project ON publication_records (ward_id, project_id, published_at);
