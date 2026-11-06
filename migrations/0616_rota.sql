-- U47。当番の準備と免除は役員の記録。配布用の表とは分ける。
CREATE TABLE rota_exemptions (
  exemption_id TEXT PRIMARY KEY,
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  household TEXT NOT NULL,
  district TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 1 AND 200),
  starts_on TEXT NOT NULL,
  ends_on TEXT NOT NULL CHECK (ends_on >= starts_on),
  recorded_at TEXT NOT NULL,
  recorded_by_account_id TEXT NOT NULL,
  withdrawn_at TEXT,
  withdrawn_by_account_id TEXT,
  FOREIGN KEY (ward_id, recorded_by_account_id) REFERENCES accounts (ward_id, account_id),
  FOREIGN KEY (ward_id, withdrawn_by_account_id) REFERENCES accounts (ward_id, account_id)
);
CREATE INDEX rota_exemptions_household ON rota_exemptions (ward_id, district, household, starts_on, ends_on);

CREATE TABLE rota_preparations (
  preparation_id TEXT PRIMARY KEY,
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  project_id TEXT NOT NULL,
  roster_json TEXT NOT NULL,
  comparison_json TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  recorded_by_account_id TEXT NOT NULL,
  FOREIGN KEY (ward_id, project_id) REFERENCES projects (ward_id, project_id) ON DELETE CASCADE,
  FOREIGN KEY (ward_id, recorded_by_account_id) REFERENCES accounts (ward_id, account_id)
);
CREATE INDEX rota_preparations_project ON rota_preparations (ward_id, project_id, recorded_at);

-- 普段の交代操作から作る。開始日や、記録を始める前の交代は推測しない。
CREATE TABLE rota_seat_changes (
  change_id TEXT PRIMARY KEY,
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  account_id TEXT NOT NULL,
  name TEXT NOT NULL,
  previous_title TEXT,
  next_title TEXT,
  recorded_at TEXT NOT NULL,
  FOREIGN KEY (ward_id, account_id) REFERENCES accounts (ward_id, account_id) ON DELETE CASCADE
);
CREATE INDEX rota_seat_changes_account ON rota_seat_changes (ward_id, account_id, recorded_at);
CREATE TRIGGER rota_seat_change AFTER UPDATE OF seat_id, removed_at ON accounts
WHEN old.removed_at IS NULL AND (old.seat_id IS NOT new.seat_id OR new.removed_at IS NOT NULL)
BEGIN
  INSERT INTO rota_seat_changes (change_id, ward_id, account_id, name, previous_title, next_title, recorded_at)
  SELECT lower(hex(randomblob(16))), new.ward_id, new.account_id, new.name,
    (SELECT title FROM seats WHERE ward_id = old.ward_id AND seat_id = old.seat_id),
    CASE WHEN new.removed_at IS NULL THEN (SELECT title FROM seats WHERE ward_id = new.ward_id AND seat_id = new.seat_id) END,
    strftime('%Y-%m-%dT%H:%M:%fZ', 'now');
END;
