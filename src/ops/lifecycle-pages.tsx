import { Hono } from "hono";
import { Layout, Notice } from "../core/ui";
import { WardBucket } from "../core/storage";
import type { AppEnv } from "../env";
import { exportWard, inspectSnapshots, listDeletionMarks, listDeletionQueue, requestJobDeletion, requestWardDeletion } from "./lifecycle";

export const lifecyclePages = new Hono<AppEnv>();

async function findWard(db: D1Database, slug: string) {
  return db.prepare("SELECT ward_id, slug, name, is_active FROM wards WHERE ward_id = (SELECT ward_id FROM wards WHERE slug = ?)")
    .bind(slug).first<{ ward_id: string; slug: string; name: string; is_active: number }>();
}

const Page = (props: { title: string; children?: unknown }) => (
  <Layout title={`${props.title}運用の画面`} siteName="運用の画面（提供側）" noindex headerRight={<><a href="/ops/">区の一覧</a>{" "}<form class="inline" method="post" action="/ops/logout"><button class="secondary">このスマホやパソコンから出る</button></form></>}>
    {props.children as never}
  </Layout>
);

lifecyclePages.get("/wards/:slug/lifecycle", async (c) => {
  const ward = await findWard(c.env.DB, c.req.param("slug"));
  if (!ward) return c.notFound();
  const [queue, snapshots, marks] = await Promise.all([
    listDeletionQueue(c.env.DB, ward.ward_id),
    inspectSnapshots(c.env, ward.ward_id),
    listDeletionMarks(c.env.DB, ward.ward_id),
  ]);
  const latest = snapshots[0];
  return c.html(<Page title={`${ward.name}の保管と消去`}>
    <p><a href={`/ops/wards/${ward.slug}`}>{ward.name}の運用画面へ戻る</a></p>
    <h1>{ward.name}の保管と消去</h1>
    {c.req.query("queued") === "1" ? <Notice>消去の処理を受け付けました。順に進みます。</Notice> : null}
    <h2>日次の写し</h2>
    {latest ? <section class="panel">
      <p>最新: {latest.key.replace("snapshots/daily/", "")} / {latest.capturedAt || "日時を読めません"}</p>
      <p>{latest.valid ? `${latest.tableCount}種類、${latest.rowCount}件を読み取れました。` : `確認できません: ${latest.problem}`}</p>
    </section> : <p>日次の写しはまだありません。</p>}
    <p>戻すときは、写しを別のD1に読み込み、件数と区のIDを確かめてから切り替えます。この画面の検査は形式と区のID、表の並びを確認します。実際の戻しは行いません。</p>
    <h2>写しの一覧</h2>
    {snapshots.length ? <ul>{snapshots.slice(0, 30).map((item) => <li>{item.valid
      ? <a href={`/ops/wards/${ward.slug}/snapshots/${item.key.replace("snapshots/daily/", "").replace(".json", "")}`}>{item.key.replace("snapshots/daily/", "")}</a>
      : item.key.replace("snapshots/daily/", "")} — {item.valid ? `${item.rowCount}件` : item.problem}</li>)}</ul> : <p>表示できる写しはありません。</p>}
    <h2>引渡し</h2>
    <p>区の記録、元の資料、配布したものとR2の内容をJSONファイルで書き出します。保存先を選んでダウンロードしてください。</p>
    <p><a class="button secondary" href={`/ops/wards/${ward.slug}/export`}>区の記録を書き出す</a></p>
    <h2>区を止める</h2>
    <p>{ward.is_active === 1 ? "役員画面への入ると操作を止めます。区のページの読み取りは続きます。" : "停止中です。区のページの読み取りは続いています。"}</p>
    <form method="post" action={`/ops/wards/${ward.slug}/state`}>
      <input type="hidden" name="active" value={ward.is_active === 1 ? "0" : "1"} />
      <button class={ward.is_active === 1 ? "danger" : "secondary"}>{ward.is_active === 1 ? "区を止める" : "区を再開する"}</button>
    </form>
    <h2>区を削除する</h2>
    <p>先に記録を書き出してください。区の記録と保管物、AI側の処理を消し、AI事業者側の設定を使えない状態にして、保管庫を削除します。処理済みの印だけを残します。</p>
    <form method="post" action={`/ops/wards/${ward.slug}/delete`} onsubmit="return confirm('この区の記録を書き出したあとに、区と保管物を削除します。続けますか？')">
      <label><input type="checkbox" name="confirm" value="yes" required /> 書き出しを確認し、この区の削除を依頼します</label>
      <p><button class="danger">区を削除する</button></p>
    </form>
    <h2>消去の進み具合</h2>
    {queue.map((item) => <section class="panel"><p>{item.target_type === "ward" ? "区の削除" : "消す求め"} / {item.state === "complete" ? "完了" : item.state === "error" ? "要対応" : "処理中"}</p>
      <p>受付: {item.requested_at}{item.completed_at ? ` / 完了: ${item.completed_at}` : ""}</p>{item.last_error ? <p class="notice error">{item.last_error}</p> : null}</section>)}
    {queue.length === 0 ? <p>処理はありません。</p> : null}
    <h2>消去済みの印</h2>
    {marks.length ? <ul>{marks.map((mark) => <li>{mark.scope === "ward" ? "区" : "記録"} / {mark.deleted_at}</li>)}</ul> : <p>完了した消去はありません。</p>}
  </Page>);
});

