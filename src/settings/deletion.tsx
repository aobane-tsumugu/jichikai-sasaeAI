import { Hono, type Context } from "hono";
import { AdminPage } from "../core/admin-ui";
import { adminPath } from "../core/auth";
import { Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { requestAnswerDeletion, requestJobDeletion, requestProjectDeletion } from "../ops/lifecycle";

export const deletion = new Hono<AdminEnv>();

/** 受けた日時を日本時間で出す。 */
function shownAt(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

const sourceWord = (source: string) => source === "phone" ? "電話" : source === "line" ? "LINE" : "スマホ";

interface Found { key: string; text: string }

/**
 * 頼んだ住民の名前で、その人の分を探す。出欠の返事は世帯の代表者の名前、LINE で届いた物と問い合わせは送った人の名前で探す。
 * 似た名前の別の人が混ざることがあるので、消す物は一つずつ選べるようにし、まとめて消すボタンは選んだ物だけを消す。
 */
async function findByName(db: D1Database, wardId: string, name: string): Promise<Found[]> {
  const like = `%${name.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  const [answers, items, inquiries] = await Promise.all([
    db.prepare(`SELECT a.answer_id, a.household, a.district, a.source, a.created_at, p.title, o.job_id
      FROM project_answers a JOIN projects p ON p.ward_id = a.ward_id AND p.project_id = a.project_id
      LEFT JOIN originals o ON o.ward_id = a.ward_id AND o.original_id = a.original_id
      WHERE a.ward_id = ? AND a.household LIKE ? ESCAPE '\\' ORDER BY a.created_at DESC LIMIT 50`).bind(wardId, like)
      .all<{ answer_id: string; household: string; district: string; source: string; created_at: string; title: string; job_id: string | null }>(),
    db.prepare(`SELECT i.job_id, i.original_kind, i.original_text, i.received_at, i.sender_display_name, p.title
      FROM line_inbox_items i JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id
      LEFT JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id
      WHERE i.ward_id = ? AND i.sender_display_name LIKE ? ESCAPE '\\' AND j.withdrawn_at IS NULL ORDER BY i.received_at DESC LIMIT 50`).bind(wardId, like)
      .all<{ job_id: string; original_kind: string; original_text: string | null; received_at: string; sender_display_name: string; title: string | null }>(),
    db.prepare(`SELECT inquiry_id, subject, received_at, line_sender_label FROM inquiry_records
      WHERE ward_id = ? AND line_sender_label LIKE ? ESCAPE '\\' ORDER BY received_at DESC LIMIT 50`).bind(wardId, like)
      .all<{ inquiry_id: string; subject: string; received_at: string; line_sender_label: string }>(),
  ]);
  const seenJobs = new Set<string>();
  const found: Found[] = [];
  for (const a of answers.results) {
    if (a.job_id) {
      if (seenJobs.has(a.job_id)) continue;
      seenJobs.add(a.job_id);
      found.push({ key: `job:${a.job_id}`, text: `${a.title}の出欠の返事（${a.district}、${a.household}さん。回答票の写真から入ったもので、写真ごと消します）` });
    } else {
      found.push({ key: `answer:${a.answer_id}`, text: `${a.title}の出欠の返事（${a.district}、${a.household}さん。${shownAt(a.created_at)}に${sourceWord(a.source)}で受けたもの）` });
    }
  }
  for (const item of items.results) {
    if (seenJobs.has(item.job_id)) continue;
    seenJobs.add(item.job_id);
    const what = item.original_kind === "image" ? "写真" : `文「${(item.original_text ?? "").slice(0, 40)}」`;
    found.push({ key: `job:${item.job_id}`, text: `${item.sender_display_name}さんが${shownAt(item.received_at)}に自治会のLINEに送った${what}（${item.title ? `${item.title}の資料` : "自治会の資料"}）` });
  }
  for (const row of inquiries.results) {
    found.push({ key: `inquiry:${row.inquiry_id}`, text: `${row.line_sender_label}さんからの問い合わせ「${row.subject.slice(0, 40)}」（${shownAt(row.received_at)}）` });
  }
  return found;
}

// 住民の名前は URL に入れない（ブラウザの履歴と記録に残るため）。探す時は送信の中身で受け、その場で結果を返す。
deletion.get("/", (c) => deletionPage(c, ""));
deletion.post("/search", async (c) => {
  const form = await c.req.formData();
  return deletionPage(c, String(form.get("name") ?? ""));
});

async function deletionPage(c: Context<AdminEnv>, rawName: string) {
  const { ward, account } = c.var;
  const name = rawName.trim().slice(0, 40);
  const found = name ? await findByName(c.env.DB, ward.wardId, name) : null;
  const jobs = await c.env.DB.prepare(`SELECT j.job_id, j.created_at, j.via, o.filename, o.kind, p.title,
      (SELECT i.sender_display_name FROM line_inbox_items i WHERE i.ward_id = j.ward_id AND i.job_id = j.job_id LIMIT 1) AS sender
    FROM jobs j JOIN originals o ON o.ward_id = j.ward_id AND o.job_id = j.job_id
    LEFT JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id
    WHERE j.ward_id = ? AND ((j.withdrawn_at IS NULL AND o.withdrawn_at IS NULL)
      OR EXISTS (SELECT 1 FROM ops_deletion_queue q WHERE q.ward_id = j.ward_id AND q.target_type = 'job' AND q.target_id = j.job_id))
    GROUP BY j.job_id ORDER BY j.created_at DESC LIMIT 100`).bind(ward.wardId)
    .all<{ job_id: string; created_at: string; via: string; filename: string; kind: string; title: string | null; sender: string | null }>();
  const queue = await c.env.DB.prepare(`SELECT state, COUNT(*) AS count FROM ops_deletion_queue
    WHERE ward_id = ? AND target_type IN ('job', 'answer', 'project', 'inquiry', 'help_offer') GROUP BY state`).bind(ward.wardId)
    .all<{ state: string; count: number }>();
  const counts = new Map(queue.results.map((row) => [row.state, row.count]));
  // Web と電話で受けた回答は原本を持たないので、記録の消去とは別に一件ずつ消す。
  const answers = await c.env.DB.prepare(`SELECT a.answer_id, a.household, a.district, a.source, a.created_at, p.title
    FROM project_answers a JOIN projects p ON p.ward_id = a.ward_id AND p.project_id = a.project_id
    WHERE a.ward_id = ? AND a.original_id IS NULL ORDER BY a.created_at DESC LIMIT 200`).bind(ward.wardId)
    .all<{ answer_id: string; household: string; district: string; source: string; created_at: string; title: string }>();
  const working = (counts.get("pending") ?? 0) + (counts.get("running") ?? 0);
  const failed = counts.get("error") ?? 0;
  return c.html(<AdminPage ward={ward} account={account} title="住民から頼まれたものを消す" back={{ href: adminPath(ward, "/settings"), label: "自治会の設定" }}>
    <h1>住民から頼まれたものを消す</h1>
    <p class="lead">住民の方から「自分の分を消してほしい」と頼まれたときに使います。消すと元に戻せません。</p>
    {c.req.query("queued") === "1" ? <Notice>消す手続きを受け付けました。写真や資料は、毎日とっている予備の写しからも続けて消します。この画面を閉じても続きます。</Notice> : null}
    {c.req.query("answer") === "1" ? <Notice>返事を消しました。毎日とっている予備の写しからも、続けて消します。</Notice> : null}
    {c.req.query("project") === "1" ? <Notice>準備を丸ごと消す手続きを受け付けました。この画面を閉じても続きます。</Notice> : null}
    {working || failed ? <p>{working ? `今、${working}件を消しているところです。` : ""}{failed ? `${failed}件は消せずに止まっています。SasaeAIの運営者が直します。` : ""}</p> : null}
    <form method="post" action={adminPath(ward, "/settings/deletion/search")}>
      <div class="field"><label for="name">頼んだ方のお名前</label><input id="name" name="name" maxlength={40} value={name} /><p class="help-text">名字だけでも探せます。出欠の返事は世帯の代表者の名前で、LINEで届いたものと問い合わせは送った人の名前で探します。</p></div>
      <button class="button">この名前で探す</button>
    </form>
    {found ? found.length ? <section class="panel">
      <p>「{name}」で探すと、次の{found.length}つが見つかりました。似た名前の別の方の分が混ざっていたら、印を外してください。</p>
      <form method="post" action={adminPath(ward, "/settings/deletion/person")} onsubmit="return confirm('選んだものを消します。元に戻せません。続けますか？')">
        <div class="choice">{found.map((item) => <label><input type="checkbox" name="target" value={item.key} checked /> {item.text}</label>)}</div>
        <button class="secondary danger">選んだものを消す（元に戻せません）</button>
      </form>
    </section> : <p>「{name}」さんの分は見つかりませんでした。名字だけや、ひらがなでも探してみてください。下の「名前で見つからないとき」から、一つずつ選んで消すこともできます。</p> : null}
    <details class="fold"><summary>名前で見つからないとき</summary><div>
      <p>届いた写真やファイルと、電話やスマホで受けた出欠の返事を、新しい順に並べています。消したいものを一つずつ選んでください。</p>
      <h2>届いた写真やファイル</h2>
      {jobs.results.map((job) => <section class="panel">
        <p>{shownAt(job.created_at)}に{job.sender ? `${job.sender}さんから` : job.via === "admin" ? "役員の画面から" : ""}届いた{job.filename || (job.kind === "text" ? "文" : "資料")}（{job.title ? `${job.title}の資料` : "自治会の資料"}）</p>
        <form method="post" action={adminPath(ward, `/settings/deletion/${job.job_id}`)} onsubmit="return confirm('この資料と、AIが読み取った内容を消します。元に戻せません。続けますか？')">
          <button class="secondary danger">この資料を消す</button>
        </form>
      </section>)}
      {jobs.results.length === 0 ? <p>消せる資料はありません。</p> : null}
      <h2>電話やスマホで受けた出欠の返事</h2>
      <p>回答票の写真から入った返事は、その写真を消すと一緒に消えます。</p>
      {answers.results.map((answer) => <section class="panel">
        <p>{answer.title}の出欠の返事（{answer.district}、{answer.household}さん。{shownAt(answer.created_at)}に{sourceWord(answer.source)}で受けたもの）</p>
        <form method="post" action={adminPath(ward, `/settings/deletion/answers/${answer.answer_id}`)} onsubmit="return confirm('この返事を消します。元に戻せません。続けますか？')">
          <button class="secondary danger">この返事を消す</button>
        </form>
      </section>)}
      {answers.results.length === 0 ? <p>消せる返事はありません。</p> : null}
    </div></details>
    <p>準備を丸ごと消すときは、その準備のやることの画面の一番下から消します。</p>
    <p class="link-line"><a href={adminPath(ward, "/settings")}>自治会の設定へ戻る</a></p>
  </AdminPage>);
}

deletion.post("/person", async (c) => {
  const { ward } = c.var;
  const form = await c.req.formData();
  const targets = form.getAll("target").map(String).slice(0, 200);
  for (const target of targets) {
    const [kind, id] = [target.slice(0, target.indexOf(":")), target.slice(target.indexOf(":") + 1)];
    if (!id) continue;
    if (kind === "answer") await requestAnswerDeletion(c.env.DB, ward.wardId, id);
    else if (kind === "job") await requestJobDeletion(c.env.DB, ward.wardId, id).catch(() => undefined);
    // 問い合わせは、問い合わせの画面の「この問い合わせを消す」と同じ消し方にする。毎日の写しの消去はDB連動で引き受ける。
    else if (kind === "inquiry") await c.env.DB.prepare("DELETE FROM inquiry_records WHERE ward_id = ? AND inquiry_id = ?").bind(ward.wardId, id).run();
  }
  return c.redirect(adminPath(ward, "/settings/deletion?queued=1"), 303);
});

deletion.post("/answers/:answerId", async (c) => {
  const { ward } = c.var;
  if (!(await requestAnswerDeletion(c.env.DB, ward.wardId, c.req.param("answerId")))) return c.notFound();
  return c.redirect(adminPath(ward, "/settings/deletion?answer=1"), 303);
});

deletion.post("/projects/:projectId", async (c) => {
  const { ward } = c.var;
  if (!(await requestProjectDeletion(c.env.DB, ward.wardId, c.req.param("projectId")))) return c.notFound();
  return c.redirect(adminPath(ward, "/settings/deletion?project=1"), 303);
});

deletion.post("/:jobId", async (c) => {
  const { ward } = c.var;
  try {
    await requestJobDeletion(c.env.DB, ward.wardId, c.req.param("jobId"));
    return c.redirect(adminPath(ward, "/settings/deletion?queued=1"), 303);
  } catch {
    return c.notFound();
  }
});
