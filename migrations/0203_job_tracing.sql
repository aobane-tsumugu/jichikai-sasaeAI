-- 束 2: 繋げるの手の呼び出しの記録と、agent 側の数。書く手が効かない時に、原因が見えるようにする。
-- 0201 と 0202 は配備済みなので書き換えず、ここで足す。
--
-- job_tool_calls: MCP の口（Workers）が受けた手の呼び出しを一回ごとに足す。札が使えなかった呼び出しは job_id が空。
-- 原本の中身や鍵は入れない。detail は手と対象と結果の種類（例「write_change item:place -> applied」）だけ。
CREATE TABLE job_tool_calls (
  call_id     TEXT PRIMARY KEY,
  ward_id     TEXT NOT NULL REFERENCES wards (ward_id),
  job_id      TEXT,
  tool        TEXT NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('ok', 'error')),
  detail      TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  FOREIGN KEY (ward_id, job_id) REFERENCES jobs (ward_id, job_id)
);
CREATE INDEX job_tool_calls_job ON job_tool_calls (ward_id, job_id, created_at);

-- job_runs: セッションを消す前に、events から数えた agent 側の呼び出しの数、失敗の数、エラーの文、最後の返事の頭。
ALTER TABLE job_runs ADD COLUMN agent_tool_calls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_runs ADD COLUMN agent_tool_errors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE job_runs ADD COLUMN agent_errors TEXT NOT NULL DEFAULT '[]';
ALTER TABLE job_runs ADD COLUMN agent_summary TEXT NOT NULL DEFAULT '';
