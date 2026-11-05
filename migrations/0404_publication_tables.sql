-- 配った時の表を配布の記録に残す。以前に配った表は復元できないので NULL のままにする。
ALTER TABLE document_versions ADD COLUMN tables_snapshot TEXT;

-- 手伝いだけの申し込みは、閉じる時に人数だけを写してから名前を消す。
ALTER TABLE projects ADD COLUMN help_offer_count_on_close INTEGER CHECK (help_offer_count_on_close >= 0);
