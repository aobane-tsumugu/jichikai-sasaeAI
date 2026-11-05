import { newId } from "./ids";
import { sha256Hex } from "./password";

const WINDOW_MS = 15 * 60_000;
const DELAY_AFTER = 4;
const MAX_DELAY_MS = 2_000;

/** D1 で試行を数え、一定回数の後に短く待たせる。失敗状態を固定せず、成功したら消す。 */
export async function delayLoginAfterFailures(db: D1Database, wardId: string, identity: string): Promise<void> {
  const key = await sha256Hex(identity.normalize("NFKC").trim().toLowerCase());
  const now = Date.now();
  const cutoff = new Date(now - WINDOW_MS).toISOString();
  const stamp = new Date(now).toISOString();
  await db.batch([
    db.prepare("DELETE FROM login_attempts WHERE ward_id = ? AND attempted_at < ?").bind(wardId, cutoff),
    db.prepare("INSERT INTO login_attempts (ward_id, attempt_key, attempt_id, attempted_at) VALUES (?, ?, ?, ?)").bind(wardId, key, newId(), stamp),
  ]);
  const row = await db.prepare(
    "SELECT COUNT(*) AS count FROM login_attempts WHERE ward_id = ? AND attempt_key = ? AND attempted_at >= ?",
  ).bind(wardId, key, cutoff).first<{ count: number }>();
  const count = row?.count ?? 0;
  if (count < DELAY_AFTER) return;
  const delay = Math.min(MAX_DELAY_MS, 500 * (count - DELAY_AFTER + 1));
  await new Promise<void>((resolve) => setTimeout(resolve, delay));
}

export async function clearLoginFailures(db: D1Database, wardId: string, identity: string): Promise<void> {
  const key = await sha256Hex(identity.normalize("NFKC").trim().toLowerCase());
  await db.prepare("DELETE FROM login_attempts WHERE ward_id = ? AND attempt_key = ?").bind(wardId, key).run();
}
