-- 同じWeb送信の再処理だけを識別する。名前で答えをまとめない。
CREATE TABLE project_answer_submissions (
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  project_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  -- 答えを削除したあとも再送で復活させないため、このIDへの外部キーは付けない。
  -- 名前、人数、答えの本文はここに残さない。
  answer_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (ward_id, project_id, submission_id),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id) ON DELETE CASCADE
) WITHOUT ROWID;
