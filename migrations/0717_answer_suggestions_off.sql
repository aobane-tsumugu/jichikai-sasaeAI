-- L-317: 返事で聞く欄の候補を、役員が「足さない」と押した準備では出さない。
-- AI の判断としては残さず、役員の操作として押した時と人だけを残す。元に戻すと空に戻る。
ALTER TABLE projects ADD COLUMN answer_suggestions_off_at TEXT;
ALTER TABLE projects ADD COLUMN answer_suggestions_off_by TEXT;
