import { adminResult } from "../core/admin-ui";
import { installMeetingRoutes } from "./meeting-routes";
import { installHelpAdminRoutes } from "./help-admin";
import { AttendanceFields, CountFields, answerProblem, countText, countUnread, parseAnswerCounts } from "./counts";
import { type AnswerLabels } from "../settings/answer-labels";
import { EventDetails, ReceptionClosed, ResidentContact, residentContext } from "./resident";
import { PENDING } from "../project/document-body";
import { PrintDocument, Sheet } from "../print/a4";
import { formatJstDate } from "../core/time";
import { newId, nowIso } from "../core/ids";
import { Hono, type Context } from "hono";
import type { Bundle } from "../core/bundle";
import { Layout, Notice } from "../core/ui";
import { AdminPage } from "../core/admin-ui";
import type { AdminEnv, WardEnv } from "../env";
import type { AnswerSheetReading } from "../ai/schema";
import type { Reading } from "../ai/schema";
import type { Waitable } from "../intake/types";
import { receiveOriginal, getReadings } from "../intake/api";
import { getJob, getOriginal, markRosterAnswered } from "../intake/store";
import { SEND_SCRIPT } from "../intake/browser-script";
import { getSquads } from "../settings/store";
import { lookupPrintQr } from "../print/qr";
import { ArticleBody } from "../publish";
import { addHelpOffer, getHelpOfferBySubmission, helpTimeChoices, listHelpOffers, listHelpOpportunities, type HelpOpportunity } from "./help";
import {
  addAnswer,
  chooseRosterColumns,
  deleteAnswer,
  getAnswer,
  getAnswerDeadline,
  getAnswerTotals,
  getDistrictCopies,
  getDistricts,
  getRoster,
  getSavedRosterColumns,
  listAnswers,
  listHelperRequests,
  listUnansweredByDistrict,
  parseCsv,
  replaceRoster,
  rowsToRoster,
  setAnswerDeadline,
  type AnswerRow,
  updateAnswer,
  type RosterColumns,
} from "./api";

const admin = new Hono<AdminEnv>();
const pub = new Hono<WardEnv>();
installMeetingRoutes(admin, pub);

/** Hono のテスト用 request には ExecutionContext が無い場合がある。 */
function waitableContext(context: { executionCtx: Waitable }): Waitable {
  try {
    return context.executionCtx;
  } catch {
    // Hono の単体リクエストには背景処理の実行枠がない。そこで promise を
    // fire-and-forget すると、試験側で明示的に処理する前に同じジョブを競合させる。
    return { waitUntil: () => undefined };
  }
}

admin.get("/answers", async (c) => {
  const selectedProject = c.req.query("project");
  if (selectedProject) return c.redirect(adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(selectedProject)}`), 303);
  const rows = await c.env.DB.prepare(`SELECT p.project_id, p.title, p.year, p.closed_at,
      (SELECT COUNT(*) FROM project_answers a WHERE a.ward_id = p.ward_id AND a.project_id = p.project_id) AS answers
    FROM projects p WHERE p.ward_id = ? ORDER BY p.year DESC, p.created_at DESC`)
    .bind(c.var.ward.wardId).all<{ project_id: string; title: string; year: number; closed_at: string | null; answers: number }>();
  return c.html(
    <Layout title="出欠の返事を見る" siteName={c.var.ward.name} noindex adminHomeHref={adminPath(c.var.ward.slug, "/")}>
      <a class="back" href={adminPath(c.var.ward.slug, "/")}>← 最初の画面へ</a>
      <h1>出欠の返事を見る</h1><p class="lead">どの出欠の返事を見るか選んでください。紙、電話、スマホの返事が、同じ一覧に入っています。</p>
      {rows.results.length === 0 ? <p>出欠を集めているものはまだありません。</p> : rows.results.map((row) => <section>
        <h2>{row.title}（{row.year}年）</h2>
        <ul class="rows two">
          <li><a class="row-link" href={adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(row.project_id)}`)}><b>出欠の返事を見る</b><span>{row.answers}世帯が{row.closed_at ? "返事をしました" : "返事をしています"}</span></a></li>
        </ul>
      </section>)}
      <div class="action-links"><a class="button secondary" href={adminPath(c.var.ward.slug, "/answers/roster")}>名簿を入れる</a></div>
      <p class="muted">名簿は、まだ返事のない世帯を出すために使います。</p>
    </Layout>,
  );
});

admin.get("/answers/roster", async (c) => {
  const { ward } = c.var;
  const root = adminPath(ward.slug, "/answers/roster");
  const [entries, copies] = await Promise.all([getRoster(c.env.DB, ward.wardId), getDistrictCopies(c.env.DB, ward.wardId)]);
  const jobId = c.req.query("job");
  const done = c.req.query("done") === "1";
  return c.html(<Layout title={done ? "名簿を読み込みました" : jobId ? "読み取った名簿" : "世帯の名簿"} siteName={ward.name} noindex adminHomeHref={adminPath(ward.slug, "/")}>
    <a class="back" href={done || jobId ? root : adminPath(ward.slug, "/")}>{done || jobId ? "← 世帯の名簿へ" : "← 最初の画面へ"}</a>
    {done ? <>
      <h1>名簿を読み込みました</h1><div class="notice done"><strong>{entries.length}世帯、{copies.length}班の名簿を入れました</strong><p>前の名簿は入れ替わりました。間違えたときは、正しい名簿をもう一度読み込むか、紙の名簿を撮り直して読み取ると、入れ替わります。</p></div>
      <dl class="facts">{copies.map((row) => <><dt>{row.district}</dt><dd>{row.copies}部</dd></>)}</dl>
      <section class="next"><strong>次は</strong><p>班の名前が名簿に合わせて変わりました。最初の画面へ戻って、準備中のものを開いてください。</p><a class="button" href={adminPath(ward.slug, "/")}>最初の画面へ</a></section>
      <a class="quiet" href={root}>名簿の画面で見る</a>
    </> : jobId ? <>
      <h1>読み取った名簿</h1><RosterPhotoResult wardSlug={ward.slug} wardId={ward.wardId} db={c.env.DB} jobId={jobId} />
    </> : <>
      <h1>世帯の名簿</h1><p class="lead">世帯の代表者（ふつうは世帯主）のお名前と班が入ります。返事の集計と、まだ返事のない世帯の一覧に使います。</p>
      {entries.length ? <div class="notice"><strong>今の名簿は{entries.length}世帯、{copies.length}班です</strong><p>新しく読み込むと、この名簿は入れ替わります。</p></div> : <p class="notice">名簿はまだありません。名簿がなくても返事を受け付けられます。手元に名簿があれば、下から送ってください。</p>}
      <form id="send-form" method="post" action={root} enctype="multipart/form-data">
        <h2>Excelの表があるとき</h2><div class="field"><label class="file-button">Excelの表を選ぶ<input id="files" name="part" type="file" accept=".csv,.xlsx" required /></label>
          <p class="help-text">Excelのファイル（.xlsx）と、.csvのファイルを読めます。先頭の行の見出しから、世帯の代表者のお名前と班の列を見つけます。見つからないときだけ、列を選んでもらいます。</p></div>
        <input type="hidden" name="text" value="" /><p id="send-status" class="notice" role="status"></p>
        <p>読み込むと、今の名簿は消えます。間違えたときは、正しい名簿をもう一度読み込むか、紙の名簿を撮り直して読み取ると、入れ替わります。</p>
        <div class="action-bar"><button id="send-button" type="submit">名簿を読み込む</button></div>
      </form><script dangerouslySetInnerHTML={{ __html: SEND_SCRIPT }} />
      <form class="panel" method="post" action={`${root}/photo`} enctype="multipart/form-data">
        <h2>紙の名簿しかないとき</h2><p>見出しのない紙でも読めます。名簿を写真に撮って送ってください。AIが表に読み取ります。</p>
        <div class="field"><label class="file-button">紙の名簿を撮る<input id="roster-photo" name="photo" type="file" accept="image/*,.pdf" capture="environment" required /></label>
          <p class="help-text">写真とPDFを送れます。送ったあと、読み取った表を見て、使うかどうかを選べます。</p></div>
        <div class="action-links"><button class="secondary" type="submit">写真を読み取る</button></div>
      </form>
      {copies.length ? <><h2>班ごとの部数</h2><dl class="facts">{copies.map((row) => <><dt>{row.district}</dt><dd>{row.copies}部</dd></>)}<dt>合計</dt><dd>{entries.length}部</dd></dl></> : null}
      {entries.length ? <details class="fold"><summary>世帯と班の一覧を見る（{entries.length}世帯）</summary><div><table class="stack"><thead><tr><th>世帯の代表者のお名前</th><th>班</th></tr></thead><tbody>{entries.map((entry) => <tr><td data-label="世帯の代表者のお名前">{entry.household}</td><td data-label="班">{entry.district}</td></tr>)}</tbody></table></div></details> : null}
    </>}
  </Layout>);
});

