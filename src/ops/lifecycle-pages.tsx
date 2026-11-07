import { Hono } from "hono";
import { Layout, Notice } from "../core/ui";
import { formatJstDate, formatJst } from "../core/time";
import { WardBucket } from "../core/storage";
import type { AppEnv } from "../env";
import { exportWard, inspectSnapshots, listDeletionMarks, listDeletionQueue, requestJobDeletion, requestWardDeletion } from "./lifecycle";

export const lifecyclePages = new Hono<AppEnv>();

async function findWard(db: D1Database, slug: string) {
  return db.prepare("SELECT ward_id, slug, name, is_active FROM wards WHERE ward_id = (SELECT ward_id FROM wards WHERE slug = ?)")
    .bind(slug).first<{ ward_id: string; slug: string; name: string; is_active: number }>();
}

const Page = (props: { title: string; children?: unknown }) => (
  <Layout title={`${props.title}運用の画面`} siteName="SasaeAI 運用の画面" noindex headerRight={<><a href="/ops/">自治会の一覧</a>{" "}<form class="inline" method="post" action="/ops/logout"><button class="secondary">ログアウトする</button></form></>}>
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
    <p class="link-line"><a href={`/ops/wards/${ward.slug}`}>{ward.name}の運用画面へ戻る</a></p>
    <h1>{ward.name}の保管と消去</h1><p class="lead">自治会の記録をほかへ引き渡す、毎日の控えを見る、自治会を止める、自治会の消去を、ここでします。</p>
    {c.req.query("state") === "stopped" ? <><Notice>自治会を止めました</Notice><p>役員の画面に入れなくなりました。住民向けのページの読み取りは続いています。</p><section class="next"><strong>次は</strong><p>戻すときは、下の「自治会を再開する」を押してください。</p></section></> : c.req.query("state") === "active" ? <><Notice>自治会を再開しました</Notice><section class="next"><strong>次は</strong><p>役員の画面を使えます。自治会の方に再開を伝えてください。</p></section><p>間違えたときは、下の「自治会を止める」で止められます。</p></> : null}
    {c.req.query("queued") === "1" ? <><Notice>消去の処理を受け付けました</Notice><section class="next"><strong>次は</strong><p>順に進みます。進み具合は、下の「消去の進み具合」で見られます。</p><a class="button" href="#deletion-progress">消去の進み具合を見る</a></section><p>消去した自治会は戻せません。頼む前に書き出した記録は、手元に残してください。</p></> : null}
    <h2>毎日の控え</h2>
    {latest ? <section class="panel">
      <p>いちばん新しい控え　{latest.capturedAt ? formatJst(latest.capturedAt) : snapshotLabel(latest.key)}</p>
      <p>{latest.valid ? `${latest.tableCount}種類の表、${latest.rowCount}件を読み取れました。` : `確認できません: ${latest.problem}`}</p>
    </section> : <p>毎日の控えはまだありません。</p>}
    <p>戻すときは、控えを別の保管先に読み込み、件数と、この自治会の控えかどうかを確かめてから、切り替えます。この画面の検査は、書き方と、この自治会の控えかどうか、表の並びを確かめます。実際の戻しは、この画面ではしません。</p>
    <h2>控えの一覧</h2>
    {snapshots.length ? <ul>{snapshots.slice(0, 30).map((item) => <li>{item.valid
      ? <a href={`/ops/wards/${ward.slug}/snapshots/${item.key.replace("snapshots/daily/", "").replace(".json", "")}`}>{snapshotLabel(item.key)}</a>
      : snapshotLabel(item.key)} — {item.valid ? `${item.rowCount}件` : item.problem}</li>)}</ul> : <p>表示できる控えはありません。</p>}
    <h2>ほかへ引き渡す</h2>
    <p>自治会の記録、元の資料、これまでに知らせたもの、保管場所の中身を、一つのファイルに書き出します。中身は読める形の文字で書かれます。保存する場所を選んで、保存してください。</p>
    <p><a class="button secondary" href={`/ops/wards/${ward.slug}/export`}>自治会の記録を書き出す</a></p>
    <h2>自治会を止める</h2>
    <p>{ward.is_active === 1 ? "役員の画面に入れなくなり、操作も止まります。住民向けのページの読み取りは続きます。いつでも再開できます。" : "いま止まっています。役員の画面には入れず、操作もできません。住民向けのページの読み取りは続いています。"}</p>
    <form method="post" action={`/ops/wards/${ward.slug}/state`}>
      <input type="hidden" name="active" value={ward.is_active === 1 ? "0" : "1"} />
      <button class="secondary">{ward.is_active === 1 ? "自治会を止める" : "自治会を再開する"}</button>
    </form>
    <h2>自治会を削除する</h2>
    <p>先に、上の「自治会の記録を書き出す」を済ませてください。自治会の記録と保管しているもの、AIの処理を消去し、AIの提供元に預けた設定を使えない状態にして、保管場所を削除します。処理が済んだ印だけが残ります。</p>
    <p>削除は、元に戻せません。</p><form method="post" action={`/ops/wards/${ward.slug}/delete`}>
      <label><input type="checkbox" name="confirm" value="yes" required /> 書き出しを確かめ、この自治会の削除を頼みます</label>
      <p><button class="danger">自治会を削除する</button></p>
    </form>
    <h2 id="deletion-progress">消去の進み具合</h2>
    {queue.map((item) => <section class="panel"><p>{item.target_type === "ward" ? "自治会の削除" : "消す手続き"} / {item.state === "complete" ? "完了" : item.state === "error" ? "要対応" : "処理中"}</p>
      <p>受付: {item.requested_at}{item.completed_at ? ` / 完了: ${item.completed_at}` : ""}</p>{item.last_error ? <p class="notice error">{item.last_error}</p> : null}</section>)}
    {queue.length === 0 ? <p>いま、進めている消去はありません。</p> : null}
    <h2>消去が済んだ記録</h2>
    {marks.length ? <ul>{marks.map((mark) => <li>{mark.scope === "ward" ? "自治会" : "記録"} / {mark.deleted_at}</li>)}</ul> : <p>この自治会で、済んだ消去はありません。</p>}
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
  return c.redirect(`/ops/wards/${ward.slug}/lifecycle?state=${next === 1 ? "active" : "stopped"}`, 303);
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
    {rows.results.map((row) => <section class="panel"><p>{row.target_type === "ward" ? "自治会の削除" : "記録の消去"} / {row.state === "complete" ? "完了" : row.state === "error" ? "要対応" : "処理中"}</p>
      <p>受付: {row.requested_at}{row.completed_at ? ` / 完了: ${row.completed_at}` : ""}</p>{row.last_error ? <p class="notice error">{row.last_error}</p> : null}</section>)}
    {rows.results.length === 0 ? <p>処理はありません。</p> : null}
    <h2>消去が済んだ記録</h2>
    {marks.results.map((mark) => <p>{mark.scope === "ward" ? "自治会" : "記録"} / {mark.deleted_at}</p>)}
  </Page>);
});

function snapshotLabel(key: string): string {
  const day = key.match(/(\d{4}-\d{2}-\d{2})\.json$/)?.[1];
  return day ? `${formatJstDate(day).replace(/（[^）]*）/, "")}の控え` : "日付が分からない控え";
}
