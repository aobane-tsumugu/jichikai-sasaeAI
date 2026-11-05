-- ログイン ID と画面に出す名前を分ける。
-- 有効な既存アカウントは、半角英数字だけの名前を小文字にして ID にする。
-- それ以外は区ごとに空いている userN を割り当てる。
ALTER TABLE accounts ADD COLUMN login_id TEXT;
DROP INDEX accounts_name_active;

WITH invalid_accounts AS (
  SELECT account_id, ward_id,
         ROW_NUMBER() OVER (PARTITION BY ward_id ORDER BY created_at, account_id) AS row_number
    FROM accounts
   WHERE removed_at IS NULL
     AND (name = '' OR name GLOB '*[^A-Za-z0-9]*')
), numeric_users AS (
  SELECT ward_id, MAX(CAST(substr(lower(name), 5) AS INTEGER)) AS max_number
    FROM accounts
   WHERE removed_at IS NULL
     AND lower(name) GLOB 'user[0-9]*'
     AND substr(lower(name), 5) <> ''
     AND substr(lower(name), 5) NOT GLOB '*[^0-9]*'
   GROUP BY ward_id
), assigned AS (
  SELECT a.account_id,
         CASE
           WHEN a.name <> '' AND a.name NOT GLOB '*[^A-Za-z0-9]*' THEN lower(a.name)
           ELSE 'user' || (invalid.row_number + COALESCE(users.max_number, 0))
         END AS login_id
    FROM accounts a
    LEFT JOIN invalid_accounts invalid ON invalid.ward_id = a.ward_id AND invalid.account_id = a.account_id
    LEFT JOIN numeric_users users ON users.ward_id = a.ward_id
)
UPDATE accounts
   SET login_id = (SELECT assigned.login_id FROM assigned WHERE assigned.account_id = accounts.account_id)
 WHERE removed_at IS NULL;

-- 退会済みアカウントも記録上の ID を残す。ログイン対象ではない。
UPDATE accounts
   SET login_id = lower(name)
 WHERE removed_at IS NOT NULL;

CREATE UNIQUE INDEX accounts_login_active
  ON accounts (ward_id, login_id)
  WHERE removed_at IS NULL;
