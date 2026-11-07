-- 0の区はこれまでどおり。制限の判断は提供側だけが行う。
ALTER TABLE ops_ward_limits ADD COLUMN line_sender_daily_limit INTEGER NOT NULL DEFAULT 0 CHECK (line_sender_daily_limit >= 0);
ALTER TABLE jobs ADD COLUMN ai_limit_reason TEXT NOT NULL DEFAULT '' CHECK (ai_limit_reason IN ('', 'monthly', 'sender'));
ALTER TABLE line_inbox_items ADD COLUMN official_addressed INTEGER NOT NULL DEFAULT 0;

-- webhookの既存の重複防止と保管期限を使い、雑談を消したあとも受付件数だけ数える。
ALTER TABLE line_webhook_receipts ADD COLUMN sender_hash TEXT;
ALTER TABLE line_webhook_receipts ADD COLUMN sender_day TEXT;
ALTER TABLE line_webhook_receipts ADD COLUMN sender_admitted INTEGER;
CREATE INDEX line_sender_daily_receipts ON line_webhook_receipts (ward_id, sender_hash, sender_day, sender_admitted);

-- 受け箱に残さない雑談の判定も、本文を持たず月の使用量に含める。
CREATE TABLE ops_monthly_ai_usage (
  ward_id TEXT NOT NULL REFERENCES wards (ward_id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (ward_id, month)
);
