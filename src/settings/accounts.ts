// 席とアカウントの操作（区の設定と運用の画面が共有する）。HTTP を知らず、D1 だけを触る。
// 全部の問い合わせは ward_id を where に持つ。席は鍵ではなく、誰がしたかの記録と交代のための名札。
import { newId, nowIso } from "../core/ids";
import { cleanName, generatePassword, generateSalt, hashPassword, nameKey } from "../core/password";

export type Failure = { ok: false; message: string };

export interface SeatRow {
  seatId: string;
  title: string;
}

export interface DeviceRow {
  deviceId: string;
  label: string;
  createdAt: string;
  lastSeenAt: string;
}

export interface AccountRow {
  accountId: string;
  name: string;
  seatId: string | null;
  seatTitle: string | null;
  createdAt: string;
  devices: DeviceRow[];
}

const MAX_NAME = 40;

/** 名前や席の名前として使える文字列か。使えなければ画面に出せる理由を返す。 */
function labelProblem(raw: string, what: string): string | null {
  const text = cleanName(raw);
  if (text === "") return `${what}を入れてください。`;
  if (text.length > MAX_NAME) return `${what}は ${MAX_NAME} 文字までです。`;
  // eslint の no-control-regex を避けるため、制御文字は文字コードで見る
  if ([...text].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) {
    return `${what}に使えない文字があります。`;
  }
  return null;
}

export async function listSeats(db: D1Database, wardId: string): Promise<SeatRow[]> {
  const rows = await db
    .prepare("SELECT seat_id, title FROM seats WHERE ward_id = ? AND removed_at IS NULL ORDER BY sort_order, created_at, title")
    .bind(wardId)
    .all<{ seat_id: string; title: string }>();
  return rows.results.map((r) => ({ seatId: r.seat_id, title: r.title }));
}

export async function addSeat(
  db: D1Database,
  wardId: string,
  title: string,
): Promise<{ ok: true; seatId: string } | Failure> {
  const problem = labelProblem(title, "席の名前");
  if (problem) return { ok: false, message: problem };
  const clean = cleanName(title);
  const seatId = newId();
  const result = await db
    .prepare(
      `INSERT INTO seats (seat_id, ward_id, title, sort_order, created_at)
       SELECT ?, ?, ?, (SELECT COALESCE(MAX(sort_order), 0) + 1 FROM seats WHERE ward_id = ?), ?
        WHERE NOT EXISTS (SELECT 1 FROM seats WHERE ward_id = ? AND title = ? AND removed_at IS NULL)`,
    )
    .bind(seatId, wardId, clean, wardId, nowIso(), wardId, clean)
    .run();
  if (result.meta.changes === 0) return { ok: false, message: "同じ名前の席がもうあります。" };
  return { ok: true, seatId };
}

/** 席を外す。その席にいたアカウントは、席なしになる（アカウントは残る）。 */
export async function removeSeat(db: D1Database, wardId: string, seatId: string): Promise<{ ok: true } | Failure> {
  const [removed] = await db.batch([
    db
      .prepare("UPDATE seats SET removed_at = ? WHERE ward_id = ? AND seat_id = ? AND removed_at IS NULL")
      .bind(nowIso(), wardId, seatId),
    db.prepare("UPDATE accounts SET seat_id = NULL WHERE ward_id = ? AND seat_id = ?").bind(wardId, seatId),
  ]);
  if (!removed || removed.meta.changes === 0) return { ok: false, message: "その席は見つかりません。" };
  return { ok: true };
}

async function seatIsActive(db: D1Database, wardId: string, seatId: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS ok FROM seats WHERE ward_id = ? AND seat_id = ? AND removed_at IS NULL")
    .bind(wardId, seatId)
    .first();
  return row !== null;
}

export async function listAccounts(db: D1Database, wardId: string): Promise<AccountRow[]> {
  const accounts = await db
    .prepare(
      `SELECT a.account_id, a.name, a.seat_id, s.title AS seat_title, a.created_at
         FROM accounts a
         LEFT JOIN seats s ON s.ward_id = a.ward_id AND s.seat_id = a.seat_id AND s.removed_at IS NULL
        WHERE a.ward_id = ? AND a.removed_at IS NULL
        ORDER BY a.created_at, a.name`,
    )
    .bind(wardId)
    .all<{ account_id: string; name: string; seat_id: string | null; seat_title: string | null; created_at: string }>();
  const devices = await db
    .prepare(
      "SELECT device_id, account_id, label, created_at, last_seen_at FROM devices WHERE ward_id = ? ORDER BY last_seen_at DESC",
    )
    .bind(wardId)
    .all<{ device_id: string; account_id: string; label: string; created_at: string; last_seen_at: string }>();
  return accounts.results.map((a) => ({
    accountId: a.account_id,
    name: a.name,
    seatId: a.seat_title === null ? null : a.seat_id,
    seatTitle: a.seat_title,
    createdAt: a.created_at,
    devices: devices.results
      .filter((d) => d.account_id === a.account_id)
      .map((d) => ({ deviceId: d.device_id, label: d.label, createdAt: d.created_at, lastSeenAt: d.last_seen_at })),
  }));
}

/**
 * アカウントを足す。パスワードは Workers が作り、ここで一度だけ返す（保存は塩付きの要約だけ）。
 * 渡すのは足した人の仕事。createdBy は提供側が作る最初のアカウントでは null。
 */
