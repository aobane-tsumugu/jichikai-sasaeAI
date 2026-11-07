-- 役員の画面の一回の送信も、LINEと同じ境目の直し方で扱う。
CREATE TABLE line_talk_admin_topics (
  ward_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  PRIMARY KEY (ward_id, job_id),
  FOREIGN KEY (ward_id, job_id) REFERENCES jobs (ward_id, job_id) ON DELETE CASCADE
);

-- 直す前の内容。原本は複製せず、同じトークで最後に行った直しだけを戻せる。
CREATE TABLE line_talk_undo (
  ward_id TEXT NOT NULL REFERENCES wards (ward_id) ON DELETE CASCADE,
  talk_id TEXT NOT NULL,
  undo_id TEXT NOT NULL,
  body TEXT NOT NULL,
  PRIMARY KEY (ward_id, talk_id)
);

-- 問い合わせの言葉はAIで読む仕事を作らず、送られた時刻と文をそのまま残す。
CREATE TABLE line_talk_inquiry_posts (
  ward_id TEXT NOT NULL REFERENCES wards (ward_id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  bundle_id TEXT NOT NULL,
  destination TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  sender_name TEXT,
  received_at TEXT NOT NULL,
  text TEXT NOT NULL,
  PRIMARY KEY (ward_id, event_id)
);
CREATE INDEX line_talk_inquiry_bundle ON line_talk_inquiry_posts (ward_id, bundle_id);
