import { getDigestSettings, inquiryNotice } from "../settings/digest";
import { adminResult } from "../core/admin-ui";
import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { WardBucket } from "../core/storage";
import { Layout, Notice } from "../core/ui";
import { CRON } from "../core/cron";
import { sendOfficerDigest } from "./digest";
import { listClarifications, processPhotoBatches } from "./clarifications";
import type { AdminEnv, AppEnv } from "../env";
import { getLineAllowance, lineAccessToken, sendLineTitleAndUrl } from "./api";
import { markInboxItemUnrelated } from "./intake";
import { acceptLineWebhook } from "./webhook";
import { createProject } from "../project/api";
import { PROJECT_KINDS, type ProjectKind } from "../project/model";
import { assignProject, withdrawJob } from "../intake/api";
import { getJob, listJobs, listOriginals } from "../intake/store";
import { pendingMaterialGroups } from "../intake/groups";
import { adminPath } from "../core/auth";
import { formatJst } from "../core/time";
import { STATUS_LABEL } from "../intake/pages";

interface InboxRow {
  item_id: string;
  job_id: string | null;
  original_kind: "text" | "image";
  original_text: string | null;
  received_at: string;
  disposition: "unmatched" | "matched";
  matched_project_name: string | null;
  match_reason: string | null;
  sender_display_name: string | null;
  sender_label: string | null;
}

export async function listInboxItems(db: D1Database, wardId: string): Promise<InboxRow[]> {
  const result = await db.prepare(`
    SELECT item_id, job_id, original_kind, original_text, received_at, disposition, sender_display_name, sender_label,
      matched_project_name, match_reason
    FROM line_inbox_items
    WHERE ward_id = ?
    ORDER BY received_at DESC, item_id
  `).bind(wardId).all<InboxRow>();
  return result.results;
}

function safeContext(c: { executionCtx: Pick<ExecutionContext, "waitUntil"> }): Pick<ExecutionContext, "waitUntil"> {
  try { return c.executionCtx; } catch { return { waitUntil: () => undefined }; }
}

const admin = new Hono<AdminEnv>();

