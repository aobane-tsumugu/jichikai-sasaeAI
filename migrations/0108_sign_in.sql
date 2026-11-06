-- U11: 役員の入り方と、一度だけ使える入口。リンクの本体は保存しない。
ALTER TABLE accounts ADD COLUMN sign_in_required INTEGER NOT NULL DEFAULT 0 CHECK (sign_in_required IN (0, 1));
ALTER TABLE accounts ADD COLUMN sign_in_completed_at TEXT;

CREATE TABLE sign_in_methods (
  method_id TEXT PRIMARY KEY,
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  account_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('password', 'email', 'line')),
  subject TEXT NOT NULL,
  email TEXT,
  verified_at TEXT NOT NULL,
  removed_at TEXT,
  UNIQUE (ward_id, account_id, kind),
  FOREIGN KEY (ward_id, account_id) REFERENCES accounts (ward_id, account_id) ON DELETE CASCADE
);
-- 同じLINEとメールを二人に結ばない。外したあとなら、本人を確かめ直して結べる。
CREATE UNIQUE INDEX sign_in_subject_active ON sign_in_methods (kind, subject) WHERE removed_at IS NULL AND kind <> 'password';

CREATE TABLE sign_in_links (
  link_id TEXT PRIMARY KEY,
  ward_id TEXT NOT NULL REFERENCES wards (ward_id),
  account_id TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('invite', 'reset', 'email')),
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  revoked_at TEXT,
  completion_id TEXT,
  notified_at TEXT,
  notification_error TEXT,
  created_at TEXT NOT NULL,
  created_by_account_id TEXT,
  created_by_provider INTEGER NOT NULL DEFAULT 0 CHECK (created_by_provider IN (0, 1)),
  UNIQUE (ward_id, token_hash),
  FOREIGN KEY (ward_id, account_id) REFERENCES accounts (ward_id, account_id) ON DELETE CASCADE,
  FOREIGN KEY (ward_id, created_by_account_id) REFERENCES accounts (ward_id, account_id)
);
CREATE INDEX sign_in_links_account ON sign_in_links (ward_id, account_id, created_at);

-- 既存のIDとパスワード、およびU12まで残す運用の操作を引き続き使えるようにする。
INSERT INTO sign_in_methods (method_id, ward_id, account_id, kind, subject, verified_at, removed_at)
  SELECT 'password:' || account_id, ward_id, account_id, 'password', account_id, password_changed_at, removed_at FROM accounts;
UPDATE accounts SET sign_in_completed_at = created_at WHERE ward_id IS NOT NULL;

CREATE TRIGGER sign_in_account_added AFTER INSERT ON accounts WHEN NEW.sign_in_required = 0
BEGIN
  UPDATE accounts SET sign_in_completed_at = NEW.created_at WHERE ward_id = NEW.ward_id AND account_id = NEW.account_id;
  INSERT INTO sign_in_methods (method_id, ward_id, account_id, kind, subject, verified_at)
    VALUES ('password:' || NEW.account_id, NEW.ward_id, NEW.account_id, 'password', NEW.account_id, NEW.password_changed_at);
END;

CREATE TRIGGER sign_in_password_changed AFTER UPDATE OF password_hash ON accounts
WHEN NEW.removed_at IS NULL
BEGIN
  UPDATE accounts SET sign_in_required = 0 WHERE ward_id = NEW.ward_id AND account_id = NEW.account_id;
  UPDATE sign_in_links SET revoked_at = NEW.password_changed_at
    WHERE ward_id = NEW.ward_id AND account_id = NEW.account_id AND used_at IS NULL AND revoked_at IS NULL;
  INSERT INTO sign_in_methods (method_id, ward_id, account_id, kind, subject, verified_at)
    VALUES ('password:' || NEW.account_id, NEW.ward_id, NEW.account_id, 'password', NEW.account_id, NEW.password_changed_at)
    ON CONFLICT (ward_id, account_id, kind) DO UPDATE SET verified_at = excluded.verified_at, removed_at = NULL;
END;

CREATE TRIGGER sign_in_account_removed AFTER UPDATE OF removed_at ON accounts
WHEN NEW.removed_at IS NOT NULL
BEGIN
  UPDATE sign_in_methods SET removed_at = NEW.removed_at WHERE ward_id = NEW.ward_id AND account_id = NEW.account_id AND removed_at IS NULL;
  UPDATE sign_in_links SET revoked_at = NEW.removed_at WHERE ward_id = NEW.ward_id AND account_id = NEW.account_id AND used_at IS NULL AND revoked_at IS NULL;
END;
