-- 問い合わせの原文を残し、役員が書いた答えの履歴を同じ記録に持つ。
-- 既存の区ごとの控え、引き渡し、削除にも一緒に含まれる。
ALTER TABLE inquiry_records ADD COLUMN answer_history TEXT NOT NULL DEFAULT '[]';
