-- 写真ごとの質問、人の返事、知らせの締めの記録。
ALTER TABLE line_inbox_items ADD COLUMN source_type TEXT;
ALTER TABLE line_inbox_items ADD COLUMN source_id TEXT;
ALTER TABLE inquiry_records ADD COLUMN line_user_id TEXT;
-- 古い一対一の受信だけは送り先が確か。グループのIDをuserIdとして使わない。
UPDATE inquiry_records SET line_user_id = line_source_id WHERE line_source_type = 'user';
ALTER TABLE inquiry_records ADD COLUMN line_answer_sent_at TEXT;
ALTER TABLE inquiry_records ADD COLUMN line_send_claimed_at TEXT;
ALTER TABLE inquiry_records ADD COLUMN line_send_error TEXT;
ALTER TABLE inquiry_records ADD COLUMN line_pending_answer TEXT;
ALTER TABLE line_clarifications ADD COLUMN message_text TEXT;
ALTER TABLE line_clarifications ADD COLUMN sent_message_id TEXT;
ALTER TABLE line_clarifications ADD COLUMN send_claimed_at TEXT;
ALTER TABLE line_clarifications ADD COLUMN answered_unknown INTEGER NOT NULL DEFAULT 0;
ALTER TABLE line_photo_items ADD COLUMN retake_clarification_id TEXT;
ALTER TABLE line_photo_batches ADD COLUMN completed_at TEXT;
ALTER TABLE line_photo_batches ADD COLUMN answer_reply_token TEXT;
ALTER TABLE line_photo_batches ADD COLUMN answer_reply_at TEXT;
ALTER TABLE line_officer_digests ADD COLUMN cutoff_at TEXT;

-- 以前の知らせは、送ろうとした時刻までの問い合わせを含んでいる。
UPDATE line_officer_digests SET cutoff_at = claimed_at WHERE ward_id IS NOT NULL;
