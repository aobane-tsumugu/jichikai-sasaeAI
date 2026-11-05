-- ログイン ID は表示名と分けるが、有効な表示名は区内で一意に保つ。
CREATE UNIQUE INDEX accounts_name_active
  ON accounts (ward_id, name_key)
  WHERE removed_at IS NULL;
