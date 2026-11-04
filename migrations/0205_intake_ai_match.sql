-- 束 2: 受け箱から AI が当てた先と理由を表示する。
ALTER TABLE jobs ADD COLUMN ai_matched_at TEXT;
ALTER TABLE jobs ADD COLUMN ai_match_reason TEXT;
