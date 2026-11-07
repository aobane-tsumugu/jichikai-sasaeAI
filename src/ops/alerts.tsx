import { lineAccessToken } from "../line/api";
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { Layout, Notice } from "../core/ui";
import { formatJst } from "../core/time";
import { listWards } from "./wards";
import { AI_CREDENTIAL_ALERT, AI_CREDENTIAL_MESSAGE } from "./ai-alert";

const ALERT_LABEL: Record<string, string> = {
  "line.setup": "公式LINEの開設を続けてください",
  "line.delivery_alert.reply": "問い合わせへの返事を送れませんでした",
  "line.delivery_alert.publish": "配ったもののLINEを送れませんでした",
  "line.delivery_alert.digest": "問い合わせの知らせを止めています",
  [AI_CREDENTIAL_ALERT]: "AIにつなぐ鍵の更新に失敗しました",
};
export const alertsRoutes = new Hono<AppEnv>();
alertsRoutes.get("/", async (c) => {
  const wards = await listWards(c.env.DB);
  const alerts = (await Promise.all(wards.map(async (ward) => {
    const result = await c.env.DB.prepare(`SELECT key, value, updated_at FROM ward_settings
      WHERE ward_id = ? AND key IN ('line.delivery_alert.reply', 'line.delivery_alert.publish', 'line.delivery_alert.digest', 'ai.vault_credential.refresh_failed') ORDER BY updated_at DESC`)
      .bind(ward.wardId).all<{ key: string; value: string; updated_at: string }>();
    const rows = result.results.map((r) => ({ ...r, ward }));
    if (!await lineAccessToken(c.env, ward.wardId)) rows.push({ key: "line.setup", value: "公式LINEの接続が済んでいません。提供側で鍵とwebhookの設定を確かめてください。", updated_at: ward.createdAt, ward });
    return rows;
  }))).flat();
  return c.html(<Layout title="提供側で見る知らせ" siteName="SasaeAI 運用の画面" noindex>
    <h1>提供側で見る知らせ</h1><p class="lead">LINEの送信やAIにつなぐ鍵に問題が起きたとき、提供側がここで確かめます。</p>
    {alerts.length ? alerts.map((a) => <section class="panel"><h2>{a.ward.name} {ALERT_LABEL[a.key]}</h2><p>{a.key === AI_CREDENTIAL_ALERT ? AI_CREDENTIAL_MESSAGE : a.value}</p><p class="muted">{formatJst(a.updated_at)}</p>
      <section class="next"><strong>次は</strong><p>{a.key === AI_CREDENTIAL_ALERT ? "手順書に従い、AIの鍵の設定を直してください。読み取りの状況で止まった資料をもう一度動かし、終わったことを確かめます。役員に鍵の設定を頼む必要はありません。" : a.key === "line.setup" ? "公式LINEの接続を済ませ、区の画面で役員グループを指定してください。" : "公式LINEの送れる通数を確かめてください。配ったものと返事は、それぞれの画面で送り直せます。朝の知らせは、送れるようになってから次の処理で動きます。"}</p>
        <a class="button secondary" href={`/ops/wards/${a.ward.slug}${a.key === AI_CREDENTIAL_ALERT ? "/queue" : ""}`}>{a.key === AI_CREDENTIAL_ALERT ? "読み取りの状況へ" : "区の画面へ"}</a></section>
      {a.key === AI_CREDENTIAL_ALERT ? <form method="post" action={`/ops/alerts/wards/${encodeURIComponent(a.ward.wardId)}/ai-resolved`}>
        <input type="hidden" name="updatedAt" value={a.updated_at} /><p>資料の処理が終わり、同じ問題が起きないことを確かめてから押してください。</p><button class="secondary">対応が終わったので知らせを消す</button>
      </form> : null}</section>)
      : <p>今は知らせがありません。送れないものが出たときに、ここへ届きます。</p>}
    <a class="quiet" href="/ops/">区の一覧へ戻る</a>
  </Layout>);
});
alertsRoutes.post("/wards/:wardId/ai-resolved", async (c) => {
  const form = await c.req.parseBody();
  const stamp = typeof form.updatedAt === "string" ? form.updatedAt : "";
  const result = await c.env.DB.prepare("DELETE FROM ward_settings WHERE ward_id = ? AND key = ? AND updated_at = ?")
    .bind(c.req.param("wardId"), AI_CREDENTIAL_ALERT, stamp).run();
  const title = result.meta.changes ? "AIの鍵の知らせを消しました" : "知らせを確かめてください";
  return c.html(<Layout title={title} siteName="SasaeAI 運用の画面" noindex><h1>{title}</h1>
    <Notice>{result.meta.changes ? "同じ問題が起きれば、またここに届きます。" : "新しい知らせが届いたか、すでに消したようです。一覧を開き直してください。"}</Notice>
    <a class="button" href="/ops/alerts">提供側で見る知らせへ戻る</a></Layout>);
});
