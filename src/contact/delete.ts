import type { Env } from "../env";
import { newId, nowIso } from "../core/ids";
import { deleteRecordObject, withRecordLock } from "../archive/backup";
import { CONTACT_WARD, contactById } from "./store";

/** 今の受付と添付写真を消し、過去の写しの書き直しを既存の消去処理へ渡す。 */
export async function deleteContact(env: Env, id: string): Promise<"deleted" | "missing" | "busy"> {
  return withRecordLock(env, CONTACT_WARD, async () => {
    const contact = await contactById(env.DB, id);
    if (!contact) return "missing";
    // 書き足しを止め、本人の入口を作っている最中には消さない。
    const closed = await env.DB.prepare(`UPDATE provider_contacts SET closed_at = COALESCE(closed_at, ?)
      WHERE ward_id = ? AND contact_id = ? AND (grant_id IS NULL OR grant_expires_at IS NOT NULL)`)
      .bind(nowIso(), CONTACT_WARD, id).run();
    if (!closed.meta.changes) return "busy";
    const photos = await env.DB.prepare(`SELECT photo_key FROM provider_contact_messages
      WHERE ward_id = ? AND contact_id = ? AND photo_key IS NOT NULL`)
      .bind(CONTACT_WARD, id).all<{ photo_key: string }>();
    // 写真が消せなければ受付を残す。同じ入口から続けられ、成功とは表示しない。
    for (const photo of photos.results) await deleteRecordObject(env, CONTACT_WARD, photo.photo_key);
    const statements: D1PreparedStatement[] = [];
    if (contact.target_ward_id && contact.grant_id) {
      statements.push(env.DB.prepare(`UPDATE sign_in_links SET revoked_at = ?
        WHERE ward_id = ? AND link_id = ? AND used_at IS NULL AND revoked_at IS NULL`)
        .bind(nowIso(), contact.target_ward_id, contact.grant_id));
    }
    // 本文と本人を確かめた内容も、受付を消すと一緒に消える。
    statements.push(env.DB.prepare("DELETE FROM provider_contacts WHERE ward_id = ? AND contact_id = ?")
      .bind(CONTACT_WARD, id));
    // 区の問い合わせと同じ処理待ちを使い、保管区画で提供側の受付と区別する。
    statements.push(env.DB.prepare(`INSERT INTO ops_deletion_queue (queue_id, ward_id, target_type, target_id, requested_at)
      VALUES (?, ?, 'inquiry', ?, ?)`).bind(newId(), CONTACT_WARD, id, nowIso()));
    await env.DB.batch(statements);
    return "deleted";
  });
}
