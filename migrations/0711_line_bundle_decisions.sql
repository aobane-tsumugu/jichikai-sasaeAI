-- トークのまとまりごとに、話の一行と扱い方を持つ。LINEのIDは保存しない。
CREATE TABLE line_bundle_decisions (
  ward_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('material', 'reference', 'inquiry', 'know', 'unrelated', 'confirm_share', 'confirm_purpose')),
  project_id TEXT,
  decided_by TEXT NOT NULL CHECK (decided_by IN ('ai', 'officer')),
  clarification_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  PRIMARY KEY (ward_id, bundle_id),
  FOREIGN KEY (ward_id) REFERENCES wards (ward_id) ON DELETE CASCADE
);
