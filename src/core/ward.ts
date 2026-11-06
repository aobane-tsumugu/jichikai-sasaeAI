import type { MiddlewareHandler } from "hono";
import type { WardEnv, WardInfo } from "../env";

/** 区のスラッグにできない語。先頭の経路や各束の入口と重なる物。 */
const RESERVED_SLUGS = new Set([
  "ops",
  "hooks",
  "healthz",
  "assets",
  "static",
  "api",
  "admin",
  "login",
  "logout",
  "mcp",
  "webhooks",
  "www",
  "line",
  "answer",
  "space",
  "print",
]);

const SLUG_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** 区のスラッグとして使えるか。使えなければ画面に出せる理由を返す。 */
export function slugProblem(slug: string): string | null {
  if (slug.length < 2 || slug.length > 40) return "区のURLは2文字から40文字にしてください。";
  if (!SLUG_PATTERN.test(slug)) return "区のURLは、小文字の英数字とハイフンだけで、ハイフンを先頭と末尾に置けません。";
  if (RESERVED_SLUGS.has(slug)) return "この語は区のURLに使えません。";
  return null;
}

export async function findWardBySlug(db: D1Database, slug: string): Promise<WardInfo | null> {
  const row = await db
    .prepare("SELECT ward_id, slug, name FROM wards WHERE slug = ?")
    .bind(slug)
    .first<{ ward_id: string; slug: string; name: string }>();
  return row ? { wardId: row.ward_id, slug: row.slug, name: row.name } : null;
}

/** /:ward/** で区を決める。区が無ければ 404。 */
export const resolveWard: MiddlewareHandler<WardEnv> = async (c, next) => {
  const slug = c.req.param("ward") ?? "";
  const ward = await findWardBySlug(c.env.DB, slug);
  if (!ward) return c.notFound();
  c.set("ward", ward);
  await next();
};

/** 区のページの固定 URL の根（末尾の / なし）。 */
export function baseUrl(env: { PUBLIC_BASE_URL?: string }, requestUrl: string): string {
  const configured = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  return configured || new URL(requestUrl).origin;
}

/** 区のページの固定 URL。例 https://example.workers.dev/<slug>/ */
export function wardUrl(env: { PUBLIC_BASE_URL?: string }, requestUrl: string, slug: string): string {
  return `${baseUrl(env, requestUrl)}/${slug}/`;
}
