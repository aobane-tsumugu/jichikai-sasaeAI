-- 同じ返事を、まだ送れていない場所へだけ送り直す。
ALTER TABLE inquiry_records ADD COLUMN line_reply_batch TEXT;
ALTER TABLE inquiry_records ADD COLUMN line_retry_key TEXT;
ALTER TABLE inquiry_records ADD COLUMN line_retry_started_at TEXT;
CREATE INDEX inquiry_reply_batch ON inquiry_records (ward_id, line_reply_batch);
ALTER TABLE line_photo_batches ADD COLUMN screen_answered_at TEXT;

-- 下書きの紙を、読み取りを保存する前に外す。元の写真の実体は消さない。
-- ほかの写真と一緒の時は、その写真の中身だけを残して保存する。
CREATE TRIGGER exclude_draft_paper_insert BEFORE INSERT ON readings
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.body, '$.text_blocks') b
  JOIN originals o ON o.ward_id = NEW.ward_id AND o.job_id = NEW.job_id
    AND o.original_id = json_extract(b.value, '$.original_id')
  WHERE o.ward_id = NEW.ward_id AND o.media_type LIKE 'image/%'
    AND instr(json_extract(b.value, '$.text'), '下書きです') > 0
)
BEGIN
  UPDATE originals SET withdrawn_at = NEW.created_at
    WHERE ward_id = NEW.ward_id AND job_id = NEW.job_id AND media_type LIKE 'image/%' AND withdrawn_at IS NULL
      AND original_id IN (SELECT json_extract(value, '$.original_id') FROM json_each(NEW.body, '$.text_blocks')
        WHERE instr(json_extract(value, '$.text'), '下書きです') > 0);
  UPDATE jobs SET withdrawn_at = NEW.created_at, status = 'withdrawn', lease_until = NULL,
    stop_reason = '下書きの紙なので、資料に入れていません。下書きの画面で直せます。'
    WHERE ward_id = NEW.ward_id AND job_id = NEW.job_id
      AND NOT EXISTS (SELECT 1 FROM originals WHERE ward_id = NEW.ward_id AND job_id = NEW.job_id AND withdrawn_at IS NULL);
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM originals WHERE ward_id = NEW.ward_id AND job_id = NEW.job_id AND withdrawn_at IS NULL) THEN RAISE(IGNORE) END;
  INSERT OR REPLACE INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at)
    SELECT NEW.reading_id, NEW.ward_id, NEW.job_id, NEW.source, NEW.pack_version, NEW.model,
      json_set(json_remove(NEW.body, '$.project_suggestions'),
        '$.summary', COALESCE((SELECT group_concat(json_extract(b.value, '$.text'), char(10))
          FROM json_each(NEW.body, '$.text_blocks') b WHERE EXISTS (
            SELECT 1 FROM originals o WHERE o.ward_id = NEW.ward_id AND o.job_id = NEW.job_id
              AND o.original_id = json_extract(b.value, '$.original_id') AND o.withdrawn_at IS NULL)), ''),
        '$.original_years', json((SELECT json_group_array(json(b.value)) FROM json_each(NEW.body, '$.original_years') b
          WHERE EXISTS (SELECT 1 FROM originals o WHERE o.ward_id = NEW.ward_id AND o.job_id = NEW.job_id
            AND o.original_id = json_extract(b.value, '$.original_id') AND o.withdrawn_at IS NULL))),
        '$.text_blocks', json((SELECT json_group_array(json(b.value)) FROM json_each(NEW.body, '$.text_blocks') b
          WHERE EXISTS (SELECT 1 FROM originals o WHERE o.ward_id = NEW.ward_id AND o.job_id = NEW.job_id
            AND o.original_id = json_extract(b.value, '$.original_id') AND o.withdrawn_at IS NULL))),
        '$.fields', json((SELECT json_group_array(json(b.value)) FROM json_each(NEW.body, '$.fields') b
          WHERE EXISTS (SELECT 1 FROM originals o WHERE o.ward_id = NEW.ward_id AND o.job_id = NEW.job_id
            AND o.original_id = json_extract(b.value, '$.original_id') AND o.withdrawn_at IS NULL))),
        '$.tables', json((SELECT json_group_array(json(b.value)) FROM json_each(NEW.body, '$.tables') b
          WHERE EXISTS (SELECT 1 FROM originals o WHERE o.ward_id = NEW.ward_id AND o.job_id = NEW.job_id
            AND o.original_id = json_extract(b.value, '$.original_id') AND o.withdrawn_at IS NULL))),
        '$.decisions', json((SELECT json_group_array(json(b.value)) FROM json_each(NEW.body, '$.decisions') b
          WHERE EXISTS (SELECT 1 FROM originals o WHERE o.ward_id = NEW.ward_id AND o.job_id = NEW.job_id
            AND o.original_id = json_extract(b.value, '$.original_id') AND o.withdrawn_at IS NULL))),
        '$.unreadable', json((SELECT json_group_array(json(b.value)) FROM json_each(NEW.body, '$.unreadable') b
          WHERE EXISTS (SELECT 1 FROM originals o WHERE o.ward_id = NEW.ward_id AND o.job_id = NEW.job_id
            AND o.original_id = json_extract(b.value, '$.original_id') AND o.withdrawn_at IS NULL)))
      ), NEW.created_at;
  SELECT RAISE(IGNORE);
END;
