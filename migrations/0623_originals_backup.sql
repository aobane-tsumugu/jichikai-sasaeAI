-- 複写の途中位置と、消去・書き直しとの重なりを防ぐ短い占有。本文と鍵は持たない。
CREATE TABLE archive_backup_state (
  ward_id TEXT PRIMARY KEY,
  requested_day TEXT NOT NULL DEFAULT '',
  completed_day TEXT NOT NULL DEFAULT '',
  scan_day TEXT NOT NULL DEFAULT '',
  phase TEXT NOT NULL DEFAULT 'idle' CHECK (phase IN ('idle', 'copy', 'prune')),
  cursor TEXT,
  last_copied_at TEXT,
  last_attempt_at TEXT NOT NULL DEFAULT '',
  failures INTEGER NOT NULL DEFAULT 0,
  lock_token TEXT,
  lock_until TEXT
);
