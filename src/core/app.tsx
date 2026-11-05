import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { AdminEnv, AppEnv, Env, WardEnv } from "../env";
import { opsRoutes } from "../ops";
import { requireAdmin } from "./auth";
import type { Bundle } from "./bundle";
import { loginRoutes } from "./login";
import { Layout } from "./ui";
import { resolveWard } from "./ward";

/**
 * 経路の組み立て。
 *
 *   /                      入口の案内
 *   /healthz               動作の確認（D1 まで）
 *   /robots.txt            検索に載ってよい。役員画面と運用の画面だけ外す
 *   /hooks/**              区をまたぐ機械向けの受け口（各置き場の hooks）
 *   /ops/**                運用の画面（提供側。束 1）
 *   /:ward/admin/login     役員画面のログイン（束 1）
 *   /:ward/admin/**        役員画面（ログイン必須。各置き場の admin）
 *   /:ward/**              区の中の公開の入口（各置き場の pub）
 *
 * 先に書いた経路が先に当たる。/:ward は最後に置く。
 */
export function createApp(bundles: Bundle[]) {
  // strict: false で /x と /x/ を同じ経路として扱う（QR や手打ちの URL の末尾の / の有無で迷わせない）
  const app = new Hono<AppEnv>({ strict: false });
  app.use("*", secureHeaders());

  app.get("/", (c) =>
    c.html(
      <Layout title="運営支援（仮称）">
        <h1>運営支援（仮称）</h1>
        <p>自治会の役員の準備を支える仕組みです。区のページの URL（案内や掲示の QR に書かれた物）からお入りください。</p>
      </Layout>,
    ),
  );

  app.get("/healthz", async (c) => {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ ok: true });
  });

  app.get("/robots.txt", (c) =>
    c.text("User-agent: *\nDisallow: /ops/\nDisallow: /*/admin/\n"),
  );

  const hooks = new Hono<AppEnv>();
  hooks.use("/line", async (c, next) => {
    let destination = "";
    try {
      const body: unknown = await c.req.raw.clone().json();
      if (typeof body === "object" && body !== null && typeof (body as { destination?: unknown }).destination === "string") {
        destination = (body as { destination: string }).destination;
      }
    } catch {
      return next();
    }
    if (!destination) return next();
    const state = await c.env.DB.prepare(`SELECT w.is_active FROM line_channels l
      JOIN wards w ON w.ward_id = l.ward_id
      WHERE w.ward_id IS NOT NULL AND l.destination = ? LIMIT 1`).bind(destination)
      .first<{ is_active: number }>();
    if (state?.is_active === 0) return c.text("停止中", 503);
    return next();
  });
  for (const bundle of bundles) if (bundle.hooks) hooks.route("/", bundle.hooks);
  app.route("/hooks", hooks);

  app.use("/ops/*", csrf());
  app.route("/ops", opsRoutes);

  const ward = new Hono<WardEnv>();
  ward.use("*", resolveWard);
  ward.use("*", async (c, next) => {
    if (["GET", "HEAD", "OPTIONS"].includes(c.req.method)) return next();
    const state = await c.env.DB.prepare("SELECT is_active FROM wards WHERE ward_id = ?")
      .bind(c.var.ward.wardId).first<{ is_active: number }>();
    if (state?.is_active === 1) return next();
    return c.html(<Layout title="区の運用は停止中" siteName={c.var.ward.name}>
      <h1>区の運用は停止中です</h1>
      <p>区のページの読み取りは続いています。書き込みは受け付けていません。</p>
    </Layout>, 503);
  });
  ward.use("*", csrf());
  ward.route("/admin", loginRoutes);
  const admin = new Hono<AdminEnv>();
  admin.use("*", requireAdmin);
  for (const bundle of bundles) if (bundle.admin) admin.route("/", bundle.admin);
  ward.route("/admin", admin);
  for (const bundle of bundles) if (bundle.pub) ward.route("/", bundle.pub);
  app.route("/:ward", ward);

  app.notFound((c) =>
    c.html(
      <Layout title="見つかりません">
        <h1>見つかりません</h1>
        <p>URL をお確かめください。区のページの URL は、案内や掲示の QR に書かれています。</p>
      </Layout>,
      404,
    ),
  );

  app.onError((err, c) => {
    // csrf の拒否（403）など、意図して返した失敗はそのまま返す
    if (err instanceof HTTPException) return err.getResponse();
    // 中身（鍵、本文）を記録に出さないよう、種類と文だけにする
    console.error("要求の処理に失敗しました", err instanceof Error ? `${err.name}: ${err.message}` : "不明な失敗");
    return c.html(
      <Layout title="うまく動きませんでした">
        <h1>うまく動きませんでした</h1>
        <p>時間をおいて、もう一度お試しください。続く時は、提供側にお知らせください。</p>
      </Layout>,
      500,
    );
  });

  return app;
}

/** Cron。置き場ごとに実行し、一つが失敗しても他を止めない。 */
export async function runScheduled(
  bundles: Record<string, Bundle>,
  event: ScheduledController,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  const entries = Object.entries(bundles).filter(([, b]) => b.scheduled);
  const results = await Promise.allSettled(entries.map(([, b]) => b.scheduled!(event, env, ctx)));
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      const reason = result.reason;
      console.error(
        `Cron が失敗しました: ${entries[i]?.[0]}`,
        reason instanceof Error ? `${reason.name}: ${reason.message}` : "不明な失敗",
      );
    }
  });
}
