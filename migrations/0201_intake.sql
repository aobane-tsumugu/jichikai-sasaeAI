-- 束 2 入れると列: 入った物（送った単位）、原本、読み取り、列の記録。
--
-- 全ての表は ward_id を持ち、区の中の物を指す外部キーは (ward_id, 〇〇_id) の複合にする（0101 と同じ）。
-- 時刻は ISO 8601 UTC の文字列。ID は意味を持たない文字列。
-- project_id は束 3 のプロジェクトを指すが、束 3 の表がこの migration より後に入るので外部キーを付けない。
-- この migration は配った後に書き換えない。足す時は 0202 以降のファイルにする。

-- 入った物の一つ分（設計書の「入力一つ」）。一回の送信で束ねた原本（複数枚、裏表）と、その読みの進み具合を持つ。
-- 画面に出す言葉は「入った物」。status は次の流れ。
--   received    受けた。読みの順番待ち
--   reading     読んでいる（lease_until までの貸し出し。切れたら Cron が読み直す）
--   read        読み終わった。プロジェクトに繋げる順番待ち（プロジェクトが未定の物もここで待つ）
--   connecting  繋げている（Managed Agents のセッションが動いている）
--   done        完了
--   attention   提供側の対応が要る（予算の上限、鍵の更新の失敗など）。役員には対応を求めない
--   failed      読めなかった、繋げられなかった。役員は「もう一度」を押せる
--   withdrawn   取り下げた
CREATE TABLE jobs (
  job_id          TEXT PRIMARY KEY,
  ward_id         TEXT NOT NULL REFERENCES wards (ward_id),
  -- 当たったプロジェクト。空は未定（公式 LINE の受け箱など）
  project_id      TEXT,
  -- 入ってきた道
  via             TEXT NOT NULL CHECK (via IN ('admin', 'space', 'line_direct', 'line_group', 'answer')),
  -- 読みの種類。general は一般の読み、answer_sheet は回答票、restore は過去の資料の復元
  read_kind       TEXT NOT NULL DEFAULT 'general' CHECK (read_kind IN ('general', 'answer_sheet', 'restore')),
  -- 誰が送ったか（公式 LINE の表示名など）。役員画面から送った時は空でよい
  sender_label    TEXT NOT NULL DEFAULT '',
  account_id      TEXT,
  status          TEXT NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received', 'reading', 'read', 'connecting', 'done', 'attention', 'failed', 'withdrawn')),
  -- 読みの試行の回数。上限に達したら failed
  attempt         INTEGER NOT NULL DEFAULT 0,
  -- reading の貸し出しの期限。この時刻を過ぎた reading は Cron が拾い直す
  lease_until     TEXT,
  -- failed の理由の種類（unsupported、too_large、unreadable、refused、error）。本文や鍵は入れない
  failure         TEXT NOT NULL DEFAULT '',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  read_at         TEXT,
  finished_at     TEXT,
  withdrawn_at    TEXT,
  UNIQUE (ward_id, job_id),
  FOREIGN KEY (ward_id, account_id) REFERENCES accounts (ward_id, account_id)
);
CREATE INDEX jobs_ward_status ON jobs (ward_id, status, created_at);
CREATE INDEX jobs_project ON jobs (ward_id, project_id, status, created_at);

-- 原本。受けた順に並べ、R2 に置いた実体を指す。同じ物（同じバイト列）は区の中で一度しか置かない。
-- 一行の文も原本にする（R2 には文字として置く）。取り下げた物は実体を消し、行は残す（過去の記録が指しているため）。
CREATE TABLE originals (
  original_id   TEXT PRIMARY KEY,
  ward_id       TEXT NOT NULL REFERENCES wards (ward_id),
  job_id        TEXT NOT NULL,
  -- 送った単位の中の順（1 から。ページ、裏表）
  position      INTEGER NOT NULL,
  -- 'photo'（カメラ）、'file'、'text'（一行の文）
  kind          TEXT NOT NULL CHECK (kind IN ('photo', 'file', 'text')),
  -- バイト列の SHA-256（小文字の 16 進）。一行の文は「プロジェクト + 改行 + 文」の SHA-256
  content_hash  TEXT NOT NULL,
  media_type    TEXT NOT NULL,
  filename      TEXT NOT NULL DEFAULT '',
  byte_size     INTEGER NOT NULL,
  -- WardBucket の中のパス。取り下げた後は空
  r2_path       TEXT,
  received_at   TEXT NOT NULL,
  withdrawn_at  TEXT,
  UNIQUE (ward_id, original_id),
  FOREIGN KEY (ward_id, job_id) REFERENCES jobs (ward_id, job_id)
);
CREATE INDEX originals_job ON originals (ward_id, job_id, position);
-- 同じ物を二度置かない・二度数えない。取り下げた物は数えない
CREATE UNIQUE INDEX originals_hash_active ON originals (ward_id, content_hash) WHERE withdrawn_at IS NULL;

-- 読み取り。入った物ごとに、読み方（source）ごとの一つ。body は型付きの JSON（src/ai/schema.ts の READING の形）。
--   model    Messages API で画像と PDF を読んだ物
--   direct   Word、Excel、文字のファイル、一行の文を、そのまま読み取りにした物（モデルは通さない）
-- 読み直すと同じ (job, source) の行を置き換える。どの包みの版とどのモデルで読んだかを残す。
CREATE TABLE readings (
  reading_id    TEXT PRIMARY KEY,
  ward_id       TEXT NOT NULL REFERENCES wards (ward_id),
  job_id        TEXT NOT NULL,
  source        TEXT NOT NULL CHECK (source IN ('model', 'direct')),
  pack_version  TEXT NOT NULL,
  model         TEXT NOT NULL DEFAULT '',
  body          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  UNIQUE (ward_id, reading_id),
  UNIQUE (ward_id, job_id, source),
  FOREIGN KEY (ward_id, job_id) REFERENCES jobs (ward_id, job_id)
);

-- 列の記録。読みと繋げるの一回ごとの実行の記録（結果、時間、使った量）。入った物の画面には出さない。
-- 提供側が費用と失敗を見るための物で、一回ごとに足し、書き換えない。
CREATE TABLE job_runs (
  run_id           TEXT PRIMARY KEY,
  ward_id          TEXT NOT NULL REFERENCES wards (ward_id),
  job_id           TEXT NOT NULL,
  kind             TEXT NOT NULL CHECK (kind IN ('read', 'connect')),
  attempt          INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error')),
  model            TEXT NOT NULL DEFAULT '',
  -- 失敗の種類と短い文。原本の中身と鍵は入れない
  error            TEXT NOT NULL DEFAULT '',
  input_tokens     INTEGER NOT NULL DEFAULT 0,
  output_tokens    INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms      INTEGER NOT NULL DEFAULT 0,
  started_at       TEXT NOT NULL,
  ended_at         TEXT,
  UNIQUE (ward_id, run_id),
  FOREIGN KEY (ward_id, job_id) REFERENCES jobs (ward_id, job_id)
);
CREATE INDEX job_runs_job ON job_runs (ward_id, job_id, started_at);
