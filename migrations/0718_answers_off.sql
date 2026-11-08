-- L-319: 行事の案内や宣伝で、出欠を聞くかを役員が選べるようにする。聞かないと選んだ準備では、
-- 案内に返事の入口と回答票を付けない。役員の操作として、選んだ時と人だけを残す。聞くに戻すと空に戻る。
ALTER TABLE projects ADD COLUMN answers_off_at TEXT;
ALTER TABLE projects ADD COLUMN answers_off_by TEXT;
