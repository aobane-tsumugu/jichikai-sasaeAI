import { lineAccessToken } from "../line/api";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { Layout } from "../core/ui";
import { formatJst } from "../core/time";
import { listWards } from "./wards";

const ALERT_LABEL: Record<string, string> = {
  "line.setup": "公式LINEの開設を続けてください",
  "line.delivery_alert.reply": "問い合わせへの返事を送れませんでした",
  "line.delivery_alert.publish": "配ったもののLINEを送れませんでした",
  "line.delivery_alert.digest": "問い合わせの知らせを止めています",
};
export const alertsRoutes = new Hono<AppEnv>();
alertsRoutes.get("/", async (c) => {
  const wards = await listWards(c.env.DB);
  const alerts = (await Promise.all(wards.map(async (ward) => {
    const result = await c.env.DB.prepare(`SELECT key, value, updated_at FROM ward_settings
      WHERE ward_id = ? AND key IN ('line.delivery_alert.reply', 'line.delivery_alert.publish', 'line.delivery_alert.digest') ORDER BY updated_at DESC`)
      .bind(ward.wardId).all<{ key: string; value: string; updated_at: string }>();
    const rows = result.results.map((r) => ({ ...r, ward }));
    if (!await lineAccessToken(c.env, ward.wardId)) rows.push({ key: "line.setup", value: "公式LINEの接続が済んでいません。提供側で鍵とwebhookの設定を確かめてください。", updated_at: ward.createdAt, ward });
    return rows;
  }))).flat();
  return c.html(<Layout title="提供側で見る知らせ" siteName="SasaeAI 運用の画面" noindex>
    <h1>提供側で見る知らせ</h1><p class="lead">LINEを送れないときの知らせです。配ることと返事を先に使い、朝の知らせは止めます。</p>
    {alerts.length ? alerts.map((a) => <section class="panel"><h2>{a.ward.name} {ALERT_LABEL[a.key]}</h2><p>{a.value}</p><p class="muted">{formatJst(a.updated_at)}</p>
      <section class="next"><strong>次は</strong><p>{a.key === "line.setup" ? "公式LINEの接続を済ませ、区の画面で役員グループを指定してください。" : "公式LINEの送れる通数を確かめてください。配ったものと返事は、それぞれの画面で送り直せます。朝の知らせは、送れるようになってから次の処理で動きます。"}</p>
        <a class="button secondary" href={`/ops/wards/${a.ward.slug}`}>区の画面へ</a></section></section>)
      : <p>今は知らせがありません。送れないものが出たときに、ここへ届きます。</p>}
    <a class="quiet" href="/ops/">区の一覧へ戻る</a>
  </Layout>);
});
