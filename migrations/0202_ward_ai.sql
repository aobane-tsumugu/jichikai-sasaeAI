-- 束 2 Managed Agents: 区ごとの agent、vault、MCP の口の鍵、environment。
-- environment は提供側で一つだが、全ての表は ward_id を持つ決まりなので、区ごとの行に同じ値を写して持つ
-- （最初の区が名前で探して作り、他の区は同じ物を名前で見つける）。
-- 作る途中で止まっても続きから作れるよう、作った物から順に ID を入れる。setup_lease は作っている間の貸し出し。
CREATE TABLE ward_ai (
  ward_id          TEXT PRIMARY KEY REFERENCES wards (ward_id),
  environment_id   TEXT,
  vault_id         TEXT,
  credential_id    TEXT,
  -- MCP の口の鍵（vault の static_bearer に入れた物）の要約。鍵そのものは Anthropic の vault にだけある
  mcp_token_hash   TEXT,
  agent_id         TEXT,
  agent_version    INTEGER,
  -- agent の system に入れた包みの版
  pack_version     TEXT,
  setup_lease      TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
