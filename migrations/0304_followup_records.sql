-- 束 3: 問い合わせ、行政の依頼、年ごとの帳簿。
CREATE TABLE inquiry_records (
  inquiry_id TEXT PRIMARY KEY,
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  received_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('inquiry', 'request')),
  subject TEXT NOT NULL,
  answer TEXT NOT NULL,
  submitted_to_city INTEGER NOT NULL DEFAULT 0 CHECK (submitted_to_city IN (0, 1)),
  created_by_account_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (ward_id, created_by_account_id) REFERENCES accounts (ward_id, account_id),
  UNIQUE (ward_id, inquiry_id)
) WITHOUT ROWID;
CREATE INDEX inquiry_records_recent ON inquiry_records (ward_id, kind, received_at DESC);

CREATE TABLE city_request_details (
  ward_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  due_on TEXT,
  answer_draft TEXT NOT NULL DEFAULT '',
  submitted_what TEXT NOT NULL DEFAULT '',
  submitted_to TEXT NOT NULL DEFAULT '',
  submitted_on TEXT,
  notice_body TEXT NOT NULL DEFAULT '',
  notice_sent_at TEXT,
  updated_at TEXT NOT NULL,
  updated_by_account_id TEXT NOT NULL,
  PRIMARY KEY (ward_id, project_id),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id),
  FOREIGN KEY (ward_id, updated_by_account_id) REFERENCES accounts (ward_id, account_id)
) WITHOUT ROWID;

CREATE TABLE ward_annual_budgets (
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  year INTEGER NOT NULL CHECK (year BETWEEN 2000 AND 2100),
  budget_income INTEGER NOT NULL DEFAULT 0 CHECK (budget_income >= 0),
  budget_expense INTEGER NOT NULL DEFAULT 0 CHECK (budget_expense >= 0),
  settlement_draft TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL,
  updated_by_account_id TEXT NOT NULL,
  PRIMARY KEY (ward_id, year),
  FOREIGN KEY (ward_id, updated_by_account_id) REFERENCES accounts (ward_id, account_id)
) WITHOUT ROWID;
