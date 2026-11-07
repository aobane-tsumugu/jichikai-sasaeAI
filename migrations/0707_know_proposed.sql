-- 役員が書いた文と違う内容の紙が届いた時、上書きせずに聞くための欄。
ALTER TABLE ward_know_items ADD COLUMN proposed_text TEXT NOT NULL DEFAULT '';
ALTER TABLE ward_know_items ADD COLUMN proposed_original_id TEXT;
