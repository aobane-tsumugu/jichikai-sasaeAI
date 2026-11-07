import type { Env } from "../env";
import { WardBucket } from "../core/storage";
import { CRON } from "../core/cron";
import { CONTACT_WARD } from "../contact/store";
import { listRecordWardIds } from "./snapshot";

// 一回に5点。本文はストリームのまま渡し、途中位置は一ページごとに残す。
export const BACKUP_PAGE_SIZE = 5;
interface BackupState {
  ward_id: string;
  requested_day: string;
  completed_day: string;
  scan_day: string;
  phase: "idle" | "copy" | "prune";
  cursor: string | null;
  last_copied_at: string | null;
  last_attempt_at: string;
  failures: number;
}

/** 同じ区の複写・消去・写しの作成を重ねない。停止時はCronの最大実行時間を超えてから引き継ぐ。 */
export async function withRecordLock<T>(env: Env, wardId: string, work: () => Promise<T>): Promise<T> {
  const token = crypto.randomUUID();
  const now = new Date();
  await env.DB.prepare("INSERT INTO archive_backup_state (ward_id) VALUES (?) ON CONFLICT (ward_id) DO NOTHING")
    .bind(wardId).run();
  const claimed = await env.DB.prepare(`UPDATE archive_backup_state SET lock_token = ?, lock_until = ?
    WHERE ward_id = ? AND (lock_token IS NULL OR lock_until < ?)`)
    .bind(token, new Date(now.getTime() + 16 * 60_000).toISOString(), wardId, now.toISOString()).run();
  if (!claimed.meta.changes) throw new Error("記録の処理中です。次の処理で続けます。");
  try { return await work(); }
  finally {
    await env.DB.prepare("UPDATE archive_backup_state SET lock_token = NULL, lock_until = NULL WHERE ward_id = ? AND lock_token = ?")
      .bind(wardId, token).run();
  }
}

/** 呼び出し側はwithRecordLockの中で使う。先に別の場所を消し、失敗したら元の資料を残す。 */
export async function deleteRecordObject(env: Env, wardId: string, key: string): Promise<void> {
  if (env.ORIGINALS_BACKUP) {
    try { await new WardBucket(env.ORIGINALS_BACKUP, wardId).delete(key); }
    catch {
      await env.DB.prepare("UPDATE archive_backup_state SET failures = 1 WHERE ward_id = ?").bind(wardId).run();
      throw new Error("別の場所の保管を変更できませんでした。次の処理で続けます。");
    }
  }
  await new WardBucket(env.ORIGINALS, wardId).delete(key);
}

