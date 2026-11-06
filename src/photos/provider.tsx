import { Hono } from "hono";
import { csrf } from "hono/csrf";
import { getCookie } from "hono/cookie";
import type { AppEnv } from "../env";
import { Layout, Notice } from "../core/ui";
import { OPS_COOKIE, verifyOpsSession } from "../ops/session";
import { photoBindings, saveWardPhotoPolicy } from "./policy";

// 提供側の認証を必須にし、役員の入口へは登録しない。
export const photoProvider = new Hono<AppEnv>();
// hooksにはLINEやAIの受け口も差し込まれる。この設定の経路だけを提供側の認証で守る。
photoProvider.use("/photo-settings/:wardId", csrf());
photoProvider.use("/photo-settings/:wardId", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  c.header("X-Robots-Tag", "noindex");
  if (!await verifyOpsSession(c.env, getCookie(c, OPS_COOKIE))) return c.redirect("/ops/login", 303);
  return next();
});
photoProvider.get("/photo-settings/:wardId", async (c) => {
  const wardId = c.req.param("wardId");
  const ward = await c.env.DB.prepare("SELECT name FROM wards WHERE ward_id = ?").bind(wardId).first<{ name: string }>();
  if (!ward) return c.notFound();
  const policy = await c.env.DB.prepare("SELECT enabled, quality_report_sha256 FROM ward_photo_policy WHERE ward_id = ?")
    .bind(wardId).first<{ enabled: number; quality_report_sha256: string }>();
  return c.html(<Layout title="報告の写真の設定" noindex>
    <h1>{ward.name}の報告の写真</h1><p>提供側が処理と測定の結果を確かめてから、写真を使えるようにします。</p>
    {c.req.query("saved") ? <Notice>写真の設定を保存しました。</Notice> : null}
    {!photoBindings(c.env).FACE_MASK ? <Notice>写真を処理する準備がまだ済んでいません。有効にはできません。</Notice> : null}
    <form method="post"><label><input type="checkbox" name="enabled" value="yes" checked={policy?.enabled === 1} />報告に写真を使えるようにする</label>
      <label>測定結果のSHA-256<input name="qualityReportSha256" value={policy?.quality_report_sha256} pattern="[a-f0-9]{64}" required /></label>
      <button>保存する</button>
    </form><a class="button secondary" href="/ops">運用の画面へ戻る</a>
  </Layout>);
});
photoProvider.post("/photo-settings/:wardId", async (c) => {
  const wardId = c.req.param("wardId");
  const exists = await c.env.DB.prepare("SELECT ward_id FROM wards WHERE ward_id = ?").bind(wardId).first();
  if (!exists) return c.notFound();
  const form = await c.req.formData();
  const enabled = form.get("enabled") === "yes";
  try {
    if (enabled && !photoBindings(c.env).FACE_MASK) throw new Error("準備が済んでいません。");
    await saveWardPhotoPolicy(c.env.DB, wardId, { enabled, authorApprovedAt: new Date().toISOString(),
      qualityReportSha256: String(form.get("qualityReportSha256") ?? ""), providerId: c.env.OPS_ID ?? "" });
    return c.redirect(`/hooks/photo-settings/${encodeURIComponent(wardId)}?saved=1`, 303);
  } catch {
    return c.html(<Layout title="写真の設定を確かめてください" noindex><h1>写真の設定を保存できませんでした</h1>
      <p>処理する準備と測定結果のSHA-256を確かめてください。</p><a class="button" href={`/hooks/photo-settings/${encodeURIComponent(wardId)}`}>設定に戻る</a></Layout>, 400);
  }
});