lifecyclePages.get("/wards/:slug/export", async (c) => {
  const ward = await findWard(c.env.DB, c.req.param("slug"));
  if (!ward) return c.notFound();
  const result = await exportWard(c.env, ward.ward_id);
  c.header("Content-Type", "application/json; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`);
  c.header("Cache-Control", "no-store");
  return c.body(result.body);
});

lifecyclePages.get("/wards/:slug/snapshots/:day", async (c) => {
  const ward = await findWard(c.env.DB, c.req.param("slug"));
  if (!ward) return c.notFound();
  const day = c.req.param("day");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return c.notFound();
  const object = await new WardBucket(c.env.ORIGINALS, ward.ward_id).get(`snapshots/daily/${day}.json`);
  if (!object) return c.notFound();
  c.header("Content-Type", "application/json; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="snapshot-${day}.json"`);
  c.header("Cache-Control", "no-store");
  return c.body(await object.arrayBuffer());
});

lifecyclePages.post("/wards/:slug/state", async (c) => {
  const ward = await findWard(c.env.DB, c.req.param("slug"));
  if (!ward) return c.notFound();
  const form = await c.req.parseBody();
  const next = form["active"] === "1" ? 1 : 0;
  await c.env.DB.prepare("UPDATE wards SET is_active = ? WHERE ward_id = ?").bind(next, ward.ward_id).run();
  return c.redirect(`/ops/wards/${ward.slug}/lifecycle`, 303);
});

lifecyclePages.post("/wards/:slug/delete", async (c) => {
  const ward = await findWard(c.env.DB, c.req.param("slug"));
  if (!ward) return c.notFound();
  const form = await c.req.parseBody();
  if (form["confirm"] !== "yes") return c.redirect(`/ops/wards/${ward.slug}/lifecycle`, 303);
  await requestWardDeletion(c.env.DB, ward.ward_id);
  return c.redirect(`/ops/wards/${ward.slug}/lifecycle?queued=1`, 303);
});

lifecyclePages.get("/deletions", async (c) => {
  const rows = await c.env.DB.prepare(`SELECT target_type, state, requested_at, completed_at, last_error
    FROM ops_deletion_queue WHERE ward_id IS NOT NULL ORDER BY requested_at DESC LIMIT 100`)
    .all<{ target_type: string; state: string; requested_at: string; completed_at: string | null; last_error: string }>();
  const marks = await c.env.DB.prepare("SELECT scope, deleted_at FROM ops_deletion_marks WHERE ward_id IS NOT NULL ORDER BY deleted_at DESC LIMIT 100")
    .all<{ scope: string; deleted_at: string }>();
  return c.html(<Page title="消去の状況"><h1>消去の状況</h1>
    {rows.results.map((row) => <section class="panel"><p>{row.target_type === "ward" ? "区の削除" : "記録の消去"} / {row.state === "complete" ? "完了" : row.state === "error" ? "要対応" : "処理中"}</p>
      <p>受付: {row.requested_at}{row.completed_at ? ` / 完了: ${row.completed_at}` : ""}</p>{row.last_error ? <p class="notice error">{row.last_error}</p> : null}</section>)}
    {rows.results.length === 0 ? <p>処理はありません。</p> : null}
    <h2>消去済みの印</h2>
    {marks.results.map((mark) => <p>{mark.scope === "ward" ? "区" : "記録"} / {mark.deleted_at}</p>)}
  </Page>);
});