async function RosterPhotoResult({ wardSlug, wardId, db, jobId }: { wardSlug: string; wardId: string; db: D1Database; jobId: string }) {
  const root = adminPath(wardSlug, "/answers/roster");
  const [readings, job] = await Promise.all([getReadings(db, wardId, jobId), getJob(db, wardId, jobId)]);
  const reading = readings.find((row) => "tables" in row.body)?.body;
  if (!reading || !("tables" in reading)) return <>
    <p class="notice">{!job || job.status === "failed" || job.status === "attention" ? "名簿を読み取れませんでした。紙を明るい場所で撮り直して、もう一度送ってください。Excelの表からも入れられます。" : "名簿の写真を受け取りました。読み取りが終わると表が表示されます。少ししてから、この画面をもう一度開いてください。"}</p>
    <a class="button secondary" href={`${root}?job=${encodeURIComponent(jobId)}`}>もう一度開く</a><p><a class="quiet" href={root}>名簿の画面に戻る</a></p>
  </>;
  const tables = reading.tables.map((table, index) => ({ table, index })).filter(({ table }) => table.rows.length > 0);
  return <><p class="lead">紙の写真から、表が{tables.length}つ見つかりました。使う表の「この名簿を使う」を押してください。</p>
    {tables.map(({ table, index }) => <form class="panel" method="post" action={`${root}/photo/import`}>
      <h2>{table.name}（{table.rows.length}行）</h2><p class="muted">{table.rows.length > 6 ? "先頭の6行を見せています。" : `${table.rows.length}行ぜんぶを見せています。`}</p>
      <table class="stack"><thead><tr>{table.columns.map((name) => <th>{name}</th>)}</tr></thead><tbody>{table.rows.slice(0, 6).map((row) => <tr>{row.cells.map((cell, i) => <td data-label={table.columns[i]}>{cell}</td>)}</tr>)}</tbody></table>
      <p>使うと、今の名簿は入れ替わります。</p><input type="hidden" name="jobId" value={jobId} /><input type="hidden" name="tableIndex" value={index} />
      <div class={index === 0 ? "action-bar" : "action-links"}><button class={index === 0 ? undefined : "secondary"} type="submit">この名簿を使う</button></div>
    </form>)}
    <p class="muted">どの表も違うときは、紙を明るい場所で撮り直して、もう一度送ってください。</p><a class="quiet" href={root}>名簿の画面に戻る</a>
  </>;
}

admin.post("/answers/roster/photo", async (c) => {
  const form = await c.req.formData();
  const photo = form.get("photo");
  if (!(photo instanceof File)) return adminResult(c, "名簿の写真を選んでください。", 400, { href: adminPath(c.var.ward.slug, "/answers/roster"), label: "名簿に戻る" }, "名簿の写真やファイルを選び、もう一度送ってください。");
  const outcome = await receiveOriginal(c.env, waitableContext(c), {
    wardId: c.var.ward.wardId, via: "system", readKind: "general",
    parts: [{ kind: "photo", filename: photo.name || "名簿の写真", mediaType: photo.type, bytes: new Uint8Array(await photo.arrayBuffer()) }],
  });
  const duplicate = outcome.duplicates[0];
  const jobId = outcome.jobId ?? (duplicate ? (await getOriginal(c.env.DB, c.var.ward.wardId, duplicate.originalId))?.job_id : null);
  if (!jobId) return c.redirect(adminPath(c.var.ward.slug, "/answers/roster"), 303);
  return c.redirect(`${adminPath(c.var.ward.slug, "/answers/roster")}?job=${encodeURIComponent(jobId)}`, 303);
});

admin.post("/answers/roster/photo/import", async (c) => {
  const form = await c.req.formData();
  const jobId = String(form.get("jobId") ?? "");
  const index = Number(form.get("tableIndex"));
  const readings = await getReadings(c.env.DB, c.var.ward.wardId, jobId);
  const reading = readings.find((row) => "tables" in row.body)?.body;
  if (!reading || !("tables" in reading) || !Number.isInteger(index) || !reading.tables[index]) return adminResult(c, "読み取った名簿を確認できません。", 400, { href: adminPath(c.var.ward.slug, "/answers/roster"), label: "名簿に戻る" }, "名簿の写真やファイルを選び、もう一度送ってください。");
  const table = reading.tables[index];
  const districts = await getDistricts(c.env.DB, c.var.ward.wardId);
  let householdColumn = table.columns.findIndex((column) => /世帯|氏名|名前/.test(column));
  let districtColumn = table.columns.findIndex((column) => /班|組/.test(column));
  if (householdColumn < 0 || districtColumn < 0) {
    const second = table.rows.length > 0 ? table.rows[0]?.cells.findIndex((cell, cellIndex) => cellIndex > 0 && districts.includes(cell.trim())) ?? -1 : -1;
    if (second >= 0) { householdColumn = 0; districtColumn = second; }
  }
  if (householdColumn < 0 || districtColumn < 0 || householdColumn === districtColumn) return adminResult(c, "代表者のお名前と班の項目を読み取れませんでした。名簿ファイルから読み込んでください。", 400, { href: adminPath(c.var.ward.slug, "/answers/roster"), label: "名簿に戻る" }, "名簿の写真やファイルを選び、もう一度送ってください。");
  const rows = [table.columns, ...table.rows.map((row) => row.cells)];
  const entries = rowsToRoster(rows, { household: householdColumn, district: districtColumn });
  await replaceRoster(c.env.DB, c.var.ward.wardId, entries, { household: householdColumn, district: districtColumn });
  await markRosterAnswered(c.env.DB, c.var.ward.wardId, jobId, "imported");
  return c.redirect(`${adminPath(c.var.ward.slug, "/answers/roster")}?done=1`, 303);
});

admin.post("/answers/roster", async (c) => {
  const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
  const reply = (ok: boolean, message: string, status: 200 | 400 | 500 = 200) =>
    wantsJson ? c.json({ ok, message, ...(ok ? { redirectTo: `${adminPath(c.var.ward.slug, "/answers/roster")}?done=1` } : {}) }, status) : adminResult(c, message, status, { href: adminPath(c.var.ward.slug, "/answers/roster"), label: "名簿に戻る" }, "名簿の写真やファイルを選び、もう一度送ってください。");
  const contentType = c.req.header("content-type") ?? "";
  let form: FormData | Record<string, unknown>;
  if (contentType.includes("application/json")) {
    try {
      const body: unknown = await c.req.json();
      if (typeof body !== "object" || body === null || Array.isArray(body)) return reply(false, "名簿の内容を読み取れません。", 400);
      form = body as Record<string, unknown>;
    } catch {
      return reply(false, "名簿の内容を読み取れません。", 400);
    }
  } else {
    form = await c.req.formData();
  }
  const get = (name: string): unknown => form instanceof FormData ? form.get(name) : form[name];
  const rowsRaw = get("rows_json");
  if (typeof rowsRaw === "string" || Array.isArray(rowsRaw)) {
    let rows: string[][];
    try {
      const parsed: unknown = typeof rowsRaw === "string" ? JSON.parse(rowsRaw) : rowsRaw;
      if (!Array.isArray(parsed) || !parsed.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))) {
        return reply(false, "名簿の行を読み取れません。", 400);
      }
      rows = parsed as string[][];
    } catch {
      return reply(false, "名簿の行を読み取れません。", 400);
    }
    if (get("household_column") === "" || get("district_column") === "" || get("household_column") == null || get("district_column") == null) return reply(false, "代表者のお名前と班の項目を選んでください。", 400);
    const household = Number(get("household_column"));
    const district = Number(get("district_column"));
    const columns = { household, district };
    let entries: ReturnType<typeof rowsToRoster>;
    try { entries = rowsToRoster(rows, columns); }
    catch (error) {
      return reply(false, error instanceof Error ? error.message : "名簿を読み込めませんでした。", 400);
    }
    try { await replaceRoster(c.env.DB, c.var.ward.wardId, entries, columns); }
    catch { return reply(false, "名簿を保存できませんでした。もう一度お試しください。", 500); }
    return wantsJson ? reply(true, "名簿を読み込みました。") : c.redirect(`${adminPath(c.var.ward.slug, "/answers/roster")}?done=1`, 303);
  }
  const data = get("part");
  const extracted = get("part_extracted");
  if (!(data instanceof File)) return reply(false, "名簿ファイルを選んでください。", 400);
  let rows: string[][];
  if (/\.csv$/i.test(data.name)) {
    try {
      rows = parseCsv(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await data.arrayBuffer()));
    } catch {
      return reply(false, "CSVを読み取れませんでした。UTF-8で保存し直してください。", 400);
    }
  } else {
    if (typeof extracted !== "string" || !extracted) return reply(false, "Excelファイルを読み取れませんでした。", 400);
    let workbook: { tables?: Array<{ rows?: unknown }> };
    try { workbook = JSON.parse(extracted) as typeof workbook; }
    catch { return reply(false, "Excelファイルを読み取れませんでした。", 400); }
    const first = workbook.tables?.[0]?.rows;
    if (!Array.isArray(first) || !first.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))) {
      return reply(false, "先頭のシートに表がありません。", 400);
    }
    rows = first as string[][];
  }
  const detected = chooseRosterColumns(rows[0] ?? []);
  const rawColumns = get("columns");
  let columns: RosterColumns | null = detected ?? (await getSavedRosterColumns(c.env.DB, c.var.ward.wardId));
  if (!columns && typeof rawColumns === "string") {
    try {
      columns = JSON.parse(rawColumns) as RosterColumns;
    } catch {
      columns = null;
    }
  }
  if (!columns) return c.html(<RosterColumnPicker wardName={c.var.ward.name} wardSlug={c.var.ward.slug} headers={rows[0] ?? []} rows={rows} />);
  let entries: ReturnType<typeof rowsToRoster>;
  try { entries = rowsToRoster(rows, columns); }
  catch (error) {
    return reply(false, error instanceof Error ? error.message : "名簿を読み込めませんでした。", 400);
  }
  try { await replaceRoster(c.env.DB, c.var.ward.wardId, entries, columns); }
  catch { return reply(false, "名簿を保存できませんでした。もう一度お試しください。", 500); }
  return wantsJson ? reply(true, "名簿を読み込みました。") : c.redirect(`${adminPath(c.var.ward.slug, "/answers/roster")}?done=1`, 303);
});

