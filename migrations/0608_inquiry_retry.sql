-- 同じ返事を、まだ送れていない場所へだけ送り直す。
ALTER TABLE inquiry_records ADD COLUMN line_reply_batch TEXT;
ALTER TABLE inquiry_records ADD COLUMN line_retry_key TEXT;
ALTER TABLE inquiry_records ADD COLUMN line_retry_started_at TEXT;
CREATE INDEX inquiry_reply_batch ON inquiry_records (ward_id, line_reply_batch);
ALTER TABLE line_photo_batches ADD COLUMN screen_answered_at TEXT;
