import type { Env } from "../env";
import { newId, nowIso } from "../core/ids";
import { generateDeviceToken, sha256Hex } from "../core/password";
import { WardBucket } from "../core/storage";

// 受付時点では区を信用して選べない。本人確認のあとの区と保管区画を分ける。
export const CONTACT_WARD = "provider-contacts";
export const KINDS = { access: "役員の画面に入れない", broken: "画面が開かない、動かない", usage: "使い方が分からない", other: "申し込み、そのほか" } as const;
export type ContactKind = keyof typeof KINDS;
export interface Contact {
  contact_id: string; receipt: string; kind: ContactKind; ward_name: string; name: string; reach: string;
  created_at: string; closed_at: string | null; target_ward_id: string | null; target_account_id: string | null;
  verified_how: string | null; verified_person: string | null; verified_by: string | null; verified_at: string | null;
  grant_id: string | null; grant_secret: string | null; grant_expires_at: string | null;
}
export interface Message { message_id: string; sender: "person" | "provider"; body: string; photo_key: string | null; photo_type: string | null; created_at: string }
export interface ContactBindings {
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  CONTACT_MAIL?: { send(message: { to: string; subject: string; text: string }): Promise<void> };
}
export const contactBindings = (env: Env): ContactBindings => env as Env & ContactBindings;
export const contactById = (db: D1Database, id: string) => db.prepare("SELECT * FROM provider_contacts WHERE ward_id = ? AND contact_id = ?")
  .bind(CONTACT_WARD, id).first<Contact>();
export async function contactByToken(db: D1Database, token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  return db.prepare("SELECT * FROM provider_contacts WHERE ward_id = ? AND token_hash = ?")
    .bind(CONTACT_WARD, await sha256Hex(token)).first<Contact>();
}
export async function messages(db: D1Database, id: string) {
  return (await db.prepare("SELECT * FROM provider_contact_messages WHERE ward_id = ? AND contact_id = ? ORDER BY created_at, message_id")
    .bind(CONTACT_WARD, id).all<Message>()).results;
}
/** 同じ端末元は10分に5回。同じ連絡先は1時間に3回まで受付。加算もD1で行う。 */
export async function allowSend(db: D1Database, identity: string, seconds = 600, limit = 5) {
  const hash = await sha256Hex(identity);
  const start = Math.floor(Date.now() / (seconds * 1000)) * seconds;
  const row = await db.prepare(`INSERT INTO provider_contact_throttle (ward_id, identity_hash, window_start, sends)
    VALUES (?, ?, ?, 1) ON CONFLICT (ward_id, identity_hash) DO UPDATE SET
    sends = CASE WHEN window_start = excluded.window_start THEN sends + 1 ELSE 1 END,
    window_start = excluded.window_start RETURNING sends`).bind(CONTACT_WARD, hash, start).first<{ sends: number }>();
  return !!row && row.sends <= limit;
}
function receiptNumber() {
  const digits: string[] = [];
  while (digits.length < 12) {
    for (const b of crypto.getRandomValues(new Uint8Array(24))) {
      if (b < 250 && digits.length < 12) digits.push(String(b % 10));
    }
  }
  return digits.join("");
}
export async function receiveContact(db: D1Database, input: { kind: ContactKind; wardName: string; name: string; reach: string; body: string; submissionId?: string }) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.reach) || input.reach.length > 200) throw new Error("使えるメールアドレスを入れてください");
  if (input.submissionId && !/^[A-Za-z0-9_-]{43}$/.test(input.submissionId)) throw new Error("送る準備ができていません");
  // フォームごとに発行した推測できない値を、やりとりの鍵にも使う。本体は保存しない。
  const id = newId(), token = input.submissionId ?? generateDeviceToken(), stamp = nowIso();
  const hash = await sha256Hex(token);
  const receipt = receiptNumber();
  await db.batch([
    db.prepare(`INSERT INTO provider_contacts (ward_id, contact_id, receipt, token_hash, kind, ward_name, name, reach, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE NOT EXISTS
        (SELECT 1 FROM provider_contacts WHERE ward_id = ? AND token_hash = ?)`)
      .bind(CONTACT_WARD, id, receipt, hash, input.kind, input.wardName, input.name, input.reach, stamp, CONTACT_WARD, hash),
    db.prepare(`INSERT INTO provider_contact_messages (ward_id, contact_id, message_id, sender, body, created_at)
      SELECT ward_id, contact_id, ?, 'person', ?, ? FROM provider_contacts WHERE ward_id = ? AND contact_id = ?`)
      .bind(newId(), input.body, stamp, CONTACT_WARD, id),
  ]);
  const saved = await contactByToken(db, token);
  if (!saved) throw new Error("問い合わせを保存できませんでした");
  return { id: saved.contact_id, token, receipt: saved.receipt, created: saved.contact_id === id };
}
export async function appendMessage(env: Env, contact: Contact, sender: Message["sender"], body: string, photo?: File) {
  const id = newId();
  const key = photo ? `contacts/${contact.contact_id}/${id}` : null;
  if (key && photo) await new WardBucket(env.ORIGINALS, CONTACT_WARD).put(key, photo, { httpMetadata: { contentType: photo.type } });
  try {
    const result = await env.DB.prepare(`INSERT INTO provider_contact_messages
      (ward_id, contact_id, message_id, sender, body, photo_key, photo_type, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE EXISTS
        (SELECT 1 FROM provider_contacts WHERE ward_id = ? AND contact_id = ? AND closed_at IS NULL)`)
      .bind(CONTACT_WARD, contact.contact_id, id, sender, body, key, photo?.type ?? null, nowIso(), CONTACT_WARD, contact.contact_id).run();
    if (!result.meta.changes) throw new Error("受付は閉じています");
  } catch (error) {
    if (key) await new WardBucket(env.ORIGINALS, CONTACT_WARD).delete(key);
    throw error;
  }
}
/** 写真だけを閉じて30日で消す。R2の消去に成功したものから記録を直す。 */
export async function purgeContactPhotos(env: Env) {
  const cutoff = new Date(Date.now() - 30 * 86400_000).toISOString();
  const rows = await env.DB.prepare(`SELECT m.message_id, m.photo_key FROM provider_contact_messages m
    JOIN provider_contacts c ON c.ward_id = m.ward_id AND c.contact_id = m.contact_id
    WHERE m.ward_id = ? AND c.closed_at <= ? AND m.photo_key IS NOT NULL LIMIT 100`)
    .bind(CONTACT_WARD, cutoff).all<{ message_id: string; photo_key: string }>();
  for (const row of rows.results) {
    await new WardBucket(env.ORIGINALS, CONTACT_WARD).delete(row.photo_key);
    await env.DB.prepare("UPDATE provider_contact_messages SET photo_key = NULL, photo_type = NULL WHERE ward_id = ? AND message_id = ?")
      .bind(CONTACT_WARD, row.message_id).run();
  }
}
/** 入るためのリンクは受付と発行のIDから再現し、本体を保存しない。 */
export async function contactInvitationToken(env: Env, contactId: string, linkId: string) {
  if (!env.OPS_PASSWORD) throw new Error("提供側の設定がありません");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.OPS_PASSWORD), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(JSON.stringify([CONTACT_WARD, contactId, linkId]))));
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}