async function answersPage(c: Context<AdminEnv>, retry?: Record<string, unknown>) {
  const projectId = c.req.param("projectId") ?? "";
  const project = await c.env.DB.prepare("SELECT project_id, title, closed_at FROM projects WHERE ward_id = ? AND project_id = ?")
    .bind(c.var.ward.wardId, projectId).first<{ project_id: string; title: string; closed_at: string | null }>();
  if (!project) return c.notFound();
  const [answers, unanswered, helpers, deadline, districts, totals, offers] = await Promise.all([
    listAnswers(c.env.DB, c.var.ward.wardId, projectId),
    listUnansweredByDistrict(c.env.DB, c.var.ward.wardId, projectId),
    listHelperRequests(c.env.DB, c.var.ward.wardId, projectId),
    getAnswerDeadline(c.env.DB, c.var.ward.wardId, projectId),
    getSquads(c.env.DB, c.var.ward.wardId),
    getAnswerTotals(c.env.DB, c.var.ward.wardId, projectId),
    listHelpOffers(c.env.DB, c.var.ward.wardId, projectId),
  ]);
  const { labels } = await residentContext(c.env.DB, c.var.ward.wardId, projectId);
  const sheets = await c.env.DB.prepare(
    `SELECT o.original_id, o.filename, o.job_id, r.body, j.status
     FROM jobs j JOIN originals o ON o.ward_id = j.ward_id AND o.job_id = j.job_id
     LEFT JOIN readings r ON r.ward_id = j.ward_id AND r.job_id = j.job_id
     WHERE j.ward_id = ? AND j.project_id = ? AND j.read_kind = 'answer_sheet' AND j.withdrawn_at IS NULL
     ORDER BY j.created_at DESC`,
  ).bind(c.var.ward.wardId, projectId).all<{ original_id: string; filename: string; job_id: string; body: string | null; status: string }>();
  const root = adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(projectId)}`);
  // 案内をまだ住民に知らせていない時は、返事はまだ来ない。まだ無い回答票を撮れとは言わない。
  const announced = !!(await c.env.DB.prepare("SELECT 1 AS found FROM documents d JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = 'announcement' AND v.published_at IS NOT NULL LIMIT 1").bind(c.var.ward.wardId, projectId).first());
  const view = retry ? "hand" : c.req.query("view") ?? "summary";
  const closed = !!project.closed_at;
  const back = { href: root, label: `← ${project.title}の出欠の返事へ` };
  const roster = await getRoster(c.env.DB, c.var.ward.wardId);
  const remaining = unanswered.reduce((sum, group) => sum + group.households.length, 0);
  const helperCount = helpers.length + offers.length;
  const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
  const deadlinePassed = deadline !== null && deadline < today;
  const attending = answers.filter((answer) => answer.peopleCount > 0).length;
  const unread = answers.filter(countUnread).length;
  const notAttending = answers.filter((answer) => answer.peopleCount === 0).length - unread;
  if (view === "unanswered" && c.req.query("print") === "1") return c.html(<PrintDocument title={`${project.title} まだ返事のない世帯`} back={`${root}?view=unanswered`}>
    <Sheet footer={<span>{c.var.ward.name}</span>}><h1>{project.title} まだ返事のない世帯</h1>
      <p>{deadlinePassed ? "締切を過ぎたので、返事のない世帯は欠席として数えています。" : "返事がないときは、締切のあとに欠席として数えます。"}</p>
      {!roster.length ? <p>名簿はまだありません。名簿を入れると、まだ返事のない世帯を見られます。</p> : unanswered.map((group) => <section><h2>{group.district}（{group.households.length}世帯）</h2>{group.households.length ? <ul>{group.households.map((name) => <li>{name}</li>)}</ul> : <p>まだ返事のない世帯はありません。</p>}</section>)}
      <p>名前の書き方が名簿と違うと、返事をしていてもここに出ることがあります。</p>
    </Sheet></PrintDocument>);
  const titles: Record<string, string> = { send: "回答票を撮って送る", sent: "回答票を受け取りました", unanswered: "まだ返事のない世帯", hand: "電話や紙の返事を手で入れる", list: "返事の一覧", read: "読み取った返事を直して入れる", helpers: "手伝いの一覧" };
  const title = titles[view] ?? `${project.title}の出欠の返事`;
  const receipt = retry ? undefined : c.req.query("done");
  if (receipt === "hand" || receipt === "deadline" || receipt === "edit" || receipt === "delete") {
    const message = receipt === "hand" ? "入れました。数に入りました" : receipt === "deadline" ? "変えました。案内の文は変わりません" : receipt === "edit" ? "返事を直しました。数に入りました" : "返事を消しました。数から外しました";
    const label = receipt === "hand" ? "続けて入れる" : receipt === "deadline" ? "下書きを見る" : "返事の一覧を見る";
    const href = receipt === "hand" ? `${root}?view=hand` : receipt === "deadline" ? adminPath(c.var.ward.slug, `/projects/${projectId}/draft`) : `${root}?view=list`;
    return c.html(<AdminPage ward={c.var.ward} account={c.var.account} title={message} back={back}>
      <h1>{message}</h1><section class="next"><strong>次は</strong><p>{receipt === "hand" ? "続けて入れられます。" : receipt === "deadline" ? "知らせたいときは、直して知らせ直せます。" : "返事と数を見られます。"}</p><a class="button" href={href}>{label}</a></section>
      {receipt === "hand" || receipt === "edit" ? <><h2>間違えたときは</h2><a class="quiet" href={`${root}?view=list`}>返事の一覧で直す</a></> : receipt === "delete" ? <a class="quiet" href={`${root}?view=hand`}>電話や紙の返事を手で入れる</a> : <a class="quiet" href={root}>返事の締切を変える</a>}
    </AdminPage>);
  }
  return c.html(<AdminPage ward={c.var.ward} account={c.var.account} title={title}
    back={view === "summary" ? { href: adminPath(c.var.ward.slug, `/projects/${projectId}/map`), label: `← ${project.title}のやることへ` } : back}>
    <h1 class={view === "summary" || view === "list" || view === "helpers" ? "answers-wide" : undefined}>{title}</h1>
    {closed ? <Notice>{project.title}は終わりにしました。返事を直すときは<a class="quiet" href={adminPath(c.var.ward.slug, `/close/${projectId}`)}>終わりにした画面で、終わりを取り消してください</a>。</Notice> : null}
    {view === "summary" ? <>
      <p class="lead">{answers.length ? "紙、電話、スマホの返事を合わせた数です。" : ""}{deadline ? `返事の締切は${formatJstDate(deadline)}です。` : "返事の締切はまだ決まっていません。"}</p>
      {!answers.length ? <div class="notice"><strong>まだ返事はありません</strong><p>紙、電話、スマホの返事が、ここに集まります。</p></div> : null}
      <div class="counts"><div class="count"><b>{answers.length}<small>世帯</small></b><span>{roster.length ? `${roster.length}世帯のうち` : "返事のあった世帯"}</span></div><div class="count"><b>{totals.people}<small>人</small></b><span>参加する</span></div><div class="count"><b>{helperCount}<small>人</small></b><span>手伝い</span></div></div>
      {unread ? <div class="notice warn"><strong>人数が読めなかった返事が{unread}件あります</strong><p>参加しないには数えていません。写真を見て入れてください。</p><a class="quiet" href={`${root}?view=read`}>読み取った出欠の返事を見る</a></div> : null}
      {!answers.length ? <>
        {!closed ? announced ? <><section class="next"><strong>次は</strong><p>回答票が手元にあれば、撮って送れます。</p><a class="button" href={`${root}?view=send`}>回答票を撮って送る</a></section><a class="quiet" href={`${root}?view=hand`}>電話で聞いた返事を入れる</a></>
          : <><section class="next"><p>{project.title}は、まだ住民に案内を知らせていません。出欠の返事は、案内を知らせたあとに、ここに集まります。</p><a class="button" href={adminPath(c.var.ward.slug, `/projects/${projectId}/map`)}>{project.title}のやることを開く</a></section><p>先に電話で返事を聞いたときは、ここから入れられます。<a href={`${root}?view=hand`}>電話で聞いた返事を入れる</a></p></> : null}
        {!roster.length ? <p><a class="quiet" href={adminPath(c.var.ward.slug, "/answers/roster")}>名簿を入れる</a></p> : null}
        {deadlinePassed && remaining ? <p>返事のない{remaining}世帯は欠席として数えています。</p> : null}
        <p><a class="button secondary" href={`${root}?view=helpers`}>手伝いの一覧 {helperCount}人</a></p>
      </> : <>
      <p>{answers.length ? `返事のあった${answers.length}世帯のうち、参加する世帯は${attending}、参加しない世帯は${notAttending}です。${unread ? `人数が読めなかった世帯は${unread}です。` : ""}` : ""}{closed ? "" : !deadlinePassed ? "返事がないときは、締切のあとに欠席として数えます。" : remaining ? `返事のない${remaining}世帯も欠席として数えています。欠席は合わせて${notAttending + remaining}世帯です。` : ""}</p>
      {answers.some((answer) => answer.childrenCount != null || answer.adultsCount != null || answer.seniorsCount != null) ? <p class="muted">参加する人の内わけは、{labels.map((label, index) => `${label}${answers.reduce((sum, answer) => sum + ([answer.childrenCount, answer.adultsCount, answer.seniorsCount][index] ?? 0), 0)}人`).join("、")}です。{answers.some((answer) => answer.childrenCount == null && answer.adultsCount == null && answer.seniorsCount == null) ? "内わけのない返事は合計だけに含めています。" : ""}</p> : null}
      {!closed ? <div class="action-links"><a class="button" href={`${root}?view=send`}>回答票を撮って送る</a></div> : null}
      <ul class="rows two">
        <li><a class="row-link" href={`${root}?view=unanswered`}><b>{roster.length ? `まだ返事のない世帯 ${remaining}世帯` : "まだ返事のない世帯"}</b><span>班ごとに見られます</span></a></li>
        {!closed ? <li><a class="row-link" href={`${root}?view=hand`}><b>電話や紙の返事を手で入れる</b><span>世帯の代表者（ふつうは世帯主）のお名前、班、人数を入れます</span></a></li> : null}
        <li><a class="row-link" href={`${root}?view=list`}><b>返事の一覧</b><span>読み違いは、ここで直せます</span></a></li>
        <li><a class="row-link" href={`${root}?view=read`}><b>回答票の読み取り</b><span>撮って送った回答票の読みを見られます</span></a></li>
        <li><a class="row-link" href={adminPath(c.var.ward.slug, "/answers/roster")}><b>世帯の名簿</b><span>まだ返事のない世帯を出すために使います</span></a></li>
        <li><a class="row-link" href={`${root}?view=helpers`}><b>手伝いの一覧 {helperCount}人</b><span>当番表の下書きを作れます</span></a></li>
      </ul>
      </>}
      {!closed ? <details class="fold"><summary>返事の締切を変える</summary><div><form method="post" action={`${root}/deadline`}><label for="due">返事の締切</label><input id="due" name="due_on" type="date" value={deadline ?? ""} required /><button class="secondary">締切を変える</button></form></div></details> : null}
    </> : null}
    {view === "send" && !closed ? <>
      <p class="lead">預かった回答票や手元の回答票を撮ってください。一枚の写真に何枚写っていてもかまいません。</p>
      <form method="post" action={`${root}/sheet`} enctype="multipart/form-data"><div class="field"><label class="file-button">カメラで回答票を撮る<input name="part" type="file" accept="image/*,.pdf" capture="environment" required /></label></div><div class="action-links"><button>送る</button></div></form>
      <details class="hint"><summary>読みにくい字があったとき</summary><div><p>そのまま送ってください。読めないところは返事の一覧に出ます。全部を見直す必要はありません。</p></div></details>
    </> : null}
    {view === "sent" ? <><p class="lead">読み取れた分から数えに入れます。読み違いは、返事の一覧で直せます。</p><section class="next"><strong>次は</strong><p>返事の数に入ったか見てください。</p><a class="button" href={root}>出欠の返事を見る</a></section><a class="quiet" href={`${root}?view=send`}>続けて撮って送る</a><p><a class="quiet" href={`${root}?view=list`}>返事の一覧で直す</a></p><p class="muted">写真が残るので、紙は名前が読めないようにして捨ててかまいません。班長から預かった紙も同じです。</p></> : null}
    {view === "hand" && !closed ? <><p class="lead">聞いた内容を入れてください。</p><p><a class="button secondary" href={`${root}/help`}>手伝いだけの申し込みを入れる</a></p><form method="post" action={`${root}/phone`}>
      {retry ? <><Notice error>{answerProblem(retry)}入れた内容は残っています。</Notice>
        <section class="next"><strong>次は</strong><p>下の内容を直して、もう一度「この返事を入れる」を押してください。前の画面には、ブラウザの戻るボタンでも戻れます。</p><a class="quiet" href={root}>返事の画面に戻る</a></section>
      </> : null}
      <div class="field"><label for="household">世帯の代表者（ふつうは世帯主）のお名前</label><input id="household" name="household" required maxlength={120} value={asString(retry?.household)} /></div>
      <fieldset><legend>班</legend><DistrictSelect districts={districts} selected={asString(retry?.district)} /></fieldset>
      <AttendanceFields title={project.title} selected={asString(retry?.attend)} /><div class="admin-answer-counts"><CountFields labels={labels} rawValues={retry} /></div>
      <details class="fold" open={!!retry && (!!retry.helper_name || !!retry.helper_times)}><summary>手伝いの希望があるとき</summary><div><label for="helper">手伝う方のお名前</label><input id="helper" name="helper_name" maxlength={120} value={asString(retry?.helper_name)} /><label for="times">手伝える時間帯</label><input id="times" name="helper_times" maxlength={240} value={asString(retry?.helper_times)} /></div></details>
      <div class="action-bar"><button>この返事を入れる</button></div>
    </form></> : null}
    {view === "unanswered" ? <><p class="lead">名簿の世帯のうち、まだ返事が届いていない世帯です。{deadlinePassed ? "締切を過ぎたので、欠席として数えています。" : "返事がないときは、締切のあとに欠席として数えます。"}</p><div class="action-links"><a class="button" href={`${root}?view=unanswered&print=1`}>この一覧を印刷する</a></div>
      <section class="answer-unanswered-print"><h2 class="print-only">{project.title} まだ返事のない世帯</h2>{!roster.length ? <p>名簿はまだありません。名簿を入れると、まだ返事のない世帯を見られます。</p> : unanswered.map((group) => <section><h2>{group.district}（{group.households.length}世帯）</h2>{group.households.length ? <ul>{group.households.map((name) => <li>{name}</li>)}</ul> : <p>まだ返事のない世帯はありません。</p>}</section>)}</section>
      <p class="muted">印刷して班長に渡すと、会ったときに締切を伝えてもらえます。返事をもらうために回る必要はありません。名前の書き方が名簿と違うと、返事をしていてもここに出ることがあります。</p></> : null}
    {view === "list" ? <><p class="lead">押すと、直したり消したりできます。</p><ul class="rows two">{answers.map((answer) => <li><a class="row-link" href={`${root}/${encodeURIComponent(answer.answerId)}/edit`}><b>{answer.household}</b><span>{answer.district || "班が分からない"}　{countText(answer, labels)}</span><span>{answer.source === "web" ? "スマホの返事" : answer.source === "phone" ? "電話の返事" : answer.source === "line" ? "LINEの返事" : "紙の回答票から読みました"}</span></a></li>)}</ul>
      {!answers.length ? <p>返事はまだありません。</p> : null}<p>班が分からない{answers.filter((answer) => !answer.district).length}世帯</p>
      {sheets.results.map((sheet) => <details class="fold"><summary>{sheet.filename || "回答票の読み取り"}</summary><div><a class="quiet" href={adminPath(c.var.ward.slug, `/intake/originals/${encodeURIComponent(sheet.original_id)}`)}>回答票の写真を読む</a>{renderSheetRows(sheet.body, projectId, sheet.original_id, c.var.ward.slug, closed, answers, labels, project.title, districts)}</div></details>)}</> : null}
    {view === "read" ? <><p class="lead">回答票の写真から読み取りました。世帯の代表者（ふつうは世帯主）のお名前と、読めなかったところを入れて、「返事に入れる」を押してください。入れた返事も直せます。</p>
      {!sheets.results.length ? <p>回答票はまだ届いていません。</p> : sheets.results.filter((sheet) => !c.req.query("original") || sheet.original_id === c.req.query("original")).map((sheet, index) => <section>
        <h2>{sheet.filename || "回答票の写真"}</h2><a class="quiet" href={adminPath(c.var.ward.slug, `/intake/originals/${encodeURIComponent(sheet.original_id)}`)}>元の資料（回答票の写真）を見る</a>
        {renderSheetRows(sheet.body, projectId, sheet.original_id, c.var.ward.slug, closed, answers, labels, project.title, districts, index === 0)}
      </section>)}
    </> : null}
    {view === "helpers" ? <><p class="lead">世帯の返事にある手伝いと、手伝いだけの申し込みを合わせました。手伝いだけの申し込みは、お名前を押すと直したり取り消したりできます。</p>{!closed ? <><a class="button" href={`${root}/help`}>電話や紙の手伝いの申し込みを入れる</a><form class="action-links" method="post" action={adminPath(c.var.ward.slug, `/projects/${projectId}/draft/duty_roster/start`)}><button class="secondary">当番表の下書きを作る</button></form></> : null}
      {helperCount ? <table class="stack"><thead><tr><th>お名前</th><th>時間帯</th><th>申し込み</th></tr></thead><tbody>{offers.map((offer) => <tr><td data-label="お名前"><a href={`${root}/help/${encodeURIComponent(offer.offerId)}`}>{offer.name}</a></td><td data-label="時間帯">{offer.times}</td><td data-label="申し込み">手伝いだけ</td></tr>)}{helpers.map((helper) => <tr><td data-label="お名前">{helper.name}</td><td data-label="時間帯">{helper.times}</td><td data-label="申し込み">世帯の返事（{helper.district || "班が分からない"}）</td></tr>)}</tbody></table> : <><div class="notice"><strong>まだ申し込みはありません</strong><p>返事に書かれた手伝いと、手伝いだけの申し込みが、ここに入ります。</p></div><a class="quiet" href={adminPath(c.var.ward.slug, `/projects/${projectId}/draft/recruitment`)}>募集の下書きを開く</a></>}<p class="muted">手伝いだけの申し込みの名前は、終わりにすると消えます。</p></> : null}
  </AdminPage>, retry ? 400 : 200);
}

admin.get("/answers/:projectId", (c) => answersPage(c));

admin.use("/answers/:projectId/*", async (c, next) => {
  if (c.req.method === "POST") {
    const project = await c.env.DB.prepare("SELECT closed_at FROM projects WHERE ward_id = ? AND project_id = ?")
      .bind(c.var.ward.wardId, c.req.param("projectId")).first<{ closed_at: string | null }>();
    if (project?.closed_at) {
      return c.redirect(`${adminPath(c.var.ward.slug, `/close/${encodeURIComponent(c.req.param("projectId"))}`)}?error=answers_closed`, 303);
    }
  }
  await next();
});

installHelpAdminRoutes(admin);

async function editAnswerPage(c: Context<AdminEnv>, retry?: Record<string, unknown>) {
  const { ward } = c.var;
  const projectId = c.req.param("projectId") ?? "";
  const [project, answer] = await Promise.all([
    c.env.DB.prepare("SELECT title, closed_at FROM projects WHERE ward_id = ? AND project_id = ?")
      .bind(ward.wardId, projectId).first<{ title: string; closed_at: string | null }>(),
    getAnswer(c.env.DB, ward.wardId, projectId, c.req.param("answerId") ?? ""),
  ]);
  if (!project || !answer) return c.notFound();
  const values = retry ?? {
    household: answer.household, district: answer.district, helper_name: answer.helperName, helper_times: answer.helperTimes,
    attend: countUnread(answer) ? "" : answer.peopleCount > 0 ? "yes" : "no",
  };
  const { labels } = await residentContext(c.env.DB, ward.wardId, projectId);
  const squads = await getSquads(c.env.DB, ward.wardId);
  const district = asString(values.district);
  const editDistricts = district && !squads.includes(district) ? [...squads, district] : squads;
  const back = adminPath(ward.slug, `/answers/${encodeURIComponent(projectId)}`);
  const endpoint = `${back}/${encodeURIComponent(answer.answerId)}`;
  return c.html(<Layout title="返事を直す・消す" siteName={ward.name} noindex adminHomeHref={adminPath(ward.slug, "/")}>
    <a class="back" href={`${back}?view=list`}>← 返事の一覧へ</a>
    <h1>{answer.household}の返事を直す</h1>{!project.closed_at ? <p class="lead">直したいところを書き換えて、保存してください。保存する前に戻ると、元のままです。</p> : null}
    {project.closed_at ? <><div class="notice warn"><strong>{project.title}は終わりにしました</strong><p>返事を直すときは、先に終わりを取り消してください。</p></div><div class="action-links"><a class="button" href={adminPath(ward.slug, `/close/${encodeURIComponent(projectId)}`)}>終わりを取り消す画面へ</a></div><p class="muted">終わりを取り消しても、これまでの記録は残ります。</p></> : <>
      <form method="post" action={`${endpoint}/edit`} class="panel">
        {retry ? <Notice error>{answerProblem(retry)}入れた内容は残っています。</Notice> : null}
        <label for="edit-household">世帯の代表者（ふつうは世帯主）のお名前</label><input id="edit-household" name="household" type="text" value={asString(values.household)} required maxLength={120} />
        <fieldset><legend>班</legend><DistrictSelect districts={editDistricts} selected={district} /></fieldset>
        <AttendanceFields title={project.title} selected={asString(values.attend)} /><div class="admin-answer-counts"><CountFields labels={labels} answer={answer} prefix="edit" rawValues={retry} /></div>
        <label for="edit-helper">手伝う方のお名前（書かなくてかまいません）</label><input id="edit-helper" name="helper_name" type="text" value={asString(values.helper_name)} maxLength={240} />
        <label for="edit-times">手伝える時間帯（書かなくてかまいません）</label><input id="edit-times" name="helper_times" type="text" value={asString(values.helper_times)} maxLength={240} />
        <div class="action-bar"><button type="submit">直した返事を保存する</button></div>
        <p class="link-line"><a href={`${back}?view=list`}>保存せずに戻る</a></p>
      </form>
      <details class="fold"><summary>この返事を消す</summary><div><p>この一件を、一覧と数から消します。消したあとに入れ直すときは、「電話や紙の返事を手で入れる」を使ってください。</p><form method="post" action={`${endpoint}/delete`}><button type="submit" class="danger">この返事を消す</button></form></div></details>
    </>}
  </Layout>, retry ? 400 : 200);
}

admin.get("/answers/:projectId/:answerId/edit", (c) => editAnswerPage(c));

admin.post("/answers/:projectId/:answerId/edit", async (c) => {
  const form = await c.req.parseBody();
  const household = asString(form.household).trim();
  const district = asString(form.district).trim();
  const counts = parseAnswerCounts(form);
  const peopleCount = counts?.peopleCount ?? -1;
  const helperName = asString(form.helper_name).trim();
  const helperTimes = asString(form.helper_times).trim();
  if (!household || household.length > 120 || district.length > 80 ||
    !Number.isInteger(peopleCount) || peopleCount < 0 || peopleCount > 1000 || helperName.length > 240 || helperTimes.length > 240) {
    return editAnswerPage(c, form);
  }
  const saved = await updateAnswer(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), c.req.param("answerId"),
    { household, district, ...counts!, helperName, helperTimes });
  if (!saved) return adminResult(c, "返事を保存できませんでした。返事の一覧に戻って確認してください。終わったものは、先に終わりを取り消してください。", 409, { href: adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`), label: "返事の画面に戻る" }, "返事の画面で内容を確かめてください。終わったものの返事を直すときは、先に終わりを取り消してください。");
  return c.redirect(`${adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`)}?view=list&done=edit`, 303);
});

admin.post("/answers/:projectId/:answerId/delete", async (c) => {
  const deleted = await deleteAnswer(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), c.req.param("answerId"));
  if (!deleted) return adminResult(c, "返事を消せませんでした。返事の一覧に戻って確認してください。終わったものは、先に終わりを取り消してください。", 409, { href: adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`), label: "返事の画面に戻る" }, "返事の画面で内容を確かめてください。終わったものの返事を直すときは、先に終わりを取り消してください。");
  return c.redirect(`${adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`)}?view=list&done=delete`, 303);
});

admin.post("/answers/:projectId/phone", async (c) => {
  const form = await c.req.parseBody();
  const household = typeof form.household === "string" ? form.household.trim() : "";
  const district = typeof form.district === "string" ? form.district.trim() : "";
  const counts = parseAnswerCounts(form);
  const peopleCount = counts?.peopleCount ?? -1;
  if (!household || !Number.isInteger(peopleCount) || peopleCount < 0 || peopleCount > 1000) return answersPage(c, form);
  await addAnswer(c.env.DB, c.var.ward.wardId, { projectId: c.req.param("projectId"), household, district, ...counts!, helperName: asString(form.helper_name), helperTimes: asString(form.helper_times), source: "phone", accountId: c.var.account.accountId });
  return c.redirect(`${adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`)}?done=hand`, 303);
});

