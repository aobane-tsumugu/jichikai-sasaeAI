// 試験の補助。各束の試験が、区とアカウントとログイン済みの Cookie を作るために使う。
// Worker の本体からは読み込まれない（src/index.ts が import しない）。
import type { AccountInfo, WardInfo } from "../env";
import { DEVICE_COOKIE } from "./auth";
import { newId, nowIso } from "./ids";
import {
  cleanName,
  cleanLoginId,
  generateDeviceToken,
  generatePassword,
  generateSalt,
  hashPassword,
  nameKey,
  sha256Hex,
} from "./password";

/** 試験ごとに重ならない区のスラッグ。 */
export function uniqueSlug(prefix = "t"): string {
  return `${prefix}-${crypto.randomUUID().slice(0, 8)}`;
}

/** 区を作る。名前は架空と分かる物にする。 */
export async function seedWard(
  db: D1Database,
  slug: string = uniqueSlug(),
  name = "試験用の区（架空）",
): Promise<WardInfo> {
  const wardId = newId();
  await db
    .prepare("INSERT INTO wards (ward_id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .bind(wardId, slug, name, nowIso())
    .run();
  return { wardId, slug, name };
}

export async function seedSeat(db: D1Database, wardId: string, title: string): Promise<string> {
  const seatId = newId();
  await db
    .prepare("INSERT INTO seats (seat_id, ward_id, title, created_at) VALUES (?, ?, ?, ?)")
    .bind(seatId, wardId, title, nowIso())
    .run();
  return seatId;
}

/** アカウントを作る。パスワードは平文で返すので、試験の中だけで使う。 */
export async function seedAccount(
  db: D1Database,
  wardId: string,
  name: string,
  options: { seatId?: string | null; password?: string } = {},
): Promise<AccountInfo & { loginId: string; password: string }> {
  const accountId = newId();
  const cleanedName = cleanName(name);
  const loginId = /^[A-Za-z0-9]+$/.test(cleanedName) ? cleanLoginId(cleanedName) : `test${accountId.replace(/[^A-Za-z0-9]/g, "")}`;
  const password = options.password ?? generatePassword();
  const salt = generateSalt();
  await db
    .prepare(
      `INSERT INTO accounts (account_id, ward_id, login_id, name, name_key, seat_id, password_salt, password_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      accountId,
      wardId,
      loginId,
      cleanedName,
      nameKey(cleanedName),
      options.seatId ?? null,
      salt,
      await hashPassword(password, salt),
      nowIso(),
    )
    .run();
  return { accountId, loginId, name: cleanedName, seatId: options.seatId ?? null, password };
}

/** ログイン済みの端末の記憶を作り、Cookie ヘッダーの値を返す。 */
export async function seedDeviceCookie(
  db: D1Database,
  wardId: string,
  accountId: string,
): Promise<string> {
  const token = generateDeviceToken();
  await db
    .prepare(
      "INSERT INTO devices (device_id, ward_id, account_id, token_hash, label, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind(newId(), wardId, accountId, await sha256Hex(token), "試験", nowIso(), nowIso())
    .run();
  return `${DEVICE_COOKIE}=${token}`;
}

/** 区、アカウント、ログイン済みの Cookie を一度に作る。 */
export async function seedAdmin(db: D1Database, slug: string = uniqueSlug(), accountName = "試験の役員（架空）") {
  const ward = await seedWard(db, slug);
  const account = await seedAccount(db, ward.wardId, accountName);
  const cookie = await seedDeviceCookie(db, ward.wardId, account.accountId);
  return { ward, account, cookie };
}
