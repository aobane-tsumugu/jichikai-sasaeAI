-- 同じトークの同じ人の続けての投稿を結ぶ。本文は届いたものに残す。
ALTER TABLE line_webhook_receipts ADD COLUMN bundle_id TEXT;
ALTER TABLE line_webhook_receipts ADD COLUMN destination TEXT;
ALTER TABLE line_webhook_receipts ADD COLUMN source_type TEXT;
ALTER TABLE line_webhook_receipts ADD COLUMN source_hash TEXT;
ALTER TABLE line_webhook_receipts ADD COLUMN received_at TEXT;
ALTER TABLE line_webhook_receipts ADD COLUMN bundle_reply_claimed_at TEXT;
CREATE INDEX line_receipt_sender ON line_webhook_receipts (ward_id, destination, source_type, source_hash, sender_hash, received_at);
CREATE INDEX line_receipt_bundle ON line_webhook_receipts (ward_id, bundle_id);
ALTER TABLE line_inbox_items ADD COLUMN bundle_id TEXT;
ALTER TABLE line_inbox_items ADD COLUMN line_destination TEXT;
ALTER TABLE line_inbox_items ADD COLUMN bundle_checked_photos INTEGER NOT NULL DEFAULT 0;
CREATE INDEX line_inbox_bundle ON line_inbox_items (ward_id, bundle_id);
ALTER TABLE inquiry_records ADD COLUMN line_bundle_id TEXT;
CREATE UNIQUE INDEX inquiry_line_bundle ON inquiry_records (ward_id, line_bundle_id);