admin.post("/answers/:projectId/sheet", async (c) => {
  const form = await c.req.formData();
  const file = form.get("part");
  if (!(file instanceof File)) return adminResult(c, "回答票を選んでください。", 400, { href: adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`), label: "返事の画面に戻る" }, "返事の画面で内容を確かめてください。終わったものの返事を直すときは、先に終わりを取り消してください。");
  const qrMatches = (await Promise.all(form.getAll("paper_qr").map((value) => lookupPrintQr(c.env.DB, c.var.ward.wardId, c.var.ward.slug, String(value)))))
    .filter((value): value is NonNullable<typeof value> => value !== null);
  const qrProjects = [...new Set(qrMatches.map((value) => value.projectId))];
  const projectId = qrProjects.length === 1 ? qrProjects[0] as string : c.req.param("projectId");
  const extractedRaw = form.get("part_extracted");
  let extracted: unknown;
  if (typeof extractedRaw === "string" && extractedRaw) extracted = JSON.parse(extractedRaw);
  await receiveOriginal(c.env, waitableContext(c), {
    wardId: c.var.ward.wardId,
    projectId,
    via: "admin",
    readKind: "answer_sheet",
    accountId: c.var.account.accountId,
    parts: [{ kind: "photo", filename: file.name, mediaType: file.type, bytes: new Uint8Array(await file.arrayBuffer()), ...(extracted ? { extracted } : {}) }],
  });
  return c.redirect(`${adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(projectId)}`)}?view=sent`, 303);
});

admin.post("/answers/:projectId/sheet/:originalId/row/:rowIndex", async (c) => {
  const form = await c.req.parseBody();
  const household = asString(form.household).trim();
  const district = asString(form.district).trim();
  const helperName = asString(form.helper_name).trim();
  const helperTimes = asString(form.helper_times).trim();
  const counts = parseAnswerCounts(form);
  const peopleCount = counts?.peopleCount ?? -1;
  const rowIndex = Number(c.req.param("rowIndex"));
  if (!household || !Number.isInteger(peopleCount) || peopleCount < 0 || peopleCount > 1000 || !Number.isInteger(rowIndex) || rowIndex < 0) return adminResult(c, "読み取りを確認してください。", 400, { href: adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`), label: "返事の画面に戻る" }, "返事の画面で内容を確かめてください。終わったものの返事を直すときは、先に終わりを取り消してください。");
  const originalId = c.req.param("originalId");
  const link = await c.env.DB.prepare(`SELECT o.original_id, o.withdrawn_at AS original_withdrawn_at,
    j.withdrawn_at AS job_withdrawn_at, p.closed_at FROM originals o
    JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
    JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id
    WHERE o.ward_id = ? AND o.original_id = ? AND j.project_id = ? AND j.read_kind = 'answer_sheet'`)
    .bind(c.var.ward.wardId, originalId, c.req.param("projectId")).first<{
      original_id: string; original_withdrawn_at: string | null; job_withdrawn_at: string | null; closed_at: string | null;
    }>();
  if (!link) return c.notFound();
  if (link.closed_at) {
    return c.redirect(`${adminPath(c.var.ward.slug, `/close/${encodeURIComponent(c.req.param("projectId"))}`)}?error=answers_closed`, 303);
  }
  if (link.original_withdrawn_at || link.job_withdrawn_at) {
    return adminResult(c, "この回答票は取り下げられたため、返事を入れられません。", 409,
      { href: `${adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`)}?view=list`, label: "返事の一覧に戻る" },
      "返事の一覧に戻って確認してください。");
  }
  await addAnswer(c.env.DB, c.var.ward.wardId, {
    projectId: c.req.param("projectId"), household, district, ...counts!, helperName, helperTimes,
    source: "sheet", originalId, sheetRowIndex: rowIndex, accountId: c.var.account.accountId,
  });
  return c.redirect(`${adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`)}?view=list&done=edit`, 303);
});

admin.post("/answers/:projectId/deadline", async (c) => {
  const form = await c.req.parseBody();
  try {
    await setAnswerDeadline(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), asString(form.due_on), c.var.account.accountId);
  } catch (error) {
    return adminResult(c, error instanceof Error ? error.message : "締切を保存できませんでした。", 400, { href: adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`), label: "返事の画面に戻る" }, "返事の画面で内容を確かめてください。終わったものの返事を直すときは、先に終わりを取り消してください。");
  }
  return c.redirect(`${adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`)}?done=deadline`, 303);
});

/** 住民が次の操作を選べる、入力の誤りと受付終了の画面。 */
function ResidentError({ wardName, message, next, href, label }: { wardName: string; message: string; next: string; href: string; label: string }) {
  return <Layout title={message} siteName={wardName}>
    <h1>{message}</h1><p>{next}</p><p><a class="button secondary" href={href}>{label}</a></p>
  </Layout>;
}

function HelpForm({ wardName, slug, projectId, opportunity, contact, newer, choices, name = "", times = "", error, submissionId }: {
  wardName: string; slug: string; projectId: string; opportunity: HelpOpportunity; contact: string; newer: boolean;
  choices: string[]; name?: string; times?: string; error?: string; submissionId?: string;
}) {
  return <Layout title={`${opportunity.title}を一回だけ手伝う`} siteName={wardName}>
    <a class="back" href={`/${slug}/`}>← お知らせの一覧へ</a>
    <h1>{opportunity.title}で手伝える時間帯を教えてください</h1>
    <p class="lead">自治会に加入していなくても申し込めます。お名前と手伝える時間帯を教えてください。</p>
    {error ? <Notice error>{error} 入れた内容は残っています。</Notice> : null}
    {newer ? <p class="notice">この募集のあとに、新しいお知らせを載せました。<a href={`/${slug}/p/${encodeURIComponent(projectId)}`}>新しいお知らせを読んでください</a>。</p> : null}
    <ArticleBody body={opportunity.body} />
    <form method="post" action={`/${slug}/help/${encodeURIComponent(projectId)}`}>
      <input type="hidden" name="submission_id" value={submissionId || newId()} />
      <label for="helper-name">お名前</label><input id="helper-name" name="helper_name" type="text" maxlength={120} value={name} required />
      <label for="helper-times">手伝える時間帯</label>
      {choices.length ? <select id="helper-times" name="helper_times" required><option value="">選んでください</option>{choices.map((time) => <option value={time} selected={time === times}>{time}</option>)}</select>
        : <input id="helper-times" name="helper_times" type="text" maxlength={240} value={times} required />}
      <p>名前と時間帯は、この行事の準備に使い、行事が終わると消します。変更は住民向けのページに載せます。</p>
      <button type="submit">申し込む</button>
    </form>
    <h2>分からないときは</h2><ResidentContact contact={contact} />
  </Layout>;
}

pub.use("/help/*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  await next();
});

pub.get("/help/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const [opportunity] = await listHelpOpportunities(c.env.DB, c.var.ward.wardId, projectId);
  if (!opportunity) return c.html(<ResidentError wardName={c.var.ward.name} message="手伝いの受付は終わりました。" next="確認したいことは、班長か役員にお知らせください。" href={`/${c.var.ward.slug}/`} label="お知らせの一覧へ" />);
  const context = await residentContext(c.env.DB, c.var.ward.wardId, projectId);
  const newer = context.documents.some((document) => (document.kind === "notice" || document.kind === "announcement") && document.publishedAt > opportunity.publishedAt);
  return c.html(<HelpForm wardName={c.var.ward.name} slug={c.var.ward.slug} projectId={projectId} opportunity={opportunity} contact={context.contact} newer={newer} choices={helpTimeChoices(opportunity.body)} />);
});

pub.post("/help/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const form = await c.req.parseBody();
  const name = asString(form.helper_name).trim();
  const times = asString(form.helper_times).trim();
  const submissionId = asString(form.submission_id);
  // 受け付けた送信の再読み込みは、今の募集条件で判定し直さず保存内容へ戻す。
  let offered = submissionId ? await getHelpOfferBySubmission(c.env.DB, c.var.ward.wardId, projectId, submissionId) : null;
  if (!offered) {
    const [opportunity] = await listHelpOpportunities(c.env.DB, c.var.ward.wardId, projectId);
    if (!opportunity) return c.html(<ResidentError wardName={c.var.ward.name} message="手伝いの受付は終わりました。" next="確認したいことは、班長か役員にお知らせください。" href={`/${c.var.ward.slug}/`} label="住民向けのページへ" />, 400);
    const choices = helpTimeChoices(opportunity.body);
    const invalid = !name || !times ? "お名前と手伝える時間帯を入れてください。" : name.length > 120 || times.length > 240 ? "お名前か時間帯が長すぎます。短くしてください。" : choices.length && !choices.includes(times) ? "募集にある時間帯を選んでください。" : "";
    if (invalid) {
      const context = await residentContext(c.env.DB, c.var.ward.wardId, projectId);
      const newer = context.documents.some((document) => (document.kind === "notice" || document.kind === "announcement") && document.publishedAt > opportunity.publishedAt);
      return c.html(<HelpForm wardName={c.var.ward.name} slug={c.var.ward.slug} projectId={projectId} opportunity={opportunity} contact={context.contact} newer={newer} choices={choices} name={name} times={times} error={invalid} submissionId={submissionId} />, 400);
    }
    offered = await addHelpOffer(c.env.DB, c.var.ward.wardId, projectId, name, times, submissionId);
  }
  if (!offered) return c.html(<ResidentError wardName={c.var.ward.name} message="手伝いの受付は終わりました。" next="確認したいことは、班長か役員にお知らせください。" href={`/${c.var.ward.slug}/`} label="住民向けのページへ" />, 400);
  const context = await residentContext(c.env.DB, c.var.ward.wardId, projectId);
  return c.html(<Layout title="申し込みを受け付けました" siteName={c.var.ward.name}>
    <h1>申し込みを受け付けました</h1><p>ありがとうございました。この画面は閉じてかまいません。</p>
    <dl><dt>お名前</dt><dd>{offered.name}</dd><dt>時間帯</dt><dd>{offered.times}</dd></dl>
    <section class="next"><strong>次は</strong><EventDetails item={context.item} hasNotice={context.hasNotice} /><p>手伝える時間帯: {offered.times}</p>{!context.hasNotice ? <p>変更は住民向けのページに載せます。</p> : null}</section>
    <p class="link-line"><a href={`/${c.var.ward.slug}/p/${encodeURIComponent(projectId)}`}>案内を読む</a></p>
    <h2>都合が悪くなったときは</h2><p>間違えたときも、下の連絡先へお知らせください。</p><ResidentContact contact={context.contact} />
  </Layout>);
});

async function answerProject(db: D1Database, wardId: string, projectId: string) {
  return db.prepare(`SELECT p.title, p.closed_at, d.due_on FROM projects p LEFT JOIN project_deadlines d
    ON d.ward_id = p.ward_id AND d.project_id = p.project_id AND d.kind = 'answer_due'
    WHERE p.ward_id = ? AND p.project_id = ?`).bind(wardId, projectId).first<{ title: string; closed_at: string | null; due_on: string | null }>();
}

function isAnswerClosed(project: { closed_at: string | null; due_on: string | null }): boolean {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
  return project.closed_at !== null || (project.due_on !== null && project.due_on < today);
}

pub.use("/answer/*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  await next();
});

function AnswerForm({ wardName, slug, projectId, title, squads, labels, published, selected = "", values = {}, error, choices = [] }: {
  wardName: string; slug: string; projectId: string; title: string; squads: string[]; labels: AnswerLabels; published: boolean;
  selected?: string; values?: Record<string, unknown>; error?: string; choices?: string[];
}) {
  const counts = parseAnswerCounts(values);
  const district = typeof values.district === "string" ? values.district : selected;
  return <Layout title={`${title}の出欠を教えてください`} siteName={wardName}>
    {published ? <a class="back" href={`/${slug}/p/${encodeURIComponent(projectId)}`}>← {title}の案内へ</a> : <a class="back" href={`/${slug}/`}>← {wardName}のお知らせへ</a>}
    <h1>{title}の出欠を教えてください</h1><p class="lead">参加するかどうかを教えてください。返事がないときは、欠席として数えます。登録はいりません。</p>
    {error ? <Notice error>{error} 入れた人数は残っています。</Notice> : null}
    <form method="post" action={`/${slug}/answer/${encodeURIComponent(projectId)}${selected ? `?s=${encodeURIComponent(selected)}` : ""}`}>
      <input type="hidden" name="submission_id" value={asString(values.submission_id) || newId()} />
      <div class="field"><label for="household">代表者のお名前</label><input id="household" name="household" type="text" autocomplete="name" maxlength={120} value={asString(values.household)} required /><p class="help-text">ふつうは世帯主の方のお名前です。ご家族のどなたが答えてもかまいません。例: 山田 太郎</p></div>
      {selected ? <><dl class="facts"><dt>班</dt><dd>{selected}</dd></dl><details class="fold" open={!!error}><summary>班が違うときは選び直す</summary><div><DistrictSelect districts={squads} selected={district} /></div></details></>
        : <fieldset><legend>班</legend><DistrictSelect districts={squads} selected={district} unset={!("district" in values)} /><p class="muted">分からないときは、そのまま送ってかまいません。役員が確かめます。</p></fieldset>}
      <AttendanceFields title={title} selected={asString(values.attend)} />
      <CountFields labels={labels} answer={Object.keys(values).length ? counts ?? undefined : undefined} rawValues={values} />
      <details class="fold" open={!!error && (!!values.helper_name || !!values.helper_times)}><summary>手伝える方はこちら（書かなくてかまいません）</summary><div>
        <div class="field"><label for="helper">手伝う方のお名前</label><input id="helper" name="helper_name" type="text" maxlength={120} value={asString(values.helper_name)} /></div>
        {choices.length ? <fieldset><legend>手伝える時間帯</legend><div class="choice">{choices.map((time) => <label><input type="radio" name="helper_times" value={time} checked={values.helper_times === time} /> {time}</label>)}</div></fieldset>
          : <div class="field"><label for="times">手伝える時間帯</label><input id="times" name="helper_times" type="text" maxlength={240} value={asString(values.helper_times)} /></div>}
      </div></details>
      <p>紙の回答票を出した方は、ここで答えなくてかまいません。</p><div class="action-bar"><button type="submit">この内容で送る</button></div>
    </form>
  </Layout>;
}

pub.get("/answer/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const project = await answerProject(c.env.DB, c.var.ward.wardId, projectId);
  if (!project) return c.notFound();
  const [squads, context] = await Promise.all([getSquads(c.env.DB, c.var.ward.wardId), residentContext(c.env.DB, c.var.ward.wardId, projectId)]);
  if (isAnswerClosed(project)) return c.html(<Layout title="返事の受付は終わりました" siteName={c.var.ward.name}><h1>{project.title}のご案内</h1><ReceptionClosed closed={!!project.closed_at} due={project.due_on} /><ResidentContact contact={context.contact} /><a href={`/${c.var.ward.slug}/p/${encodeURIComponent(projectId)}`}>案内を読む</a></Layout>);
  const selected = squads.includes(c.req.query("s") ?? "") ? c.req.query("s") : "";
  const announcement = context.documents.find((document) => document.kind === "announcement");
  return c.html(<AnswerForm wardName={c.var.ward.name} slug={c.var.ward.slug} projectId={projectId} title={project.title} squads={squads} labels={context.labels} published={context.documents.length > 0} selected={selected} choices={helpTimeChoices(announcement?.body ?? "").filter((time) => time !== PENDING)} />);
});

pub.post("/answer/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const form = await c.req.parseBody();
  const project = await answerProject(c.env.DB, c.var.ward.wardId, projectId);
  if (!project) return c.notFound();
  const context = await residentContext(c.env.DB, c.var.ward.wardId, projectId);
  const wardId = c.var.ward.wardId;
  const submissionId = asString(form.submission_id);
  const received = (answer: AnswerRow | null) => c.html(<Layout title="返事を受け付けました" siteName={c.var.ward.name}>
    <h1>返事を受け付けました</h1><p>ありがとうございました。この画面は閉じてかまいません。</p>
    {answer ? <dl><dt>代表者</dt><dd>{answer.household}</dd><dt>班</dt><dd>{answer.district || "班が分からない"}</dd><dt>{answer.peopleCount === 0 ? "返事" : "人数"}</dt><dd>{countText(answer, context.labels)}</dd></dl> : null}
    {answer && answer.peopleCount > 0 ? <section class="next"><strong>次は</strong><EventDetails item={context.item} hasNotice={context.hasNotice} />{!context.hasNotice ? <p>変更は案内で確かめられます。</p> : null}</section> : null}
    <h2>間違えたときは</h2><p>もう一度送らず、下の連絡先にお知らせください。役員が直します。</p><ResidentContact contact={context.contact} />
    <p class="link-line"><a href={`/${c.var.ward.slug}/p/${encodeURIComponent(projectId)}`}>案内へ戻る</a></p>
  </Layout>);
  const closed = () => c.html(<Layout title="返事の受付は終わりました" siteName={c.var.ward.name}><h1>返事の受付は終わりました</h1><ReceptionClosed closed={!!project.closed_at} due={project.due_on} /><ResidentContact contact={context.contact} /><a href={`/${c.var.ward.slug}/p/${encodeURIComponent(projectId)}`}>案内を読む</a></Layout>, 400);
  const submission = () => c.env.DB.prepare("SELECT answer_id FROM project_answer_submissions WHERE ward_id = ? AND project_id = ? AND submission_id = ?")
    .bind(wardId, projectId, submissionId).first<{ answer_id: string }>();
  // 保存後の再読み込みは、締切後や役員の訂正・削除後も新しい答えにしない。
  const previous = submissionId ? await submission() : null;
  if (previous) return received(await getAnswer(c.env.DB, wardId, projectId, previous.answer_id));
  if (isAnswerClosed(project)) return closed();
  const household = asString(form.household).trim();
  const district = asString(form.district).trim();
  const counts = parseAnswerCounts(form);
  const helperName = asString(form.helper_name).trim();
  const helperTimes = asString(form.helper_times).trim();
  const squads = await getSquads(c.env.DB, c.var.ward.wardId);
  const error = !household ? "お名前が入っていません。お名前を入れて、もう一度送ってください。" : household.length > 120 || district.length > 80 || !counts || helperName.length > 120 || helperTimes.length > 240 ? "入力を確認してください。お名前と人数を書き直してください。" : district && squads.length && !squads.includes(district) ? "班を選び直してください。分からないときは「分からない」を選べます。" : "";
  if (error) return c.html(<AnswerForm wardName={c.var.ward.name} slug={c.var.ward.slug} projectId={projectId} title={project.title} squads={squads} labels={context.labels} published={context.documents.length > 0} selected={squads.includes(c.req.query("s") ?? "") ? c.req.query("s") : ""} values={form} error={error} choices={helpTimeChoices(context.documents.find((document) => document.kind === "announcement")?.body ?? "").filter((time) => time !== PENDING)} />, 400);
  if (!submissionId) {
    // 既に開いている旧画面からの答えも受け付ける。
    const id = await addAnswer(c.env.DB, wardId, { projectId, household, district, ...counts!, helperName, helperTimes, source: "web" });
    return received(await getAnswer(c.env.DB, wardId, projectId, id));
  }
  const answerId = newId();
  // 答えと処理済みの番号を同じ書き込みで残す。同時の再送も別の答えにしない。
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO project_answers
      (answer_id, ward_id, project_id, household, district, people_count, children_count, adults_count, seniors_count, helper_name, helper_times, source, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'web', ?
      WHERE EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL)
        AND NOT EXISTS (SELECT 1 FROM project_answer_submissions WHERE ward_id = ? AND project_id = ? AND submission_id = ?)`)
      .bind(answerId, wardId, projectId, household, district, counts!.peopleCount, counts!.childrenCount ?? null,
        counts!.adultsCount ?? null, counts!.seniorsCount ?? null, helperName, helperTimes, nowIso(), wardId, projectId, wardId, projectId, submissionId),
    c.env.DB.prepare(`INSERT INTO project_answer_submissions (ward_id, project_id, submission_id, answer_id)
      SELECT ward_id, project_id, ?, answer_id FROM project_answers WHERE ward_id = ? AND project_id = ? AND answer_id = ?`)
      .bind(submissionId, wardId, projectId, answerId),
  ]);
  const saved = await submission();
  return saved ? received(await getAnswer(c.env.DB, wardId, projectId, saved.answer_id)) : closed();
});

