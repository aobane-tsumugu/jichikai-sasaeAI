import { newId, nowIso } from "./ids";
import { cleanLoginId, cleanName, generateDeviceToken, generatePassword, generateSalt, hashPassword, nameKey, sha256Hex } from "./password";

export type SignInKind = "password" | "email" | "line";
export const SIGN_IN_LABEL: Record<SignInKind, string> = { password: "IDとパスワード", email: "メール", line: "LINE" };
export interface SignInMethod {
  method_id: string;
  kind: SignInKind;
  email: string | null;
  verified_at: string;
  removed_at: string | null;
}
export interface Invitation {
  account_id: string;
  name: string;
  login_id: string;
  purpose: "invite" | "reset";
}
export const LINK_UNAVAILABLE = "期限が過ぎたか、もう使われました。";

/** 役員と渡すリンクを一緒に作る。本人が選ぶまで使える入り方を作らない。 */
export async function createInvitedAccount(db: D1Database, wardId: string,
  input: { name: string; seatId: string | null; createdBy: string | null; provider?: true }) {
  const name = cleanName(input.name);
  if (!name) return { ok: false as const, message: "名前を入れてください。" };
  if (name.length > 40) return { ok: false as const, message: "名前は40文字までです。" };
  if ([...name].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)) {
    return { ok: false as const, message: "名前に使えない文字があります。" };
  }
  if (input.seatId && !await db.prepare("SELECT 1 FROM seats WHERE ward_id = ? AND seat_id = ? AND removed_at IS NULL")
    .bind(wardId, input.seatId).first()) return { ok: false as const, message: "その役職は見つかりません。" };
  const nextId = async () => {
    const row = await db.prepare(`SELECT COALESCE(MAX(CAST(substr(login_id, 5) AS INTEGER)), 0) + 1 AS number
      FROM accounts WHERE ward_id = ? AND removed_at IS NULL AND login_id GLOB 'user[0-9]*'
        AND substr(login_id, 5) <> '' AND substr(login_id, 5) NOT GLOB '*[^0-9]*'`)
      .bind(wardId).first<{ number: number }>();
    return `user${row?.number ?? 1}`;
  };
  let loginId = /^[A-Za-z0-9]+$/.test(name) ? cleanLoginId(name) : await nextId();
  if (await db.prepare("SELECT 1 FROM accounts WHERE ward_id = ? AND login_id = ? AND removed_at IS NULL").bind(wardId, loginId).first()) loginId = await nextId();
  const accountId = newId();
  const token = generateDeviceToken();
  const salt = generateSalt();
  const stamp = nowIso();
  const expiresAt = new Date(Date.parse(stamp) + 7 * 24 * 3600_000).toISOString();
  const [created] = await db.batch([
    db.prepare(`INSERT INTO accounts (account_id, ward_id, login_id, name, name_key, seat_id, password_salt,
      password_hash, password_changed_at, created_at, created_by_account_id, sign_in_required)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1
      WHERE NOT EXISTS (SELECT 1 FROM accounts WHERE ward_id = ? AND name_key = ? AND removed_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM accounts WHERE ward_id = ? AND login_id = ? AND removed_at IS NULL)`)
      .bind(accountId, wardId, loginId, name, nameKey(name), input.seatId, salt, await hashPassword(generatePassword(), salt), stamp, stamp,
        input.createdBy, wardId, nameKey(name), wardId, loginId),
    db.prepare(`INSERT INTO sign_in_links (link_id, ward_id, account_id, purpose, token_hash, expires_at, created_at, created_by_account_id, created_by_provider)
      SELECT ?, ?, ?, 'invite', ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM accounts WHERE ward_id = ? AND account_id = ?)`)
      .bind(newId(), wardId, accountId, await sha256Hex(token), expiresAt, stamp, input.createdBy, input.provider ? 1 : 0, wardId, accountId),
  ]);
  if (!created?.meta.changes) {
    const duplicate = await db.prepare("SELECT 1 FROM accounts WHERE ward_id = ? AND name_key = ? AND removed_at IS NULL").bind(wardId, nameKey(name)).first();
    return { ok: false as const, message: duplicate ? "同じ名前の役員がもうあります。" : "そのIDはもう使われています。もう一度お試しください。" };
  }
  return { ok: true as const, accountId, loginId, name, token, expiresAt };
}

