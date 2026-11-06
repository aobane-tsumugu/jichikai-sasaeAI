import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import type { AdminEnv, AppEnv, Env, WardEnv } from "../env";
import { opsRoutes } from "../ops";
import { requireAdmin } from "./auth";
import type { Bundle } from "./bundle";
import { loginRoutes } from "./login";
import { Layout, ProviderContact, WardStopped } from "./ui";
import { resolveWard } from "./ward";
import { contactRoutes } from "../contact/pages";
import { purgeContactPhotos } from "../contact/store";

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
      <Layout title="SasaeAI">
        <h1>SasaeAI</h1>
        <p>自治会の役員の準備を支える仕組みです。区のページのURL（案内や掲示のQRに書かれたもの）からお入りください。</p>
        <a class="quiet" href="/contact">SasaeAIに問い合わせる</a>
      </Layout>,
    ),
  );

  app.get("/healthz", async (c) => {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ ok: true });
  });

  app.get("/robots.txt", (c) =>
    c.text("User-agent: *\nDisallow: /ops/\nDisallow: /contact/\nDisallow: /*/admin/\n"),
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
  app.route("/contact", contactRoutes);

  const ward = new Hono<WardEnv>();
  ward.use("*", resolveWard);
  ward.use("*", async (c, next) => {
    const reading = ["GET", "HEAD", "OPTIONS"].includes(c.req.method);
    const officer = /^\/[^/]+\/admin(?:\/|$)/.test(c.req.path);
    if (reading && !officer) return next();
    const state = await c.env.DB.prepare("SELECT is_active FROM wards WHERE ward_id = ?")
      .bind(c.var.ward.wardId).first<{ is_active: number }>();
    if (state?.is_active === 1) return next();
    c.header("Cache-Control", "private, no-store");
    return c.html(<WardStopped wardName={c.var.ward.name} homeHref={`/${encodeURIComponent(c.var.ward.slug)}/`} />, 503);
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
        <p class="lead">アドレスが違うか、ページが下げられたようです。</p>
        <section class="next"><strong>次は</strong><p>紙のQRコードをもう一度読むか、案内に書かれたアドレスを確かめてください。</p></section>
        <a class="quiet" href={c.req.param("ward") ? `/${encodeURIComponent(c.req.param("ward")!)}/` : "/"}>最初の画面に戻る</a>
        
      </Layout>,
      404,
    ),
  );

  app.onError((err, c) => {
    // csrf の拒否（403）など、意図して返した失敗はそのまま返す
    if (err instanceof HTTPException) return err.getResponse();
    // 中身（鍵、本文）を記録に出さないよう、失敗の種類だけにする
    console.error("要求の処理に失敗しました", err instanceof Error ? err.name : "不明な失敗");
    return c.html(
      <Layout title="うまく動きませんでした">
        <h1>うまく動きませんでした</h1>
        <div class="notice warn"><strong>今は、この画面を開けません</strong><p>時間をおくと開けることがあります。</p></div>
        <section class="next"><strong>次は</strong><p>時間をおいて、もう一度開いてください。</p><a class="button" href={c.req.path}>もう一度開く</a></section>
        <a class="quiet" href={c.req.param("ward") ? `/${encodeURIComponent(c.req.param("ward")!)}/` : "/"}>最初の画面に戻る</a>
        
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
  const results = await Promise.allSettled([...entries.map(([, b]) => b.scheduled!(event, env, ctx)), purgeContactPhotos(env)]);
  results.forEach((result, i) => {
    if (result.status === "rejected") {
      const reason = result.reason;
      console.error(
        `Cronが失敗しました: ${entries[i]?.[0] ?? "問い合わせの写真の消去"}`,
        reason instanceof Error ? `${reason.name}: ${reason.message}` : "不明な失敗",
      );
    }
  });
}