export async function addAccount(
  db: D1Database,
  wardId: string,
  input: { name: string; seatId?: string | null; createdBy?: string | null },
): Promise<{ ok: true; accountId: string; name: string; password: string } | Failure> {
  const problem = labelProblem(input.name, "名前");
  if (problem) return { ok: false, message: problem };
  const name = cleanName(input.name);
  const seatId = input.seatId || null;
  if (seatId && !(await seatIsActive(db, wardId, seatId))) return { ok: false, message: "その席は見つかりません。" };

  const accountId = newId();
  const password = generatePassword();
  const salt = generateSalt();
  const hash = await hashPassword(password, salt);
  const result = await db
    .prepare(
      `INSERT INTO accounts (account_id, ward_id, name, name_key, seat_id, password_salt, password_hash, password_changed_at, created_at, created_by_account_id)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE ward_id = ? AND name_key = ? AND removed_at IS NULL)`,
    )
    .bind(accountId, wardId, name, nameKey(name), seatId, salt, hash, nowIso(), nowIso(), input.createdBy ?? null, wardId, nameKey(name))
    .run();
  if (result.meta.changes === 0) return { ok: false, message: "同じ名前のアカウントがもうあります。" };
  return { ok: true, accountId, name, password };
}

/**
 * アカウントを外す。最後の一人は外せない（区に入れる人がいなくなるため）。端末の記憶も消す。
 * 行は消さず removed_at を入れる（過去の記録が指しているため）。
 */
export async function removeAccount(
  db: D1Database,
  wardId: string,
  accountId: string,
  removedBy: string | null,
): Promise<{ ok: true } | Failure> {
  const [updated] = await db.batch([
    db
      .prepare(
        `UPDATE accounts SET removed_at = ?, removed_by_account_id = ?
          WHERE ward_id = ? AND account_id = ? AND removed_at IS NULL
            AND (SELECT COUNT(*) FROM accounts WHERE ward_id = ? AND removed_at IS NULL) > 1`,
      )
      .bind(nowIso(), removedBy, wardId, accountId, wardId),
    db
      .prepare(
        `DELETE FROM devices WHERE ward_id = ? AND account_id = ?
          AND EXISTS (SELECT 1 FROM accounts WHERE ward_id = ? AND account_id = ? AND removed_at IS NOT NULL)`,
      )
      .bind(wardId, accountId, wardId, accountId),
  ]);
  if (updated && updated.meta.changes > 0) return { ok: true };
  const exists = await db
    .prepare("SELECT 1 AS ok FROM accounts WHERE ward_id = ? AND account_id = ? AND removed_at IS NULL")
    .bind(wardId, accountId)
    .first();
  return {
    ok: false,
    message: exists ? "最後の一人は外せません。先に別のアカウントを足してください。" : "そのアカウントは見つかりません。",
  };
}

/**
 * 初期化: パスワードを作り直す。古いパスワードは使えなくなり、そのアカウントの端末の記憶も消す
 * （keepDeviceId の端末だけは残す。自分のパスワードを作り直した時に、その場で締め出されないため）。
 */
export async function resetPassword(
  db: D1Database,
  wardId: string,
  accountId: string,
  keepDeviceId?: string,
): Promise<{ ok: true; name: string; password: string } | Failure> {
  const account = await db
    .prepare("SELECT name FROM accounts WHERE ward_id = ? AND account_id = ? AND removed_at IS NULL")
    .bind(wardId, accountId)
    .first<{ name: string }>();
  if (!account) return { ok: false, message: "そのアカウントは見つかりません。" };
  const password = generatePassword();
  const salt = generateSalt();
  await db.batch([
    db
      .prepare(
        "UPDATE accounts SET password_salt = ?, password_hash = ?, password_changed_at = ? WHERE ward_id = ? AND account_id = ?",
      )
      .bind(salt, await hashPassword(password, salt), nowIso(), wardId, accountId),
    db
      .prepare("DELETE FROM devices WHERE ward_id = ? AND account_id = ? AND device_id <> ?")
      .bind(wardId, accountId, keepDeviceId ?? ""),
  ]);
  return { ok: true, name: account.name, password };
}

/** 端末の締め出し: なくした端末の記憶を消す。deviceId を渡せばその一台、渡さなければそのアカウントの全部。 */
export async function lockOutDevices(
  db: D1Database,
  wardId: string,
  accountId: string,
  deviceId?: string,
): Promise<{ ok: true; count: number } | Failure> {
  const result = deviceId
    ? await db
        .prepare("DELETE FROM devices WHERE ward_id = ? AND account_id = ? AND device_id = ?")
        .bind(wardId, accountId, deviceId)
        .run()
    : await db.prepare("DELETE FROM devices WHERE ward_id = ? AND account_id = ?").bind(wardId, accountId).run();
  return { ok: true, count: result.meta.changes };
}

/** 席を付け替える（交代）。seatId が空なら席なし。席は名札で、権限は変わらない。 */
export async function setAccountSeat(
  db: D1Database,
  wardId: string,
  accountId: string,
  seatId: string | null,
): Promise<{ ok: true } | Failure> {
  if (seatId && !(await seatIsActive(db, wardId, seatId))) return { ok: false, message: "その席は見つかりません。" };
  const result = await db
    .prepare("UPDATE accounts SET seat_id = ? WHERE ward_id = ? AND account_id = ? AND removed_at IS NULL")
    .bind(seatId, wardId, accountId)
    .run();
  return result.meta.changes > 0 ? { ok: true } : { ok: false, message: "そのアカウントは見つかりません。" };
}
