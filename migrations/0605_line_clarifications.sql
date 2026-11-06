-- 写真の短い確認と、写真が来た場所への質問。受付や配布を待たせない。
CREATE TABLE intake_photo_checks (
  ward_id TEXT NOT NULL,
  original_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  readability TEXT NOT NULL CHECK (readability IN ('readable', 'partial', 'unreadable', 'unknown')),
  paper_kind TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY (ward_id, original_id),
  FOREIGN KEY (ward_id, original_id) REFERENCES originals (ward_id, original_id) ON DELETE CASCADE,
  FOREIGN KEY (ward_id, job_id) REFERENCES jobs (ward_id, job_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE line_photo_batches (
  ward_id TEXT NOT NULL REFERENCES wards (ward_id) ON DELETE CASCADE,
  batch_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('user', 'group', 'room')),
  source_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  image_set_id TEXT,
  expected_count INTEGER,
  created_at TEXT NOT NULL,
  last_received_at TEXT NOT NULL,
  reply_token TEXT,
  reply_at TEXT,
  quick_replied INTEGER NOT NULL DEFAULT 0,
  quick_message_id TEXT,
  quick_sent_at TEXT,
  prepared_at TEXT,
  message_text TEXT,
  send_claimed_at TEXT,
  sent_at TEXT,
  sent_message_id TEXT,
  send_method TEXT,
  push_recipients INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ward_id, batch_id)
) WITHOUT ROWID;
CREATE INDEX line_photo_batches_source ON line_photo_batches (ward_id, destination, source_type, source_id, sender_id, last_received_at);

CREATE TABLE line_photo_items (
  ward_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  image_index INTEGER,
  quote_token TEXT,
  PRIMARY KEY (ward_id, job_id),
  FOREIGN KEY (ward_id, batch_id) REFERENCES line_photo_batches (ward_id, batch_id) ON DELETE CASCADE,
  FOREIGN KEY (ward_id, job_id) REFERENCES jobs (ward_id, job_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE line_clarifications (
  ward_id TEXT NOT NULL,
  clarification_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  original_id TEXT NOT NULL,
  topic TEXT NOT NULL CHECK (topic IN ('unreadable', 'year', 'project')),
  text TEXT NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  question_id TEXT,
  sent_at TEXT,
  answer TEXT,
  PRIMARY KEY (ward_id, clarification_id),
  FOREIGN KEY (ward_id, batch_id) REFERENCES line_photo_batches (ward_id, batch_id) ON DELETE CASCADE,
  FOREIGN KEY (ward_id, job_id) REFERENCES jobs (ward_id, job_id) ON DELETE CASCADE,
  FOREIGN KEY (ward_id, original_id) REFERENCES originals (ward_id, original_id) ON DELETE CASCADE,
  FOREIGN KEY (ward_id, question_id) REFERENCES project_questions (ward_id, question_id) ON DELETE CASCADE
) WITHOUT ROWID;

CREATE TABLE line_clarification_answers (
  ward_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  clarification_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  answer_text TEXT NOT NULL,
  sender_label TEXT NOT NULL,
  PRIMARY KEY (ward_id, event_id, clarification_id),
  FOREIGN KEY (ward_id, clarification_id) REFERENCES line_clarifications (ward_id, clarification_id) ON DELETE CASCADE,
  FOREIGN KEY (ward_id, job_id) REFERENCES jobs (ward_id, job_id) ON DELETE CASCADE
) WITHOUT ROWID;

-- LINE からの問い合わせには、役員の入力者を作らない。
CREATE TABLE inquiry_records_next (
  inquiry_id TEXT PRIMARY KEY,
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  received_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('inquiry', 'request')),
  subject TEXT NOT NULL,
  answer TEXT NOT NULL,
  submitted_to_city INTEGER NOT NULL DEFAULT 0 CHECK (submitted_to_city IN (0, 1)),
  created_by_account_id TEXT,
  created_at TEXT NOT NULL,
  line_event_id TEXT,
  line_source_type TEXT,
  line_source_id TEXT,
  line_sender_label TEXT,
  line_replied_at TEXT,
  FOREIGN KEY (ward_id, created_by_account_id) REFERENCES accounts (ward_id, account_id),
  UNIQUE (ward_id, inquiry_id),
  UNIQUE (ward_id, line_event_id)
) WITHOUT ROWID;
INSERT INTO inquiry_records_next (inquiry_id, ward_id, received_at, kind, subject, answer, submitted_to_city, created_by_account_id, created_at)
  SELECT inquiry_id, ward_id, received_at, kind, subject, answer, submitted_to_city, created_by_account_id, created_at FROM inquiry_records;
DROP TABLE inquiry_records;
ALTER TABLE inquiry_records_next RENAME TO inquiry_records;
CREATE INDEX inquiry_records_recent ON inquiry_records (ward_id, kind, received_at DESC);