/** 書き直す前の写しを別の場所に残さない。失敗時は元の写しを残して同じ処理を再開する。 */
export async function putRecordSnapshot(env: Env, wardId: string, key: string, body: string): Promise<void> {
  if (env.ORIGINALS_BACKUP) {
    try { await new WardBucket(env.ORIGINALS_BACKUP, wardId).delete(key); }
    catch {
      await env.DB.prepare("UPDATE archive_backup_state SET failures = 1 WHERE ward_id = ?").bind(wardId).run();
      throw new Error("別の場所の写しを変更できませんでした。次の処理で続けます。");
    }
  }
  const source = await new WardBucket(env.ORIGINALS, wardId).put(key, body, {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  if (env.ORIGINALS_BACKUP && source) {
    try {
      await new WardBucket(env.ORIGINALS_BACKUP, wardId).put(key, body, {
        httpMetadata: source.httpMetadata, customMetadata: { sourceVersion: source.version },
      });
    } catch {
      await env.DB.prepare("UPDATE archive_backup_state SET failures = 1 WHERE ward_id = ?").bind(wardId).run();
      throw new Error("別の場所に写しを保存できませんでした。次の処理で続けます。");
    }
    await env.DB.prepare("UPDATE archive_backup_state SET last_copied_at = ? WHERE ward_id = ?")
      .bind(new Date().toISOString(), wardId).run();
  }
}

/** 元の場所を一巡してから別の場所も見る。元のR2にだけ無い古い写しも消去の対象。 */
export async function snapshotPage(env: Env, wardId: string, cursor?: string) {
  const secondary = cursor?.startsWith("backup:") ?? false;
  const bucket = secondary && env.ORIGINALS_BACKUP
    ? new WardBucket(env.ORIGINALS_BACKUP, wardId)
    : new WardBucket(env.ORIGINALS, wardId);
  const page = await bucket.list("snapshots/daily/", {
    limit: BACKUP_PAGE_SIZE, cursor: secondary ? cursor!.slice(7) || undefined : cursor,
  });
  const next = page.truncated && page.cursor ? `${secondary ? "backup:" : ""}${page.cursor}`
    : !secondary && env.ORIGINALS_BACKUP ? "backup:" : null;
  return { bucket, keys: page.keys, next };
}

function eligible(key: string): boolean {
  return key.startsWith("originals/") || key.startsWith("contacts/") || key.startsWith("snapshots/daily/");
}

async function stillNeeded(env: Env, wardId: string, key: string): Promise<boolean> {
  // 元のR2の障害を消去と取り違えない。写しは明示した消去・書き直しだけで変える。
  if (key.startsWith("snapshots/daily/")) return true;
  if (wardId === CONTACT_WARD) {
    return Boolean(await env.DB.prepare(`SELECT message_id FROM provider_contact_messages
      WHERE ward_id = ? AND photo_key = ? LIMIT 1`).bind(wardId, key).first());
  }
  return Boolean(await env.DB.prepare(`SELECT original_id FROM originals WHERE ward_id = ? AND r2_path = ?
    UNION SELECT item_id FROM line_inbox_items WHERE ward_id = ? AND original_object_key = ? LIMIT 1`)
    .bind(wardId, key, wardId, key).first());
}

async function scopes(env: Env): Promise<string[]> {
  return [...(await listRecordWardIds(env.DB)).map((ward) => ward.ward_id), CONTACT_WARD];
}

async function states(env: Env, ids: string[]): Promise<BackupState[]> {
  const result = await env.DB.batch<BackupState>(ids.map((id) => env.DB.prepare(
    "SELECT * FROM archive_backup_state WHERE ward_id = ?",
  ).bind(id)));
  return result.flatMap((page) => page.results);
}

/** 日次の処理が終わってから起動し、以後は5分ごとの処理で続きを進める。 */
export async function runBackupCron(event: ScheduledController, env: Env, now = new Date()): Promise<void> {
  if (!env.ORIGINALS_BACKUP || (event.cron !== CRON.DAILY && event.cron !== CRON.EVERY_5_MIN)) return;
  const ids = await scopes(env);
  if (event.cron === CRON.DAILY) {
    await env.DB.batch(ids.map((id) => env.DB.prepare(`INSERT INTO archive_backup_state (ward_id, requested_day)
      VALUES (?, ?) ON CONFLICT (ward_id) DO UPDATE SET requested_day = excluded.requested_day`)
      .bind(id, now.toISOString().slice(0, 10))));
  }
  const pending = (await states(env, ids)).filter((row) => row.completed_day < row.requested_day)
    .sort((a, b) => a.last_attempt_at.localeCompare(b.last_attempt_at));
  const item = pending[0];
  if (!item) return;
  await env.DB.prepare("UPDATE archive_backup_state SET last_attempt_at = ? WHERE ward_id = ?")
    .bind(now.toISOString(), item.ward_id).run();
  try {
    await withRecordLock(env, item.ward_id, async () => {
      // 待っていた古い呼び出しの途中位置を使わない。
      const state = await env.DB.prepare("SELECT * FROM archive_backup_state WHERE ward_id = ?")
        .bind(item.ward_id).first<BackupState>();
      if (!state || state.completed_day >= state.requested_day) return;
      const phase = state.phase === "idle" ? "copy" : state.phase;
      const scanDay = state.phase === "idle" ? state.requested_day : state.scan_day;
      const source = new WardBucket(env.ORIGINALS, item.ward_id);
      const backup = new WardBucket(env.ORIGINALS_BACKUP!, item.ward_id);
      const page = await (phase === "copy" ? source : backup).list("", {
        limit: BACKUP_PAGE_SIZE, cursor: state.cursor ?? undefined,
      });
      const started = Date.now();
      for (const entry of page.keys) {
        if (!eligible(entry.key)) continue;
        if (Date.now() - started > 15_000) throw new Error("次の処理で続けます。");
        if (phase === "prune") {
          if (!(await source.head(entry.key)) && !(await stillNeeded(env, item.ward_id, entry.key))) await backup.delete(entry.key);
          continue;
        }
        const saved = await backup.head(entry.key);
        if (saved?.customMetadata?.sourceVersion === entry.version) continue;
        const object = await source.get(entry.key);
        if (!object) {
          if (!(await stillNeeded(env, item.ward_id, entry.key))) await backup.delete(entry.key);
          continue;
        }
        await backup.put(entry.key, object.body, {
          httpMetadata: object.httpMetadata,
          customMetadata: { ...object.customMetadata, sourceVersion: object.version },
        });
        // 取り下げなど、占有の外で元の資料が消えた場合にも古い本体を残さない。
        const current = await source.head(entry.key);
        if (current?.version !== object.version) {
          if (current || !(await stillNeeded(env, item.ward_id, entry.key))) await backup.delete(entry.key);
          throw new Error("元の資料が変わったため次の処理で続けます。");
        }
        await env.DB.prepare("UPDATE archive_backup_state SET last_copied_at = ? WHERE ward_id = ?")
          .bind(now.toISOString(), item.ward_id).run();
      }
      const finished = !page.truncated && phase === "prune";
      await env.DB.prepare(`UPDATE archive_backup_state SET phase = ?, cursor = ?, scan_day = ?,
        completed_day = ?, failures = 0 WHERE ward_id = ?`)
        .bind(finished ? "idle" : page.truncated ? phase : "prune", page.cursor ?? null, scanDay,
          finished ? scanDay : state.completed_day, item.ward_id).run();
    });
  } catch {
    // 本文、キー、例外の内容は記録しない。失敗した一ページを次に再開する。
    await env.DB.prepare("UPDATE archive_backup_state SET failures = 1 WHERE ward_id = ?")
      .bind(item.ward_id).run();
  }
}

export async function backupStatus(env: Env, wardIds: string[]) {
  if (!env.ORIGINALS_BACKUP) return null;
  const rows = await states(env, [...wardIds, CONTACT_WARD]);
  return {
    lastCopiedAt: rows.map((row) => row.last_copied_at).filter((at): at is string => at !== null).sort().at(-1),
    failures: rows.reduce((count, row) => count + row.failures, 0),
  };
}
