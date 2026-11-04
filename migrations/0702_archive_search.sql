-- 束 7: 読み取りと凍結した記録を検索する。索引の行は必ず区に属する。
CREATE TABLE archive_search_entries (
  entry_id INTEGER PRIMARY KEY AUTOINCREMENT,
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  project_id TEXT NOT NULL,
  record_type TEXT NOT NULL CHECK (record_type IN ('reading', 'decision', 'report', 'map')),
  year INTEGER NOT NULL,
  counterpart TEXT NOT NULL DEFAULT '',
  source_id TEXT NOT NULL DEFAULT '',
  locator TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id)
);

CREATE INDEX archive_search_scope ON archive_search_entries (ward_id, year, record_type, project_id);
CREATE INDEX archive_search_counterpart ON archive_search_entries (ward_id, counterpart);

CREATE VIRTUAL TABLE archive_search_fts USING fts5(content, tokenize = 'trigram');

CREATE TRIGGER archive_search_entries_insert AFTER INSERT ON archive_search_entries BEGIN
  INSERT INTO archive_search_fts (rowid, content) VALUES (new.entry_id, new.content);
END;
CREATE TRIGGER archive_search_entries_delete AFTER DELETE ON archive_search_entries BEGIN
  DELETE FROM archive_search_fts WHERE rowid = old.entry_id;
END;
CREATE TRIGGER archive_search_entries_update AFTER UPDATE OF content ON archive_search_entries BEGIN
  DELETE FROM archive_search_fts WHERE rowid = old.entry_id;
  INSERT INTO archive_search_fts (rowid, content) VALUES (new.entry_id, new.content);
END;

-- 読み取りが保存された時点で検索対象にする。JSON 全体に含まれる原文と決めたことを索引する。
CREATE TRIGGER archive_index_reading AFTER INSERT ON readings BEGIN
  INSERT INTO archive_search_entries
    (ward_id, project_id, record_type, year, source_id, content, created_at)
  SELECT j.ward_id, j.project_id, 'reading',
         COALESCE(CAST(json_extract(new.body, '$.document_year') AS INTEGER), p.year),
         '',
         new.body, new.created_at
    FROM jobs j JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id
   WHERE j.ward_id = new.ward_id AND j.job_id = new.job_id AND j.project_id IS NOT NULL;

  INSERT INTO archive_search_entries
    (ward_id, project_id, record_type, year, source_id, locator, content, created_at)
  SELECT j.ward_id, j.project_id, 'reading',
         COALESCE(CAST(json_extract(new.body, '$.document_year') AS INTEGER), p.year),
         json_extract(block.value, '$.original_id'), json_extract(block.value, '$.locator'), json_extract(block.value, '$.text'), new.created_at
    FROM jobs j JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id,
         json_each(new.body, '$.text_blocks') block
   WHERE j.ward_id = new.ward_id AND j.job_id = new.job_id AND j.project_id IS NOT NULL
     AND json_extract(block.value, '$.text') IS NOT NULL;

  INSERT INTO archive_search_entries
    (ward_id, project_id, record_type, year, source_id, locator, content, created_at)
  SELECT j.ward_id, j.project_id, 'reading',
         COALESCE(CAST(json_extract(new.body, '$.document_year') AS INTEGER), p.year),
         json_extract(decision.value, '$.original_id'), json_extract(decision.value, '$.locator'), json_extract(decision.value, '$.text'), new.created_at
    FROM jobs j JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id,
         json_each(new.body, '$.decisions') decision
   WHERE j.ward_id = new.ward_id AND j.job_id = new.job_id AND j.project_id IS NOT NULL
     AND json_extract(decision.value, '$.text') IS NOT NULL;
END;

-- 閉じた時に、決めたこと、報告、地図を記録へ足す。
CREATE TRIGGER archive_index_frozen_project AFTER UPDATE OF closed_at ON projects
WHEN old.closed_at IS NULL AND new.closed_at IS NOT NULL BEGIN
  INSERT INTO archive_search_entries
    (ward_id, project_id, record_type, year, counterpart, content, created_at)
  SELECT r.ward_id, r.project_id, 'report', p.year, '', r.body, new.closed_at
    FROM project_close_reports r
    JOIN projects p ON p.ward_id = r.ward_id AND p.project_id = r.project_id
   WHERE r.ward_id = new.ward_id AND r.project_id = new.project_id;

  INSERT INTO archive_search_entries
    (ward_id, project_id, record_type, year, counterpart, content, created_at)
  SELECT row.ward_id, row.project_id, 'decision', p.year,
         COALESCE(json_extract(row.data, '$.counterpart'), json_extract(row.data, '$.name'), ''), row.data, new.closed_at
    FROM project_rows row JOIN projects p ON p.ward_id = row.ward_id AND p.project_id = row.project_id
   WHERE row.ward_id = new.ward_id AND row.project_id = new.project_id
     AND row.table_key = 'decisions' AND row.scope = 'current' AND row.removed_at IS NULL;

  INSERT INTO archive_search_entries
    (ward_id, project_id, record_type, year, counterpart, content, created_at)
  SELECT m.ward_id, m.project_id, 'map', p.year, m.requested_by,
         m.name || ' ' || m.period || ' ' || m.progress || ' ' || m.requested_by || ' ' || m.difficulty || ' ' || m.next_year,
         new.closed_at
    FROM project_close_map m JOIN projects p ON p.ward_id = m.ward_id AND p.project_id = m.project_id
   WHERE m.ward_id = new.ward_id AND m.project_id = new.project_id;
END;

-- 既存の読み取りも初回だけ索引へ移す。
INSERT INTO archive_search_entries
  (ward_id, project_id, record_type, year, source_id, content, created_at)
SELECT j.ward_id, j.project_id, 'reading',
       COALESCE(CAST(json_extract(r.body, '$.document_year') AS INTEGER), p.year),
       '',
       r.body, r.created_at
  FROM readings r
  JOIN jobs j ON j.ward_id = r.ward_id AND j.job_id = r.job_id
  JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id
 WHERE j.project_id IS NOT NULL;

INSERT INTO archive_search_entries
  (ward_id, project_id, record_type, year, counterpart, content, created_at)
SELECT r.ward_id, r.project_id, 'report', p.year, '', r.body, r.updated_at
  FROM project_close_reports r
  JOIN projects p ON p.ward_id = r.ward_id AND p.project_id = r.project_id
 WHERE p.closed_at IS NOT NULL;

INSERT INTO archive_search_entries
  (ward_id, project_id, record_type, year, counterpart, content, created_at)
SELECT row.ward_id, row.project_id, 'decision', p.year,
       COALESCE(json_extract(row.data, '$.counterpart'), json_extract(row.data, '$.name'), ''), row.data, row.updated_at
  FROM project_rows row
  JOIN projects p ON p.ward_id = row.ward_id AND p.project_id = row.project_id
 WHERE p.closed_at IS NOT NULL AND row.table_key = 'decisions' AND row.scope = 'current' AND row.removed_at IS NULL;

INSERT INTO archive_search_entries
  (ward_id, project_id, record_type, year, counterpart, content, created_at)
SELECT m.ward_id, m.project_id, 'map', p.year, m.requested_by,
       m.name || ' ' || m.period || ' ' || m.progress || ' ' || m.requested_by || ' ' || m.difficulty || ' ' || m.next_year,
       m.updated_at
  FROM project_close_map m
  JOIN projects p ON p.ward_id = m.ward_id AND p.project_id = m.project_id
 WHERE p.closed_at IS NOT NULL;
