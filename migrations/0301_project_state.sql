-- 束 3 状態と地図と下書き: プロジェクトの状態（基本、項目、表の行、文書、問い、差分の記録）と地図の仕事。
--
-- 全ての表は ward_id を持つ。区の中の物を指す外部キーは (ward_id, 〇〇_id) の複合にする（0101 と同じ作法）。
-- 時刻は ISO 8601 UTC の文字列。ID は意味を持たない文字列。日付だけの列は JST の YYYY-MM-DD。
-- この migration は配った後に書き換えない。足す時は 0302 以降のファイルにする。
--
-- 原本（束 2）と答え（束 5）の表はまだ無いので、source_ref（原本の ID、答えの ID）は外部キーを付けない。
-- 束 2 と束 5 の表ができたら、0302 以降で足す。
--
-- 段階（材料、案、配った）の列は置かない（前提 13）。プロジェクトは開いているか閉じたか（closed_at）だけを持つ。
-- 確定の列も置かない（前提 12）。文書の版は、配った時に published_at が入ることで固まる。

-- プロジェクト。行事、総会、市の依頼、役員会、当番、要望の一つ。
CREATE TABLE projects (
  project_id            TEXT PRIMARY KEY,
  ward_id               TEXT NOT NULL REFERENCES wards (ward_id),
  kind                  TEXT NOT NULL CHECK (kind IN ('event', 'general_meeting', 'city_request', 'board_meeting', 'duty', 'request')),
  title                 TEXT NOT NULL,
  -- 行事の年（西暦）。今年の中身と参考の中身の分け目になる
  year                  INTEGER NOT NULL,
  -- 閉じた（凍結）時刻。空なら開いている。閉じたプロジェクトには差分を入れない
  closed_at             TEXT,
  closed_by_account_id  TEXT,
  -- 去年の地図を種にして開いた時の、元のプロジェクト
  seed_project_id       TEXT,
  -- 状態が変わるたびに 1 上がる。文書の「元にした状態の版」はこの値
  state_version         INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by_account_id TEXT,
  UNIQUE (ward_id, project_id),
  FOREIGN KEY (ward_id, closed_by_account_id) REFERENCES accounts (ward_id, account_id),
  FOREIGN KEY (ward_id, created_by_account_id) REFERENCES accounts (ward_id, account_id),
  FOREIGN KEY (ward_id, seed_project_id) REFERENCES projects (ward_id, project_id)
);
CREATE INDEX projects_open ON projects (ward_id, closed_at, year);

-- 期限群。行事の日、回答の締切、提出期限、役員会の日。プロジェクトに種類ごとに一つ。
CREATE TABLE project_deadlines (
  ward_id               TEXT NOT NULL REFERENCES wards (ward_id),
  project_id            TEXT NOT NULL,
  kind                  TEXT NOT NULL CHECK (kind IN ('event_day', 'answer_due', 'submit_due', 'board_meeting_day')),
  due_on                TEXT NOT NULL CHECK (due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by_account_id TEXT,
  PRIMARY KEY (ward_id, project_id, kind),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id),
  FOREIGN KEY (ward_id, updated_by_account_id) REFERENCES accounts (ward_id, account_id)
) WITHOUT ROWID;

