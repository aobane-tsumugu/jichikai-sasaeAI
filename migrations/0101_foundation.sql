-- 束 1 土台: 区、区ごとの設定、役の席、一人ずつのアカウント、端末の記憶。
--
-- 全ての表は ward_id を持つ（wards は主キーが ward_id）。区をまたいで読み書きしない。
-- 他の区を指す行ができないよう、区の中の物を指す外部キーは (ward_id, 〇〇_id) の複合にする。
-- 時刻は ISO 8601 UTC の文字列（例 2026-11-05T01:23:45.678Z）。ID は意味を持たない文字列。
-- この migration は配った後に書き換えない。足す時は 0102 以降のファイルにする。

CREATE TABLE wards (
  ward_id    TEXT PRIMARY KEY,
  -- 区のページの URL の一部（/<slug>/）。小文字の英数字とハイフン。
  slug       TEXT NOT NULL UNIQUE CHECK (slug = lower(slug) AND length(slug) BETWEEN 2 AND 40),
  name       TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 役の席。会長、書記、会計などの名札で、鍵ではない。誰がしたかの記録と交代のための物。
-- 外す時は行を消さず removed_at を入れる（過去の記録が指しているため）。
CREATE TABLE seats (
  seat_id    TEXT PRIMARY KEY,
  ward_id    TEXT NOT NULL REFERENCES wards (ward_id),
  title      TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  removed_at TEXT,
  UNIQUE (ward_id, seat_id)
);
CREATE UNIQUE INDEX seats_title_active ON seats (ward_id, title) WHERE removed_at IS NULL;

-- 一人ずつのアカウント。名前と、Workers が作る長いパスワード（入れるのは塩付きの要約だけ）。
-- seat_id は空でもよい（来年の役員候補など）。外す時は行を消さず removed_at を入れる。
CREATE TABLE accounts (
  account_id            TEXT PRIMARY KEY,
  ward_id               TEXT NOT NULL REFERENCES wards (ward_id),
  name                  TEXT NOT NULL,
  -- 名前の照合用（NFKC に直して空白を畳み、小文字にした物）。ログインと重複の検査に使う
  name_key              TEXT NOT NULL,
  seat_id               TEXT,
  password_salt         TEXT NOT NULL,
  password_hash         TEXT NOT NULL,
  password_changed_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- 提供側が作った最初のアカウントは空
  created_by_account_id TEXT,
  removed_at            TEXT,
  removed_by_account_id TEXT,
  UNIQUE (ward_id, account_id),
  FOREIGN KEY (ward_id, seat_id) REFERENCES seats (ward_id, seat_id),
  FOREIGN KEY (ward_id, created_by_account_id) REFERENCES accounts (ward_id, account_id),
  FOREIGN KEY (ward_id, removed_by_account_id) REFERENCES accounts (ward_id, account_id)
);
CREATE UNIQUE INDEX accounts_name_active ON accounts (ward_id, name_key) WHERE removed_at IS NULL;

-- 端末の記憶。ログインした端末が持つ札（Cookie）の要約。毎回パスワードを打たずに済むための物で、
-- なくした端末は行を消して締め出す。札そのものは持たず、SHA-256 の要約だけを持つ。
CREATE TABLE devices (
  device_id    TEXT PRIMARY KEY,
  ward_id      TEXT NOT NULL REFERENCES wards (ward_id),
  account_id   TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  -- 端末の見分け用（ブラウザと OS の短い説明）
  label        TEXT NOT NULL DEFAULT '',
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  FOREIGN KEY (ward_id, account_id) REFERENCES accounts (ward_id, account_id)
);
CREATE INDEX devices_account ON devices (ward_id, account_id);

-- 区ごとの設定（キーと値）。公開用の連絡先、定型文、班の名前など、使う束がキーを決めて入れる。
-- 値は文字列で、構造のある物は JSON にして入れる。
CREATE TABLE ward_settings (
  ward_id               TEXT NOT NULL REFERENCES wards (ward_id),
  key                   TEXT NOT NULL,
  value                 TEXT NOT NULL,
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_by_account_id TEXT,
  PRIMARY KEY (ward_id, key),
  FOREIGN KEY (ward_id, updated_by_account_id) REFERENCES accounts (ward_id, account_id)
) WITHOUT ROWID;