function DistrictSelect({ districts, selected = "", unset = false }: { districts: string[]; selected?: string; unset?: boolean }) {
  return <div class="choice half">{districts.map((district) => <label><input type="radio" name="district" value={district} checked={selected === district} /> {district}</label>)}<label><input type="radio" name="district" value="" checked={selected === "" && !unset} /> 分からない</label></div>;
}

function RosterColumnPicker({ wardName, wardSlug, headers, rows }: { wardName: string; wardSlug: string; headers: string[]; rows: string[][] }) {
  return <Layout title="名簿の項目を選ぶ" siteName={wardName} noindex adminHomeHref={adminPath(wardSlug, "/")}><h1>世帯の代表者のお名前と班の項目を選んでください</h1><p class="lead">名簿の見出しに合わせて、世帯の代表者（ふつうは世帯主）のお名前と班の項目を選び、「名簿を入れる」を押してください。</p><p>先頭の行から項目を見つけられませんでした。</p><form method="post" action={adminPath(wardSlug, "/answers/roster")}>
    <input type="hidden" name="rows_json" value={JSON.stringify(rows)} />
    <label for="household-column">世帯の代表者のお名前</label><select id="household-column" name="household_column" required><option value="" selected disabled>選んでください</option>{headers.map((header, index) => <option value={index}>{header || `${index + 1}番目`}</option>)}</select>
    <label for="district-column">班</label><select id="district-column" name="district_column" required><option value="" selected disabled>選んでください</option>{headers.map((header, index) => <option value={index}>{header || `${index + 1}番目`}</option>)}</select>
    <div class="action-bar"><button type="submit">名簿を入れる</button></div>
  </form></Layout>;
}