-- 差分の記録。差分の手が書いた物の全部（捨てた物と食い違いも含む）の履歴。
-- dedupe_key は、原本の ID、包みの版、手の種類、書く対象から作った印。同じ印の二度目は保存した result をそのまま返し、
-- 同じ印で payload_hash が違えば拒否する（冪等）。
CREATE TABLE project_changes (
  change_id             TEXT PRIMARY KEY,
  ward_id               TEXT NOT NULL REFERENCES wards (ward_id),
  project_id            TEXT NOT NULL,
  -- 'item' 項目、'row' 表の行、'conflict' 食い違い、'stale' 古くなる文書、'map_task' 地図の仕事、
  -- 'unknown' 型の外の差分（捨てた物の記録のため。捨てたことを役員に見せる）
  kind                  TEXT NOT NULL CHECK (kind IN ('item', 'row', 'conflict', 'stale', 'map_task', 'unknown')),
  -- 書く対象（項目の名前、表の名前と相手など）
  target                TEXT NOT NULL,
  -- applied 入った、same 同じ物でした、kept 決まった中身があるので案は入れなかった、
  -- conflict 食い違いとして並べた、held 照合が曖昧で保留、dropped 出どころの検査で捨てた
  status                TEXT NOT NULL CHECK (status IN ('applied', 'same', 'kept', 'conflict', 'held', 'dropped')),
  reason                TEXT,
  dedupe_key            TEXT NOT NULL,
  payload_hash          TEXT NOT NULL,
  -- 受けた差分そのまま（JSON）。保留の差分を後で適用する時にも使う
  payload               TEXT NOT NULL,
  -- 結果（JSON）。同じ印の二度目に、そのまま返す
  result                TEXT NOT NULL,
  pack_version          TEXT NOT NULL,
  source_kind           TEXT,
  source_ref            TEXT,
  source_locator        TEXT,
  source_year           INTEGER,
  confidence            TEXT CHECK (confidence IN ('high', 'medium', 'low')),
  -- 列の記録（束 2）の札。外部キーは付けない
  ticket_id             TEXT,
  state_version_after   INTEGER,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by_account_id TEXT,
  UNIQUE (ward_id, change_id),
  UNIQUE (ward_id, project_id, dedupe_key),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id),
  FOREIGN KEY (ward_id, created_by_account_id) REFERENCES accounts (ward_id, account_id)
);
CREATE INDEX project_changes_recent ON project_changes (ward_id, project_id, created_at);

-- 項目の中身。日時、場所、雨天時、行事の中身、持ち物、手伝いの時間帯、締切、公開用の連絡先。
-- 項目の名前（item_key）の一覧は src/project/model.ts にある。
-- 今年の中身（scope = 'current'）は項目ごとに有効な一つ。参考の中身（scope = 'reference'）は、年ごと（年不明は一つ）に有効な一つ。
-- 入れ替わった物は消さず superseded_at を入れて残す（変わった所の履歴）。
-- 出どころ（source_*）と確かさ（confidence）が無い中身は存在しない。
CREATE TABLE project_item_values (
  value_id              TEXT PRIMARY KEY,
  ward_id               TEXT NOT NULL REFERENCES wards (ward_id),
  project_id            TEXT NOT NULL,
  item_key              TEXT NOT NULL,
  scope                 TEXT NOT NULL CHECK (scope IN ('current', 'reference')),
  -- 参考の中身の年。年不明は空。今年の中身は常に空
  ref_year              INTEGER,
  -- 書かれたまま（照合の時だけ正規化する）
  content               TEXT NOT NULL,
  -- original 原本、person 人の入力、web_answer Web の回答、ai_proposal AI の案
  source_kind           TEXT NOT NULL CHECK (source_kind IN ('original', 'person', 'web_answer', 'ai_proposal')),
  -- 原本の ID または答えの ID
  source_ref            TEXT,
  -- 原本の箇所（ページ、行、表のセル）
  source_locator        TEXT,
  -- 資料の年。AI の案では、参考にした年
  source_year           INTEGER,
  confidence            TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  change_id             TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by_account_id TEXT,
  superseded_at         TEXT,
  CHECK (scope = 'reference' OR ref_year IS NULL),
  UNIQUE (ward_id, value_id),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id),
  FOREIGN KEY (ward_id, change_id) REFERENCES project_changes (ward_id, change_id),
  FOREIGN KEY (ward_id, created_by_account_id) REFERENCES accounts (ward_id, account_id)
);
CREATE UNIQUE INDEX project_item_current ON project_item_values (ward_id, project_id, item_key)
  WHERE scope = 'current' AND superseded_at IS NULL;
CREATE UNIQUE INDEX project_item_reference ON project_item_values (ward_id, project_id, item_key, COALESCE(ref_year, 0))
  WHERE scope = 'reference' AND superseded_at IS NULL;

