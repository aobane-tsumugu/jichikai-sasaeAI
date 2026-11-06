import type { Env } from "../env";
import { newId, nowIso } from "../core/ids";
import { cleanName, generatePassword, generateSalt, hashPassword, nameKey } from "../core/password";
import { createInvitation } from "../core/sign-in";
import { CONTACT_WARD, contactById, grantSecret } from "./store";

/** 全員が交代したときも、提供側が確かめた受付からしか足さない。 */
async function addProviderAccount(db: D1Database, wardId: string, rawName: string) {
  const name = cleanName(rawName);
  if (!name || name.length > 40 || [...name].some((ch) => ch.charCodeAt(0) < 32 || ch.charCodeAt(0) === 127)) {
    return { ok: false as const, message: "足す人の名前を40文字までで入れてください。" };
  }
  const accountId = newId(), salt = generateSalt(), stamp = nowIso();
  const row = await db.prepare(`SELECT COALESCE(MAX(CAST(substr(login_id, 5) AS INTEGER)), 0) + 1 AS next_id
    FROM accounts WHERE ward_id = ? AND login_id GLOB 'user[0-9]*'`).bind(wardId).first<{ next_id: number }>();
  const result = await db.prepare(`INSERT INTO accounts (ward_id, account_id, login_id, name, name_key,
    password_salt, password_hash, password_changed_at, created_at, sign_in_required)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
    WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE ward_id = ? AND name_key = ? AND removed_at IS NULL)`)
    .bind(wardId, accountId, `user${row?.next_id ?? 1}`, name, nameKey(name), salt,
      await hashPassword(generatePassword(), salt), stamp, stamp, wardId, nameKey(name)).run();
  return result.meta.changes ? { ok: true as const, accountId } : { ok: false as const, message: "同じ名前の役員がもうあります。" };
}

export async function issueContactInvitation(env: Env, id: string, input: {
  wardId: string; accountId: string; newName: string; how: string; person: string; origin: string;
}) {
  const contact = await contactById(env.DB, id);
  if (!contact || contact.closed_at || contact.kind !== "access") return { ok: false as const, message: "入れない方の、開いている受付で行ってください。" };
  if (!input.how || !input.person || input.how.length > 1000 || input.person.length > 200) return { ok: false as const, message: "確かめた方法と相手を入れてください。" };
  if (!env.OPS_PASSWORD) return { ok: false as const, message: "提供側の設定を確かめてください。" };
  const ward = await env.DB.prepare("SELECT slug, is_active FROM wards WHERE ward_id = ?").bind(input.wardId).first<{ slug: string; is_active: number }>();
  if (!ward || !ward.is_active) return { ok: false as const, message: "使っている区を選んでください。" };
  if (input.accountId !== "new" && !await env.DB.prepare("SELECT 1 FROM accounts WHERE ward_id = ? AND account_id = ? AND removed_at IS NULL")
    .bind(input.wardId, input.accountId).first()) return { ok: false as const, message: "選んだ区の役員を選んでください。" };
  const claim = newId();
  const held = await env.DB.prepare(`UPDATE provider_contacts SET grant_id = ?, grant_secret = NULL WHERE ward_id = ? AND contact_id = ? AND closed_at IS NULL AND grant_id IS NULL`)
    .bind(claim, CONTACT_WARD, id).run();
  if (!held.meta.changes) return { ok: false as const, message: "この受付では、すでにリンクを出しています。やりとりを確かめてください。" };
  let newAccount: string | undefined;
  let issuedLink: string | undefined;
  try {
    let accountId = input.accountId;
    if (accountId === "new") {
      const added = await addProviderAccount(env.DB, input.wardId, input.newName);
      if (!added.ok) {
        await env.DB.prepare("UPDATE provider_contacts SET grant_id = NULL WHERE ward_id = ? AND contact_id = ? AND grant_id = ?").bind(CONTACT_WARD, id, claim).run();
        return added;
      }
      accountId = added.accountId; newAccount = accountId;
    }
    const result = await createInvitation(env.DB, input.wardId, accountId, { provider: true });
    if (!result.ok) throw new Error("入口を作れませんでした");
    issuedLink = result.linkId;
    const href = new URL(`/${encodeURIComponent(ward.slug)}/admin/invite/${result.token}`, input.origin).href;
    const secret = await grantSecret(env, href);
    await env.DB.prepare(`UPDATE provider_contacts SET target_ward_id = ?, target_account_id = ?,
      verified_how = ?, verified_person = ?, verified_by = ?, verified_at = ?, grant_id = ?, grant_secret = ?, grant_expires_at = ?
      WHERE ward_id = ? AND contact_id = ? AND grant_id = ?`)
      .bind(input.wardId, accountId, input.how, input.person, "SasaeAI 運用", nowIso(), result.linkId, secret, result.expiresAt, CONTACT_WARD, id, claim).run();
    return { ok: true as const, name: result.name, expiresAt: result.expiresAt, linkId: result.linkId };
  } catch (error) {
    // 失敗した入口は残して使わせず、新しい人も入り方を作る前なら戻す。
    if (issuedLink) await env.DB.prepare("UPDATE sign_in_links SET revoked_at = ? WHERE ward_id = ? AND link_id = ? AND used_at IS NULL")
      .bind(nowIso(), input.wardId, issuedLink).run();
    if (newAccount) await env.DB.prepare("DELETE FROM accounts WHERE ward_id = ? AND account_id = ? AND sign_in_completed_at IS NULL")
      .bind(input.wardId, newAccount).run();
    await env.DB.prepare("UPDATE provider_contacts SET grant_id = NULL WHERE ward_id = ? AND contact_id = ? AND grant_id = ?")
      .bind(CONTACT_WARD, id, claim).run();
    throw error;
  }
}