admin.get("/inbox", async (c) => {
  const { ward } = c.var;
  const db = c.env.DB;
  const [items, jobs, projects, groups, inquiries] = await Promise.all([
    listInboxItems(db, ward.wardId), listJobs(db, ward.wardId, { limit: 100 }),
    db.prepare("SELECT project_id, title AS name FROM projects WHERE ward_id = ? AND closed_at IS NULL ORDER BY created_at DESC").bind(ward.wardId).all<{ project_id: string; name: string }>(),
    pendingMaterialGroups(db, ward.wardId),
    db.prepare("SELECT inquiry_id, subject, received_at, answer, line_sender_label, line_source_type, line_replied_at FROM inquiry_records WHERE ward_id = ? AND kind = 'inquiry' ORDER BY received_at DESC LIMIT 30").bind(ward.wardId).all<{ inquiry_id: string; subject: string; received_at: string; answer: string; line_sender_label: string | null; line_source_type: string | null; line_replied_at: string | null }>(),
  ]);
  const adminJobs = jobs.filter((j) => j.via === "admin" && !j.withdrawn_at);
  const lineRows = await Promise.all(items.map(async (item) => ({ item, job: item.job_id ? await getJob(db, ward.wardId, item.job_id) : null })));
  const picker = (action: string, id: string, current?: string | null) => <details class="fold"><summary>{current ? "別の行事に入れる" : "進めている行事に入れる"}</summary><div>
    {projects.results.length ? <form method="post" action={action}><label for={id}>進めている行事</label><select id={id} name="projectId" required>
      {projects.results.map((p) => <option value={p.project_id} selected={p.project_id === current}>{p.name}</option>)}
    </select><button class="secondary" name="operation" value="assign">この行事に入れる</button></form> : <a href={adminPath(ward, "/projects")}>新しく始める</a>}
  </div></details>;
  return c.html(<Layout title="届いたもの" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/")}>最初の画面へ</a>
    {c.req.query("error") === "input" ? <Notice error>入れる行事を選び直してください。</Notice> : null}
    <h1>届いたもの</h1><p class="lead">AIが読んで、行事に入れました。違うときだけ直してください。分けなくてもかまいません。</p>
    {c.req.query("n") === "assigned" ? <><Notice>行事に入れました。</Notice><section class="next"><strong>次は</strong><p>段取りから続きを進められます。</p><a class="button" href={adminPath(ward, "/")}>最初の画面を見る</a></section><p>違うときは「別の行事に入れる」から直せます。</p></> : null}
    {c.req.query("error") === "busy" ? <Notice error>資料を行事に入れているところです。少ししてから、もう一度開いてください。</Notice> : null}
    <section class="panel"><h2>どの行事か分からないもの</h2>
      {groups.map((group) => <article><p><b>{group.title || group.materials[0]?.original.filename || "届いた資料"}</b></p>
        <p class="muted">{group.title ? `${group.title}の資料のようです。` : "何の資料か分からないものです。そのままでかまいません。"}{group.materials.length}件</p>
        <form method="post" action={adminPath(ward, "/intake/start")}><input type="hidden" name="group" value={group.key} /><button>{group.kind === "city_request" ? "市からの依頼として始める" : group.title ? `${group.title}を始める` : "このまま進める"}</button></form>
        {group.materials.map((m) => <p class="link-line"><a href={adminPath(ward, `/intake/originals/${m.original.original_id}`)}>元の資料を見る: {m.original.filename || "届いた文"}</a></p>)}
        {[...new Set(group.materials.map((m) => m.jobId))].map((id) => {
          const item = items.find((i) => i.job_id === id);
          return picker(adminPath(ward, item ? `/inbox/${item.item_id}` : `/inbox/city/${id}`), `pick-${id}`);
        })}
      </article>)}
      {adminJobs.filter((j) => !j.project_id && j.status !== "read").map((j) => <p class="link-line"><a href={adminPath(ward, "/intake/received")}>{j.first_filename || "撮った写真"}: {STATUS_LABEL[j.status]}</a></p>)}
      {lineRows.filter(({ item }) => item.disposition === "unmatched" && !groups.some((g) => g.materials.some((m) => m.jobId === item.job_id))).map(({ item, job }) => <article>
        <p><b>{item.original_text || "届いた写真"}</b></p><p class="muted">{job ? STATUS_LABEL[job.status] : "どの行事か分かりませんでした"}</p>
        <a href={adminPath(ward, `/inbox/${item.item_id}/original`)}>元の資料を見る</a>
        {picker(adminPath(ward, `/inbox/${item.item_id}`), `unmatched-${item.item_id}`)}
      </article>)}
      {groups.length === 0 && !jobs.some((j) => !j.project_id && !j.withdrawn_at) ? <p>ありません。</p> : null}
      <a class="quiet" href={adminPath(ward, "/intake")}>手元の紙や資料を送る</a>
    </section>
    <h2>役員に届いた問い合わせ</h2>
    <p>{inquiryNotice(await getDigestSettings(c.env.DB, ward.wardId))}</p>
    {inquiries.results.length ? <ul class="rows">{inquiries.results.map((q) => <li><a class="row-link" href={adminPath(ward, "/inquiries")}><b>{q.subject}</b><span>{formatJst(q.received_at)}に届きました</span>
      {q.line_source_type ? <span>送った人: {q.line_sender_label || "名前は分かりません"}（{q.line_source_type === "user" ? "公式への一対一" : "LINEグループ"}）</span> : null}
      {q.line_replied_at ? <span>AIは答えていません。送った人には「役員に伝えて、内容を確認します。」と返しました。</span> : null}
      {q.answer ? <span>{q.answer}</span> : null}</a></li>)}</ul> : <p class="muted">問い合わせはありません。</p>}
    <p class="link-line"><a href={adminPath(ward, "/inbox/questions")}>送った資料についての質問を見る</a></p>
    <h2>行事に入れたもの</h2><ul class="rows">
      {await Promise.all(adminJobs.filter((j) => j.project_id).map(async (j) => {
        const originals = await listOriginals(db, ward.wardId, j.job_id);
        const project = projects.results.find((p) => p.project_id === j.project_id);
        return <li class="panel"><b>{j.first_filename || "届いた文"}</b><p class="muted">{project?.name ?? "行事"}に入れました</p>
          {originals.map((o) => <p class="link-line"><a href={adminPath(ward, `/intake/originals/${o.original_id}`)}>元の資料を見る: {o.filename || "届いた文"}</a></p>)}
          {picker(adminPath(ward, `/inbox/city/${j.job_id}`), `pick-${j.job_id}`, j.project_id)}
        </li>;
      }))}
      {lineRows.filter(({ item }) => item.disposition === "matched").map(({ item, job }) => <li class="panel"><b>{item.original_text || "届いた写真"}</b><p class="muted">{item.sender_display_name || "役員"}がLINEで送りました。{item.matched_project_name ? `${item.matched_project_name}に入れました` : job ? STATUS_LABEL[job.status] : "どの行事か分かりませんでした"}</p>
        <p class="link-line"><a href={adminPath(ward, `/inbox/${item.item_id}/original`)}>元の資料を見る</a></p>
        {picker(adminPath(ward, `/inbox/${item.item_id}`), `pick-${item.item_id}`, job?.project_id)}
      </li>)}
    </ul>
    {adminJobs.every((j) => !j.project_id) && items.length === 0 ? <p>まだありません。</p> : null}
    <p class="muted">関係のない雑談は、AIが外しています。</p>
    <a class="quiet" href={adminPath(ward, "/")}>最初の画面へ</a>
  </Layout>);
});