-- 表の行。協賛先、当番、配置、収支、決めたこと、提出した物。答えは束 5 の表で、ここには置かない。
-- 列の構成は表ごとに違うので data（JSON）に書かれたまま入れ、照合の鍵だけ match_key に正規化して持つ。
-- 表の名前（table_key）と列の一覧は src/project/model.ts にある。
-- 同じ相手（match_key が同じ）の行は、今年の中身では一つ、参考の中身では年ごとに一つ。更新は同じ行に重ねる。
-- 行ごとの更新の履歴は project_changes にある。person_fields は、人が入れた列の名前（AI の更新に負けない列）。
CREATE TABLE project_rows (
  row_id                TEXT PRIMARY KEY,
  ward_id               TEXT NOT NULL REFERENCES wards (ward_id),
  project_id            TEXT NOT NULL,
  table_key             TEXT NOT NULL CHECK (table_key IN ('sponsors', 'duties', 'layout', 'ledger', 'decisions', 'submissions')),
  scope                 TEXT NOT NULL CHECK (scope IN ('current', 'reference')),
  ref_year              INTEGER,
  match_key             TEXT NOT NULL,
  data                  TEXT NOT NULL,
  person_fields         TEXT NOT NULL DEFAULT '[]',
  source_kind           TEXT NOT NULL CHECK (source_kind IN ('original', 'person', 'web_answer', 'ai_proposal')),
  source_ref            TEXT,
  source_locator        TEXT,
  source_year           INTEGER,
  confidence            TEXT NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  change_id             TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by_account_id TEXT,
  removed_at            TEXT,
  removed_by_account_id TEXT,
  CHECK (scope = 'reference' OR ref_year IS NULL),
  UNIQUE (ward_id, row_id),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id),
  FOREIGN KEY (ward_id, change_id) REFERENCES project_changes (ward_id, change_id),
  FOREIGN KEY (ward_id, created_by_account_id) REFERENCES accounts (ward_id, account_id),
  FOREIGN KEY (ward_id, removed_by_account_id) REFERENCES accounts (ward_id, account_id)
);
CREATE UNIQUE INDEX project_rows_match ON project_rows (ward_id, project_id, table_key, scope, COALESCE(ref_year, 0), match_key)
  WHERE removed_at IS NULL;

-- 文書。案内、募集、当番表、進め方、知らせ、報告。初めて下書きを起こす時に作る。
-- scope は今の範囲の印（public 公開、space プロジェクトの空間、staff 役員）。
-- stale_since_version は、元にした状態の版より新しい差分が入った時の状態の版。空なら古くない。
-- 古い印が付いても、出した物（published_at の入った版）はそのまま残る。
CREATE TABLE documents (
  document_id         TEXT PRIMARY KEY,
  ward_id             TEXT NOT NULL REFERENCES wards (ward_id),
  project_id          TEXT NOT NULL,
  kind                TEXT NOT NULL CHECK (kind IN ('announcement', 'recruitment', 'duty_roster', 'procedure', 'notice', 'report')),
  title               TEXT NOT NULL,
  scope               TEXT NOT NULL CHECK (scope IN ('public', 'space', 'staff')),
  stale_since_version INTEGER,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (ward_id, document_id),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id)
);
-- 同じ種類の文書は、プロジェクトに一つずつ（知らせだけは変更のたびに別の文書を作ってよい）
CREATE UNIQUE INDEX documents_kind ON documents (ward_id, project_id, kind) WHERE kind <> 'notice';

-- 文書の版。起こし直しは新しい版で、古い版は残す。
-- body は JSON（文と項目の中身の並び。形は src/draft/ にある）。
-- based_on_state_version は、この版を起こした時のプロジェクトの状態の版。
-- published_at は、配る操作（束 4）が入れる。入った版の body と scope は書き換えない。
CREATE TABLE document_versions (
  version_id              TEXT PRIMARY KEY,
  ward_id                 TEXT NOT NULL REFERENCES wards (ward_id),
  project_id              TEXT NOT NULL,
  document_id             TEXT NOT NULL,
  version_no              INTEGER NOT NULL,
  scope                   TEXT NOT NULL CHECK (scope IN ('public', 'space', 'staff')),
  body                    TEXT NOT NULL,
  based_on_state_version  INTEGER NOT NULL,
  -- ai AI の下書き、person 役員が直した物
  origin                  TEXT NOT NULL CHECK (origin IN ('ai', 'person')),
  pack_version            TEXT,
  created_at              TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_by_account_id   TEXT,
  published_at            TEXT,
  published_by_account_id TEXT,
  UNIQUE (ward_id, version_id),
  UNIQUE (ward_id, document_id, version_no),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id),
  FOREIGN KEY (ward_id, document_id) REFERENCES documents (ward_id, document_id),
  FOREIGN KEY (ward_id, created_by_account_id) REFERENCES accounts (ward_id, account_id),
  FOREIGN KEY (ward_id, published_by_account_id) REFERENCES accounts (ward_id, account_id)
);

