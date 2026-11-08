-- L-317: 返事で聞く欄を、準備ごとに役員が足し外しできるようにする。
-- 型は三つ。days 日を選ぶ（候補の日を並べ、一つまたは複数を選ぶ）、district 班、text 自由に書く（短い文）。
-- 一つの定義から Web の返事と紙の回答票の両方に出す（前提 3）。
-- 班は、行が無ければ班の名前がある自治会で聞く（今までどおり）。外した時は removed_at を入れた行を残す。
CREATE TABLE project_answer_fields (
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  project_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('days', 'district', 'text')),
  label TEXT NOT NULL,
  -- 選ぶ物（JSON の文字列の配列）。日を選ぶ欄だけが使う。
  options TEXT NOT NULL DEFAULT '[]',
  -- 1 ならいくつでも選べる。0 なら一つだけ。
  multiple INTEGER NOT NULL DEFAULT 1 CHECK (multiple IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  created_by_account_id TEXT,
  removed_at TEXT,
  PRIMARY KEY (ward_id, field_id),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id)
);
CREATE INDEX project_answer_fields_project ON project_answer_fields (ward_id, project_id, sort_order);

-- 足した欄への答え（JSON。欄の番号ごとに、文字列か文字列の配列）。足す前の返事は空のまま数える。
ALTER TABLE project_answers ADD COLUMN field_values TEXT NOT NULL DEFAULT '{}';
