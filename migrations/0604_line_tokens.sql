-- 鍵の値は Workers secrets に置き、区の台帳には参照先の名前だけを持つ。
ALTER TABLE line_channels ADD COLUMN channel_secret_binding TEXT;
ALTER TABLE line_channels ADD COLUMN access_token_binding TEXT;

-- 既存の接続が一つだけなら、従来の鍵をその区へ明示的に結び付ける。
-- 複数ある時は所属を決められないため、提供側が区ごとに参照先を設定する。
UPDATE line_channels
SET channel_secret_binding = 'LINE_CHANNEL_SECRET',
    access_token_binding = 'LINE_CHANNEL_ACCESS_TOKEN'
WHERE (SELECT COUNT(*) FROM line_channels) = 1;
