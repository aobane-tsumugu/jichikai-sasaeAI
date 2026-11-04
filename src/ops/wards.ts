// 区の開設と一覧（運用の画面とスクリプトが共有する）。提供側の仕事で、役員は区の設定をしない。
import { newId, nowIso } from "../core/ids";
import { cleanName } from "../core/password";
import { findWardBySlug, slugProblem } from "../core/ward";
import type { WardInfo } from "../env";
import { addAccount, type Failure } from "../settings/accounts";

export interface WardSummary extends WardInfo {
  createdAt: string;
  accountCount: number;
}

export async function listWards(db: D1Database): Promise<WardSummary[]> {
  const rows = await db
    .prepare(
      `SELECT w.ward_id, w.slug, w.name, w.created_at,
              (SELECT COUNT(*) FROM accounts a WHERE a.ward_id = w.ward_id AND a.removed_at IS NULL) AS account_count
         FROM wards w ORDER BY w.created_at, w.slug`,
    )
    .all<{ ward_id: string; slug: string; name: string; created_at: string; account_count: number }>();
  return rows.results.map((r) => ({
    wardId: r.ward_id,
    slug: r.slug,
    name: r.name,
    createdAt: r.created_at,
    accountCount: r.account_count,
  }));
}

/** 区のスラッグは、打ち込んだ物の前後の空白を除き小文字にして使う。 */
export function normalizeSlug(raw: string): string {
  return raw.trim().toLowerCase();
}

/**
 * 区を開く: 区、最初の役員のアカウントを作る。パスワードは一度だけここで返す。
 * 固定 URL と QR は区のスラッグから決まる（作った後に画面とスクリプトが出す）。
 */
export async function openWard(
  db: D1Database,
  input: { slug: string; name: string; firstAccountName: string },
): Promise<{ ok: true; ward: WardInfo; account: { accountId: string; name: string; password: string } } | Failure> {
  const slug = normalizeSlug(input.slug);
  const slugError = slugProblem(slug);
  if (slugError) return { ok: false, message: slugError };

  const name = cleanName(input.name);
  if (name === "") return { ok: false, message: "区の名前を入れてください。" };
  if (name.length > 60) return { ok: false, message: "区の名前は 60 文字までです。" };

  if (await findWardBySlug(db, slug)) return { ok: false, message: "その区の URL はもう使われています。" };

  const wardId = newId();
  try {
    await db.prepare("INSERT INTO wards (ward_id, slug, name, created_at) VALUES (?, ?, ?, ?)").bind(wardId, slug, name, nowIso()).run();
  } catch {
    // 同時に同じ URL で開かれた時
    return { ok: false, message: "その区の URL はもう使われています。" };
  }

  const account = await addAccount(db, wardId, { name: input.firstAccountName });
  if (!account.ok) {
    // 区だけが残らないよう戻す（まだ他の行は無い）
    await db.prepare("DELETE FROM wards WHERE ward_id = ?").bind(wardId).run();
    return account;
  }
  return {
    ok: true,
    ward: { wardId, slug, name },
    account: { accountId: account.accountId, name: account.name, password: account.password },
  };
}