admin.get("/inbox/questions", async (c) => {
  const { ward } = c.var;
  const questions = await listClarifications(c.env.DB, ward.wardId);
  return c.html(<Layout title="質問" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <a class="back" href={adminPath(ward, "/inbox")}>届いたものへ</a>
    <h1>送った資料についての質問</h1><p class="lead">読めないところなどを残しています。分かるものだけ答えられます。答えがなくても仕事は進められます。</p>
    {questions.map((question) => <section class="panel"><h2>{question.text}</h2>
      <p class="link-line"><a href={adminPath(ward, `/intake/originals/${question.original_id}`)}>元の資料を見る</a></p>
      <p>{question.sent_at ? "写真が届いた場所で聞きました。答えがなくても、そのままでかまいません。" : "まだ公式LINEでは聞いていません。"}</p>
      {question.answer ? <p class="preserve-lines">届いた答え: {question.answer}</p> : null}
      {question.project_id ? <p class="link-line"><a href={adminPath(ward, `/projects/${question.project_id}/questions`)}>行事の質問を見る</a></p> : <p>どの行事か分からないものは、届いたものから入れ直せます。</p>}
    </section>)}
    {!questions.length ? <p>質問はありません。</p> : null}
  </Layout>);
});

admin.post("/inbox/city/:jobId", async (c) => {
  const { ward, account } = c.var;
  const jobId = c.req.param("jobId");
  const form = await c.req.formData();
  const operation = String(form.get("operation") ?? "assign");
  const job = await c.env.DB.prepare("SELECT via, project_id, ai_matched_at, withdrawn_at FROM jobs WHERE ward_id = ? AND job_id = ?")
    .bind(ward.wardId, jobId).first<{ via: string; project_id: string | null; ai_matched_at: string | null; withdrawn_at: string | null }>();
  if (!job || job.via !== "admin" || job.withdrawn_at !== null) return c.notFound();
  let projectId = String(form.get("projectId") ?? "");
  if (operation === "new-project") {
    const title = String(form.get("projectName") ?? "").trim();
    const year = Number(form.get("year"));
    const kind = String(form.get("kind") ?? "city_request");
    if (!title || title.length > 100 || !Number.isInteger(year) || year < 2000 || year > 2100 || !PROJECT_KINDS.some((value) => value === kind)) return c.redirect(`/${ward.slug}/admin/inbox?error=input`, 303);
    const created = await createProject(c.env.DB, ward.wardId, { kind: kind as ProjectKind, title, year, accountId: account.accountId });
    projectId = created.projectId;
  }
  if (!projectId || !(await c.env.DB.prepare("SELECT 1 AS ok FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL")
    .bind(ward.wardId, projectId).first())) return adminResult(c, "開いている行事を選んでください。", 400, { href: adminPath(c.var.ward, "/inbox"), label: "届いたものに戻る" }, "開いている行事を選び直してください。");
  if (!(await assignProject(c.env, safeContext(c), ward.wardId, jobId, projectId))) return c.redirect(`/${ward.slug}/admin/inbox?error=busy`, 303);
  return c.redirect(`/${ward.slug}/admin/inbox?n=assigned`, 303);
});

admin.get("/inbox/:itemId/original", async (c) => {
  const { wardId } = c.var.ward;
  const row = await c.env.DB.prepare(`
    SELECT job_id, original_kind FROM line_inbox_items
    WHERE ward_id = ? AND item_id = ?
  `).bind(wardId, c.req.param("itemId")).first<{ job_id: string | null; original_kind: string }>();
  if (!row?.job_id) return c.notFound();
  const original = await c.env.DB.prepare("SELECT r2_path, media_type FROM originals WHERE ward_id = ? AND job_id = ? ORDER BY position LIMIT 1")
    .bind(wardId, row.job_id).first<{ r2_path: string | null; media_type: string }>();
  if (!original?.r2_path) return c.notFound();
  const object = await new WardBucket(c.env.ORIGINALS, wardId).get(original.r2_path);
  if (!object) return c.notFound();
  return new Response(object.body, {
    headers: { "content-type": original.media_type, "cache-control": "private, no-store" },
  });
});