-- 問い。読めない所、今年決めること、地図の空き、食い違い、捨てた差分を、一つの一覧で持つ。
-- 役員は「答える」「分からない」「後で」から選ぶ。答えなくても配るのを止めない。
-- dedupe_key は差分と同じ作り（原本の ID、包みの版、手の種類、問いの文）。同じ問いが二度並ばない。
CREATE TABLE project_questions (
  question_id           TEXT PRIMARY KEY,
  ward_id               TEXT NOT NULL REFERENCES wards (ward_id),
  project_id            TEXT NOT NULL,
  -- unreadable 読めない所、decide 今年決めること、map_gap 地図の空き、conflict 食い違い、discarded 捨てた差分
  kind                  TEXT NOT NULL CHECK (kind IN ('unreadable', 'decide', 'map_gap', 'conflict', 'discarded')),
  text                  TEXT NOT NULL,
  -- 何についての問いか（項目の名前、表の名前と相手、地図の仕事の鍵）
  target                TEXT,
  -- 選べる物、並べた二つの中身、照合の候補など（JSON）
  detail                TEXT,
  state                 TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'later', 'answered', 'unknown')),
  answer                TEXT,
  answered_at           TEXT,
  answered_by_account_id TEXT,
  source_kind           TEXT,
  source_ref            TEXT,
  source_locator        TEXT,
  source_year           INTEGER,
  pack_version          TEXT,
  dedupe_key            TEXT NOT NULL,
  -- この問いを起こした差分
  change_id             TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (ward_id, question_id),
  UNIQUE (ward_id, project_id, dedupe_key),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id),
  FOREIGN KEY (ward_id, change_id) REFERENCES project_changes (ward_id, change_id),
  FOREIGN KEY (ward_id, answered_by_account_id) REFERENCES accounts (ward_id, account_id)
);
CREATE INDEX project_questions_open ON project_questions (ward_id, project_id, state, created_at);

-- 地図の仕事。時系列の上の仕事。初年度は種類ごとの一般の型から作り、役員が要らない物を消し、足りない物を足す。
-- task_key は型の仕事の名前（会場、協賛など）。役員が足した仕事は空。
-- offset_days は行事の日（期限群の event_day）からの日数で、去年の地図を種にする時に日付を置き直すために持つ。
-- 済み・進んだの印（progress）には出どころを付ける。要らない仕事は消さず removed_at を入れる。
CREATE TABLE project_map_tasks (
  task_id               TEXT PRIMARY KEY,
  ward_id               TEXT NOT NULL REFERENCES wards (ward_id),
  project_id            TEXT NOT NULL,
  task_key              TEXT,
  name                  TEXT NOT NULL,
  period_start          TEXT CHECK (period_start IS NULL OR period_start GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  period_end            TEXT CHECK (period_end IS NULL OR period_end GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  offset_start_days     INTEGER,
  offset_end_days       INTEGER,
  sort_order            INTEGER NOT NULL DEFAULT 0,
  progress              TEXT NOT NULL DEFAULT 'open' CHECK (progress IN ('open', 'started', 'done')),
  progress_source_kind  TEXT CHECK (progress_source_kind IN ('original', 'person', 'web_answer', 'ai_proposal')),
  progress_source_ref   TEXT,
  progress_source_locator TEXT,
  progress_confidence   TEXT CHECK (progress_confidence IN ('high', 'medium', 'low')),
  progress_change_id    TEXT,
  -- 担当の席（名札であって鍵ではない）
  seat_id               TEXT,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  removed_at            TEXT,
  UNIQUE (ward_id, task_id),
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id),
  FOREIGN KEY (ward_id, seat_id) REFERENCES seats (ward_id, seat_id),
  FOREIGN KEY (ward_id, progress_change_id) REFERENCES project_changes (ward_id, change_id)
);
CREATE UNIQUE INDEX project_map_tasks_key ON project_map_tasks (ward_id, project_id, task_key)
  WHERE task_key IS NOT NULL AND removed_at IS NULL;
CREATE INDEX project_map_tasks_project ON project_map_tasks (ward_id, project_id, sort_order);