function renderSheetRows(body: string | null, projectId: string, originalId: string, wardSlug: string, closed: boolean, answers: AnswerRow[], labels: AnswerLabels, title: string, districts: string[], primary = false) {
  if (!body) return <p>読み取り中です。時間をおいてもう一度開いてください。</p>;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return <p>読み取りを表示できません。もう一度読み取ってください。</p>;
  }
  if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { rows?: unknown }).rows)) {
    return <p>回答票の読み取り結果がありません。</p>;
  }
  const reading = parsed as AnswerSheetReading;
  if (reading.rows.length === 0) return <p>{reading.summary || "回答票から返事を見つけられませんでした。"}</p>;
  const firstUnsaved = reading.rows.findIndex((_, index) => !answers.some((answer) => answer.originalId === originalId && answer.sheetRowIndex === index));
  return <>
    <div class="notice"><strong>{reading.summary}</strong><p>読み取った内容は、下の欄に入れてあります。</p></div>
    {reading.rows.map((row, index) => {
      const saved = answers.find((answer) => answer.originalId === originalId && answer.sheetRowIndex === index);
      const count = saved?.peopleCount ?? (row.not_attending ? 0 : (row.adults ?? 0) + (row.children ?? 0) + (row.seniors ?? 0));
      const endpoint = adminPath(wardSlug, `/answers/${encodeURIComponent(projectId)}/sheet/${encodeURIComponent(originalId)}/row/${index}`);
      return <form class="panel" method="post" action={endpoint}>
        <h2>{index + 1}枚目（{row.locator}）{saved ? <span class="tag done">入れました</span> : null}</h2>
        <label for={`sheet-household-${originalId}-${index}`}>世帯の代表者のお名前</label><input id={`sheet-household-${originalId}-${index}`} name="household" type="text" value={saved?.household ?? row.household_name} required maxlength={120} disabled={closed} />
        <fieldset><legend>班</legend><div class="choice half">{[...new Set([...districts, saved?.district ?? row.ward_group].filter(Boolean))].map((district) => <label><input type="radio" name="district" value={district} checked={district === (saved?.district ?? row.ward_group)} disabled={closed} />{district}</label>)}<label><input type="radio" name="district" value="" checked={!(saved?.district ?? row.ward_group)} disabled={closed} />分からない</label></div></fieldset>
        <AttendanceFields title={title} selected={saved ? (countUnread(saved) ? undefined : saved.peopleCount > 0 ? "yes" : "no") : row.not_attending ? "no" : count > 0 ? "yes" : undefined} disabled={closed} />
        <div class="admin-answer-counts"><CountFields labels={labels} answer={saved ?? { peopleCount: count, childrenCount: row.not_attending ? 0 : row.children, adultsCount: row.not_attending ? 0 : row.adults, seniorsCount: row.not_attending ? 0 : row.seniors }} prefix={`sheet-${originalId}-${index}`} disabled={closed} /></div>
        {!saved && !row.not_attending && count === 0 ? <p class="warn-text">人数が読めませんでした。写真を見て入れてください。</p> : null}
        <label for={`sheet-helper-${originalId}-${index}`}>手伝う方のお名前（書かなくてかまいません）</label><input id={`sheet-helper-${originalId}-${index}`} name="helper_name" type="text" value={saved?.helperName ?? row.helper_names.join("、")} maxlength={240} disabled={closed} />
        <label for={`sheet-times-${originalId}-${index}`}>手伝える時間帯（書かなくてかまいません）</label><input id={`sheet-times-${originalId}-${index}`} name="helper_times" type="text" value={saved?.helperTimes ?? row.helper_slots.join("、")} maxlength={240} disabled={closed} />
        {!closed ? <><p>読み違いがあれば直して入れられます。</p>
        <div class={primary && index === firstUnsaved ? "action-bar page-action" : "action-links"}><button type="submit" class={primary && index === firstUnsaved ? undefined : "secondary"}>{saved ? "直して入れ直す" : "返事に入れる"}</button></div></> : null}
      </form>;
    })}
  </>;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function adminPath(wardSlug: string, path: string): string {
  return `/${encodeURIComponent(wardSlug)}/admin${path}`;
}

export const answers: Bundle = { admin, pub };
