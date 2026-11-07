// 区の開設と一覧（運用の画面とスクリプトが共有する）。提供側の仕事で、役員は区の設定をしない。
import { newId, nowIso } from "../core/ids";
import { cleanName } from "../core/password";
import { findWardBySlug, slugProblem } from "../core/ward";
import type { WardInfo } from "../env";
import type { Failure } from "../settings/accounts";
import { createInvitedAccount } from "../core/sign-in";
import { SETTING_KEYS } from "../settings/keys";
import { lineSecretNames } from "../line/api";

export interface WardSummary extends WardInfo {
  createdAt: string;
  accountCount: number;
  attentionCount: number;
}

export async function listWards(db: D1Database): Promise<WardSummary[]> {
  const rows = await db
    .prepare(
      `SELECT w.ward_id, w.slug, w.name, w.created_at,
              (SELECT COUNT(*) FROM accounts a WHERE a.ward_id = w.ward_id AND a.removed_at IS NULL) AS account_count,
              (SELECT COUNT(*) FROM jobs j WHERE j.ward_id = w.ward_id AND j.status IN ('failed', 'attention') AND j.withdrawn_at IS NULL) AS attention_count
         FROM wards w WHERE w.ward_id IS NOT NULL ORDER BY w.created_at, w.slug`,
    )
    .all<{ ward_id: string; slug: string; name: string; created_at: string; account_count: number; attention_count: number }>();
  return rows.results.map((r) => ({
    wardId: r.ward_id,
    slug: r.slug,
    name: r.name,
    createdAt: r.created_at,
    accountCount: r.account_count,
    attentionCount: r.attention_count,
  }));
}

/** 区のスラッグは、打ち込んだ物の前後の空白を除き小文字にして使う。 */
export function normalizeSlug(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * 区を開く: 区、最初の役員のアカウントを作る。入るためのリンクは一度だけここで返す。
 * 固定 URL と QR は区のスラッグから決まる（作った後に画面とスクリプトが出す）。
 */
export async function openWard(
  db: D1Database,
  input: { slug: string; name: string; firstAccountName: string; lineDestination?: string; officialLineUrl?: string },
): Promise<{ ok: true; ward: WardInfo; account: { accountId: string; loginId: string; name: string; token: string; expiresAt: string }; line?: ReturnType<typeof lineSecretNames> } | Failure> {
  const slug = normalizeSlug(input.slug);
  const slugError = slug === "contact" ? "その名前は問い合わせの画面で使っています。別のURLの名前を選んでください。" : slugProblem(slug);
  if (slugError) return { ok: false, message: slugError };

  const name = cleanName(input.name);
  if (name === "") return { ok: false, message: "自治会の名前を入れてください。" };
  if (name.length > 60) return { ok: false, message: "自治会の名前は60文字までです。" };

  if (await findWardBySlug(db, slug)) return { ok: false, message: "その自治会のURLはもう使われています。" };
  const destination = input.lineDestination?.trim() ?? "";
  if (!destination) return { ok: false, message: "自治会のLINEの送信先IDを入れてください。" };
  const lineUrl = input.officialLineUrl?.trim() ?? "";
  try { if (new URL(lineUrl).protocol !== "https:") throw new Error("https"); }
  catch { return { ok: false, message: "友だち追加の入口をhttps://で始まるURLで入れてください。" }; }
  if (lineUrl.length > 2000) return { ok: false, message: "友だち追加の入口を確かめてください。" };
  if (destination.length > 100) return { ok: false, message: "自治会のLINEの送信先IDを確かめてください。" };
  const wardId = newId();
  const line = destination ? lineSecretNames(wardId) : undefined;
  try {
    const statements = [db.prepare("INSERT INTO wards (ward_id, slug, name, created_at) VALUES (?, ?, ?, ?)").bind(wardId, slug, name, nowIso())];
    if (line) statements.push(db.prepare(`INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding)
      VALUES (?, ?, ?, ?)`).bind(wardId, destination, line.channelSecretBinding, line.accessTokenBinding));
    statements.push(db.prepare("INSERT INTO ward_settings (ward_id, key, value) VALUES (?, ?, ?)").bind(wardId, SETTING_KEYS.officialLineUrl, lineUrl));
    await db.batch(statements);
  } catch {
    return { ok: false, message: destination ? "自治会のURLか自治会のLINEの送信先IDはもう使われています。" : "その自治会のURLはもう使われています。" };
  }

  const account = await createInvitedAccount(db, wardId, { name: input.firstAccountName, seatId: null, createdBy: null, provider: true });
  if (!account.ok) {
    await db.batch([
      db.prepare("DELETE FROM ward_settings WHERE ward_id = ?").bind(wardId),
      db.prepare("DELETE FROM line_channels WHERE ward_id = ?").bind(wardId),
      db.prepare("DELETE FROM wards WHERE ward_id = ?").bind(wardId),
    ]);
    return account;
  }
  return {
    ok: true,
    ward: { wardId, slug, name },
    account: { accountId: account.accountId, loginId: account.loginId, name: account.name, token: account.token, expiresAt: account.expiresAt },
    ...(line ? { line } : {}),
  };
}