admin.post("/inbox/:itemId", async (c) => {
  const { wardId } = c.var.ward;
  const form = await c.req.parseBody();
  const operation = form.operation;
  const itemId = c.req.param("itemId");
  if (operation === "unrelated") {
    const item = await c.env.DB.prepare("SELECT job_id FROM line_inbox_items WHERE ward_id = ? AND item_id = ?").bind(wardId, itemId).first<{ job_id: string | null }>();
    if (!item?.job_id || !(await withdrawJob(c.env, wardId, item.job_id))) return c.redirect(`/${c.var.ward.slug}/admin/inbox?error=busy`, 303);
    await markInboxItemUnrelated(c.env.DB, wardId, itemId);
  } else if (operation === "assign") {
    const projectId = typeof form.projectId === "string" ? form.projectId : "";
    const project = await c.env.DB.prepare(`
      SELECT title AS name FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL
    `).bind(wardId, projectId).first<{ name: string }>();
    if (project) {
      const item = await c.env.DB.prepare("SELECT job_id FROM line_inbox_items WHERE ward_id = ? AND item_id = ?")
        .bind(wardId, itemId).first<{ job_id: string | null }>();
      if (!item?.job_id || !(await assignProject(c.env, safeContext(c), wardId, item.job_id, projectId))) return c.redirect(`/${c.var.ward.slug}/admin/inbox?error=busy`, 303);
      await c.env.DB.prepare(`
        UPDATE line_inbox_items SET disposition = 'matched', matched_project_id = ?,
          matched_project_name = ?, match_reason = NULL WHERE ward_id = ? AND item_id = ?
      `).bind(projectId, project.name, wardId, itemId).run();
    }
  } else if (operation === "new-project") {
    const projectName = typeof form.projectName === "string" ? form.projectName.trim() : "";
    const kind = String(form.kind);
    const year = Number(form.year);
    if (projectName && projectName.length <= 100 && ["event", "general_meeting", "city_request"].includes(kind) && Number.isInteger(year) && year >= 2000 && year <= 2100) {
      const created = await createProject(c.env.DB, wardId, { kind: kind as "event" | "general_meeting" | "city_request", title: projectName, year, accountId: c.var.account.accountId });
      const item = await c.env.DB.prepare("SELECT job_id FROM line_inbox_items WHERE ward_id = ? AND item_id = ?")
        .bind(wardId, itemId).first<{ job_id: string | null }>();
      if (item?.job_id) await assignProject(c.env, safeContext(c), wardId, item.job_id, created.projectId);
      await c.env.DB.prepare(`
        UPDATE line_inbox_items SET disposition = 'matched', matched_project_id = ?,
          matched_project_name = ?, match_reason = NULL WHERE ward_id = ? AND item_id = ?
      `).bind(created.projectId, projectName, wardId, itemId).run();
    }
  }
  return c.redirect(`/${c.var.ward.slug}/admin/inbox?n=assigned`, 303);
});

export const line: Bundle = {
  admin,
  async scheduled(event, env) {
    if (event.cron !== CRON.EVERY_5_MIN) return;
    // 最初に接続先の台帳から区だけを取り出し、以後の読み書きは全てその区に限定する。
    const wards = await env.DB.prepare(`SELECT DISTINCT l.ward_id, w.slug FROM line_channels l JOIN wards w ON w.ward_id = l.ward_id
      WHERE w.ward_id = l.ward_id AND w.is_active = 1`).all<{ ward_id: string; slug: string }>();
    const now = new Date();
    for (const ward of wards.results) {
      try {
        await sendOfficerDigest(env, ward.ward_id, ward.slug, now);
      }
      catch { console.error("役員への知らせを送れませんでした", ward.ward_id); }
      await processPhotoBatches(env, ward.ward_id);
    }
  },
  hooks: new Hono<AppEnv>().post("/line", async (c) =>
    acceptLineWebhook(c.req.raw, c.env, c.env.DB, undefined, new Date(), c.executionCtx),
  ),
};

export { getLineAllowance, sendLineTitleAndUrl, lineAccessToken } from "./api";