export async function listSignInMethods(db: D1Database, wardId: string, accountId: string) {
  const result = await db.prepare(`SELECT method_id, kind, email, verified_at, removed_at FROM sign_in_methods
    WHERE ward_id = ? AND account_id = ? ORDER BY verified_at, method_id`).bind(wardId, accountId).all<SignInMethod>();
  return result.results;
}

/** 提供側はU12の本人確認を通った所から呼ぶ。nullの作成者を提供側と取り違えない。 */
export async function createInvitation(db: D1Database, wardId: string, accountId: string,
  actor: { accountId: string } | { provider: true }, link?: { id: string; token: string }) {
  const account = await db.prepare(`SELECT name, sign_in_completed_at FROM accounts
    WHERE ward_id = ? AND account_id = ? AND removed_at IS NULL`).bind(wardId, accountId)
    .first<{ name: string; sign_in_completed_at: string | null }>();
  if (!account) return { ok: false as const, message: "その役員は見つかりません。" };
  const reset = account.sign_in_completed_at !== null;
  const token = link?.token ?? generateDeviceToken();
  const createdAt = nowIso();
  const linkId = link?.id ?? newId();
  const provider = "provider" in actor;
  const expiresAt = new Date(Date.parse(createdAt) + (provider ? 24 : 7 * 24) * 3600_000).toISOString();
  const statements = [
    db.prepare(`UPDATE sign_in_links SET revoked_at = ? WHERE ward_id = ? AND account_id = ?
      AND used_at IS NULL AND revoked_at IS NULL`).bind(createdAt, wardId, accountId),
    // パスワード変更の既存トリガーが動いたあと、パスワードだけを使えなくする。
    db.prepare("UPDATE accounts SET password_salt = ?, password_hash = ?, password_changed_at = ? WHERE ward_id = ? AND account_id = ? AND removed_at IS NULL")
      .bind(generateSalt(), await sha256Hex(generateDeviceToken()), createdAt, wardId, accountId),
    db.prepare("UPDATE sign_in_methods SET removed_at = ? WHERE ward_id = ? AND account_id = ? AND kind = 'password' AND removed_at IS NULL")
      .bind(createdAt, wardId, accountId),
    db.prepare("UPDATE accounts SET sign_in_required = ? WHERE ward_id = ? AND account_id = ? AND removed_at IS NULL")
      .bind(reset ? 0 : 1, wardId, accountId),
  ];
  statements.push(db.prepare(`INSERT INTO sign_in_links
    (link_id, ward_id, account_id, purpose, token_hash, expires_at, created_at, created_by_account_id, created_by_provider)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(linkId, wardId, accountId, reset ? "reset" : "invite",
    await sha256Hex(token), expiresAt, createdAt, provider ? null : actor.accountId, provider ? 1 : 0));
  await db.batch(statements);
  return { ok: true as const, linkId, token, name: account.name, reset, expiresAt, provider };
}

export async function readInvitation(db: D1Database, wardId: string, token: string): Promise<Invitation | null> {
  return db.prepare(`SELECT a.account_id, a.name, a.login_id, l.purpose FROM sign_in_links l
    JOIN accounts a ON a.ward_id = l.ward_id AND a.account_id = l.account_id
    WHERE l.ward_id = ? AND l.token_hash = ? AND l.purpose IN ('invite', 'reset') AND l.used_at IS NULL
      AND l.revoked_at IS NULL AND l.expires_at > ? AND a.removed_at IS NULL`)
    .bind(wardId, await sha256Hex(token), nowIso()).first<Invitation>();
}

/** 一度だけの入口の取得と、入り方の保存を同じbatchで行う。二重送信では二人目に端末を渡さない。 */
async function finishMethod(db: D1Database, wardId: string,
  grant: { token: string } | { accountId: string },
  method: { kind: SignInKind; subject: string; email: string | null },
  password?: { salt: string; hash: string }) {
  const stamp = nowIso();
  const completionId = newId();
  const invitation = "token" in grant ? await readInvitation(db, wardId, grant.token) : null;
  if ("token" in grant && !invitation) return { ok: false as const, message: LINK_UNAVAILABLE };
  const accountId = invitation?.account_id ?? ("accountId" in grant ? grant.accountId : "");
  const statements: D1PreparedStatement[] = [];
  let guard = "EXISTS (SELECT 1 FROM accounts WHERE ward_id = ? AND account_id = ? AND removed_at IS NULL AND sign_in_required = 0)";
  let guardValues: string[] = [wardId, accountId];
  if ("token" in grant) {
    statements.push(db.prepare(`UPDATE sign_in_links SET used_at = ?, completion_id = ?
      WHERE ward_id = ? AND token_hash = ? AND purpose IN ('invite', 'reset') AND used_at IS NULL
        AND revoked_at IS NULL AND expires_at > ?
        AND EXISTS (SELECT 1 FROM accounts a WHERE a.ward_id = ? AND a.account_id = sign_in_links.account_id AND a.removed_at IS NULL)`)
      .bind(stamp, completionId, wardId, await sha256Hex(grant.token), stamp, wardId));
    guard = "EXISTS (SELECT 1 FROM sign_in_links WHERE ward_id = ? AND account_id = ? AND completion_id = ?)";
    guardValues = [wardId, accountId, completionId];
  }
  statements.push(db.prepare(`INSERT INTO sign_in_methods (method_id, ward_id, account_id, kind, subject, email, verified_at)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${guard}
    ON CONFLICT (ward_id, account_id, kind) DO UPDATE SET subject = excluded.subject, email = excluded.email,
      verified_at = excluded.verified_at, removed_at = NULL`)
    .bind(newId(), wardId, accountId, method.kind, method.kind === "password" ? accountId : method.subject, method.email, stamp, ...guardValues));
  statements.push(password
    ? db.prepare(`UPDATE accounts SET password_salt = ?, password_hash = ?, password_changed_at = ?,
        sign_in_required = 0, sign_in_completed_at = COALESCE(sign_in_completed_at, ?)
        WHERE ward_id = ? AND account_id = ? AND ${guard}`)
      .bind(password.salt, password.hash, stamp, stamp, wardId, accountId, ...guardValues)
    : db.prepare(`UPDATE accounts SET sign_in_required = 0, sign_in_completed_at = COALESCE(sign_in_completed_at, ?)
        WHERE ward_id = ? AND account_id = ? AND ${guard}`).bind(stamp, wardId, accountId, ...guardValues));
  const results = await db.batch(statements);
  if (!results[0]?.meta.changes) return { ok: false as const, message: LINK_UNAVAILABLE };
  const account = await db.prepare("SELECT login_id, name FROM accounts WHERE ward_id = ? AND account_id = ? AND removed_at IS NULL")
    .bind(wardId, accountId).first<{ login_id: string; name: string }>();
  if (!account) return { ok: false as const, message: "その役員は見つかりません。" };
  return { ok: true as const, accountId, loginId: account.login_id, name: account.name };
}

export async function createPasswordSignIn(db: D1Database, wardId: string, grant: { token: string } | { accountId: string }) {
  const password = generatePassword();
  const salt = generateSalt();
  const result = await finishMethod(db, wardId, grant, { kind: "password", subject: "", email: null }, { salt, hash: await hashPassword(password, salt) });
  return result.ok ? { ...result, password } : result;
}

/** 外の接続が本人を確かめたあとだけ呼ぶ。ブラウザから送られたIDやメールでは呼ばない。 */
export async function connectVerifiedSignIn(db: D1Database, wardId: string, grant: { token: string } | { accountId: string },
  identity: { kind: "line"; subject: string } | { kind: "email"; email: string }) {
  const subject = identity.kind === "email" ? identity.email.trim().toLowerCase() : identity.subject.trim();
  if (!subject || (identity.kind === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(subject))) {
    return { ok: false as const, message: "つなげませんでした。もう一度お試しください。" };
  }
  return finishMethod(db, wardId, grant, { kind: identity.kind, subject, email: identity.kind === "email" ? subject : null });
}

export async function findVerifiedSignIns(db: D1Database, wardId: string,
  identity: { kind: "email" | "line"; subject: string }) {
  const rows = await db.prepare(`SELECT a.account_id, a.name, a.login_id FROM sign_in_methods m JOIN accounts a ON a.ward_id = m.ward_id AND a.account_id = m.account_id
    WHERE m.ward_id = ? AND m.kind = ? AND m.subject = ? AND m.removed_at IS NULL AND a.removed_at IS NULL AND a.sign_in_required = 0`)
    .bind(wardId, identity.kind, identity.kind === "email" ? identity.subject.trim().toLowerCase() : identity.subject)
    .all<{ account_id: string; name: string; login_id: string }>();
  return rows.results;
}

