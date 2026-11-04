import { newId, nowIso } from "../core/ids";
import { WardBucket } from "../core/storage";

export interface LineOriginal {
  eventId: string;
  senderId: string;
  receivedAt: string;
  kind: "text" | "image";
  text?: string;
  bytes?: ArrayBuffer;
  contentType?: string;
}

export interface InboxMatch {
  disposition: "unmatched" | "matched" | "unrelated";
  projectId?: string;
  projectName?: string;
  reason?: string;
}

export interface LineIntakePorts {
  receiveOriginal: (wardId: string, original: LineOriginal) => Promise<string>;
  matchInboxItem: (wardId: string, original: LineOriginal) => Promise<InboxMatch>;
}

/** 束2の受付とAIが入るまでの差し替え口。原本と判定は個別の接続にする。 */
export function createLineIntakePorts(
  db: D1Database,
  bucket: R2Bucket,
): LineIntakePorts {
  return {
    async receiveOriginal(wardId, original) {
      const itemId = newId();
      const objectKey = `line/${itemId}.${original.kind === "image" ? "bin" : "txt"}`;
      const scopedBucket = new WardBucket(bucket, wardId);
      const body = original.kind === "text"
        ? new TextEncoder().encode(original.text ?? "")
        : original.bytes;
      if (!body) throw new Error("LINE の写真データがありません。");
      await scopedBucket.put(objectKey, body, {
        httpMetadata: { contentType: original.contentType ?? "text/plain; charset=utf-8" },
      });
      try {
        await db.prepare(`
          INSERT INTO line_inbox_items (
            ward_id, item_id, event_id, sender_id, original_kind,
            original_text, original_object_key, received_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `).bind(
          wardId,
          itemId,
          original.eventId,
          original.senderId,
          original.kind,
          original.kind === "text" ? original.text ?? "" : null,
          objectKey,
          original.receivedAt,
        ).run();
      } catch (error) {
        await scopedBucket.delete(objectKey);
        throw error;
      }
      return itemId;
    },
    async matchInboxItem() {
      // 束2の当てる口が入るまでは、人に仕分けを求めず受け箱に置く。
      return { disposition: "unmatched" };
    },
  };
}

export async function markInboxItemUnrelated(
  db: D1Database,
  bucket: R2Bucket,
  wardId: string,
  itemId: string,
  receivedAt = nowIso(),
): Promise<boolean> {
  const item = await db.prepare(`
    SELECT original_object_key FROM line_inbox_items
    WHERE ward_id = ? AND item_id = ?
  `).bind(wardId, itemId).first<{ original_object_key: string | null }>();
  if (!item) return false;
  const day = receivedAt.slice(0, 10);
  await db.batch([
    db.prepare(`
      INSERT INTO line_unrelated_daily_counts (ward_id, day, item_count)
      VALUES (?, ?, 1)
      ON CONFLICT (ward_id, day) DO UPDATE SET item_count = item_count + 1
    `).bind(wardId, day),
    db.prepare("DELETE FROM line_inbox_items WHERE ward_id = ? AND item_id = ?").bind(wardId, itemId),
  ]);
  if (item.original_object_key) await new WardBucket(bucket, wardId).delete(item.original_object_key);
  return true;
}
