import { adminResult } from "../core/admin-ui";
import { CountFields, countText, parseAnswerCounts } from "./counts";
import { type AnswerLabels } from "../settings/answer-labels";
import { EventDetails, ReceptionClosed, ResidentContact, residentContext } from "./resident";
import { formatJstDate } from "../core/time";
import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { Layout, Notice } from "../core/ui";
import { AdminPage } from "../core/admin-ui";
import type { AdminEnv, WardEnv } from "../env";
import type { AnswerSheetReading } from "../ai/schema";
import type { Reading } from "../ai/schema";
import type { Waitable } from "../intake/types";
import { receiveOriginal, getReadings } from "../intake/api";
import { getOriginal } from "../intake/store";
import { SEND_SCRIPT } from "../intake/browser-script";
import { getSquads } from "../settings/store";
import { lookupPrintQr } from "../print/qr";
import { ArticleBody } from "../publish";
import { addHelpOffer, helpTimeChoices, listHelpOffers, listHelpOpportunities } from "./help";
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
  const rows = await c.env.DB.prepare("SELECT project_id, title, year FROM projects WHERE ward_id = ? ORDER BY year DESC, created_at DESC")
    .bind(c.var.ward.wardId).all<{ project_id: string; title: string; year: number }>();
  return c.html(
    <Layout title="答え" siteName={c.var.ward.name} noindex adminHomeHref={adminPath(c.var.ward.slug, "/")}>
      <h1>答え</h1><p class="lead">答えを見る行事を選んでください。Web、電話、回答票で受けた内容を同じ一覧で見られます。</p>
      <p><a href={`/${c.var.ward.slug}/`} aria-label="区のページ">区のページ</a></p>
      <p><a class="button" href={adminPath(c.var.ward.slug, "/answers/roster")}>名簿を入れる</a></p>
      <h2>答えを確認する</h2>
      {rows.results.length === 0 ? <p class="panel">行事はまだありません。</p> : (
        <ul>{rows.results.map((row) => <li><a href={adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(row.project_id)}`)}>{row.title}（{row.year}年）</a> <a href={adminPath(c.var.ward.slug, `/space/${encodeURIComponent(row.project_id)}`)}>実行委員と班長のページの設定</a> <a href={`/${encodeURIComponent(c.var.ward.slug)}/answer/${encodeURIComponent(row.project_id)}`}>答えページ</a></li>)}</ul>
      )}
    </Layout>,
  );
});

admin.get("/answers/roster", async (c) => {
  const entries = await getRoster(c.env.DB, c.var.ward.wardId);
  const saved = await getSavedRosterColumns(c.env.DB, c.var.ward.wardId);
  const copies = await getDistrictCopies(c.env.DB, c.var.ward.wardId);
  return c.html(
    <Layout title="名簿" siteName={c.var.ward.name} noindex adminHomeHref={adminPath(c.var.ward.slug, "/")}>
      <h1>名簿</h1><p class="lead">代表者のお名前と班の一覧を入れる画面です。CSVやExcelを選ぶか、紙の名簿を撮って送ってください。</p>
      <p>CSVまたはExcelの一覧を選んでください。先頭の行から代表者のお名前と班を見つけます。見つからないときだけ項目を選びます。</p>
      <form method="post" action={adminPath(c.var.ward.slug, "/answers/roster/photo")} enctype="multipart/form-data">
        <label for="roster-photo">見出しのない紙の名簿</label><input id="roster-photo" name="photo" type="file" accept="image/*,.pdf" capture="environment" required />
        <button type="submit">写真を読み取る</button>
      </form>
      {c.req.query("job") ? <RosterPhotoResult wardSlug={c.var.ward.slug} wardId={c.var.ward.wardId} db={c.env.DB} jobId={c.req.query("job") ?? ""} /> : null}
      <form id="send-form" method="post" action={adminPath(c.var.ward.slug, "/answers/roster")} enctype="multipart/form-data">
        <label for="files">名簿ファイル</label>
        <input id="files" name="part" type="file" accept=".csv,.xlsx" required />
        <input type="hidden" name="text" value="" />
        <p id="send-status" class="notice" role="status"></p>
        <button id="send-button" type="submit">名簿を読み込む</button>
      </form>
      <script dangerouslySetInnerHTML={{ __html: SEND_SCRIPT }} />
      <p class="muted">現在の名簿: {entries.length} 世帯。班ごとの部数を確認できます。</p>
      {saved ? <p class="muted">前回使った項目位置: 代表者のお名前{saved.household + 1} 番目、班{saved.district + 1} 番目</p> : null}
      {copies.length ? <div class="panel"><h2>班ごとの部数</h2><ul>{copies.map((row) => <li>{row.district}: {row.copies} 部</li>)}</ul></div> : null}
      {entries.length ? <div class="panel"><h2>世帯と班</h2><div style="overflow-x:auto"><table><thead><tr><th>世帯</th><th>班</th></tr></thead><tbody>{entries.map((entry) => <tr><td>{entry.household}</td><td>{entry.district}</td></tr>)}</tbody></table></div></div> : null}
    </Layout>,
  );
});

async function RosterPhotoResult({ wardSlug, wardId, db, jobId }: { wardSlug: string; wardId: string; db: D1Database; jobId: string }) {
  const readings = await getReadings(db, wardId, jobId);
  const reading = readings.find((row) => "tables" in row.body)?.body;
  if (!reading || !("tables" in reading)) return <p class="notice">読み取りが終わると、ここに名簿が表示されます。ページを開き直してください。</p>;
  const tables = reading.tables.map((table, index) => ({ table, index })).filter(({ table }) => table.rows.length > 0);
  return <section class="panel"><h2>読み取った名簿</h2>{tables.map(({ table, index }) => <form method="post" action={adminPath(wardSlug, "/answers/roster/photo/import")}>
    <p>{table.name}（{table.rows.length} 行）</p><div style="overflow-x:auto"><table><tbody>{table.rows.slice(0, 12).map((row) => <tr>{row.cells.map((cell) => <td>{cell}</td>)}</tr>)}</tbody></table></div>
    <input type="hidden" name="jobId" value={jobId} /><input type="hidden" name="tableIndex" value={index} /><button type="submit">この名簿を使う</button>
  </form>)}</section>;
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
  return c.redirect(adminPath(c.var.ward.slug, "/answers/roster"), 303);
});

admin.post("/answers/roster", async (c) => {
  const wantsJson = (c.req.header("accept") ?? "").includes("application/json");
  const reply = (ok: boolean, message: string, status: 200 | 400 | 500 = 200) =>
    wantsJson ? c.json({ ok, message }, status) : adminResult(c, message, status, { href: adminPath(c.var.ward.slug, "/answers/roster"), label: "名簿に戻る" }, "名簿の写真やファイルを選び、もう一度送ってください。");
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
    return wantsJson ? reply(true, "名簿を読み込みました。") : c.redirect(adminPath(c.var.ward.slug, "/answers/roster"), 303);
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
  return wantsJson ? reply(true, "名簿を読み込みました。") : c.redirect(adminPath(c.var.ward.slug, "/answers/roster"), 303);
});

admin.get("/answers/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
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
  const view = c.req.query("view") ?? "summary";
  const closed = !!project.closed_at;
  const back = { href: root, label: `← ${project.title}の答えへ` };
  const roster = await getRoster(c.env.DB, c.var.ward.wardId);
  const remaining = unanswered.reduce((sum, group) => sum + group.households.length, 0);
  const helperCount = helpers.length + offers.length;
  const titles: Record<string, string> = { send: "回答票を撮って送る", sent: "回答票を受け取りました", unanswered: "まだ答えていない世帯", hand: "電話や紙の答えを手で入れる", list: "答えの一覧", helpers: "手伝いの一覧" };
  const title = titles[view] ?? `${project.title}の答え`;
  const receipt = c.req.query("done");
  if (receipt === "hand" || receipt === "deadline" || receipt === "edit" || receipt === "delete") {
    const message = receipt === "hand" ? "入れました。数に入りました" : receipt === "deadline" ? "変えました。案内の文は変わりません" : receipt === "edit" ? "答えを直しました。数に入りました" : "答えを消しました。数から外しました";
    const label = receipt === "hand" ? "続けて入れる" : receipt === "deadline" ? "下書きを見る" : "答えの一覧を見る";
    const href = receipt === "hand" ? `${root}?view=hand` : receipt === "deadline" ? adminPath(c.var.ward.slug, `/projects/${projectId}/draft`) : `${root}?view=list`;
    return c.html(<AdminPage ward={c.var.ward} account={c.var.account} title={message} back={back}>
      <h1>{message}</h1><section class="next"><strong>次は</strong><p>{receipt === "hand" ? "続けて入れられます。" : receipt === "deadline" ? "知らせたいときは、直して配り直せます。" : "答えと数を見られます。"}</p><a class="button" href={href}>{label}</a></section>
      {receipt === "hand" || receipt === "edit" ? <><h2>間違えたときは</h2><a class="quiet" href={`${root}?view=list`}>答えの一覧で直す</a></> : receipt === "delete" ? <a class="quiet" href={`${root}?view=hand`}>電話や紙の答えを手で入れる</a> : <a class="quiet" href={root}>答えの締切を変える</a>}
    </AdminPage>);
  }
  return c.html(<AdminPage ward={c.var.ward} account={c.var.account} title={title}
    back={view === "summary" ? { href: adminPath(c.var.ward.slug, `/projects/${projectId}/map`), label: `← ${project.title}の段取りへ` } : back}>
    <h1 class={view === "summary" || view === "list" || view === "helpers" ? "answers-wide" : undefined}>{title}</h1>
    {closed ? <Notice>この行事は閉じました。答えを直すときは<a href={adminPath(c.var.ward.slug, `/close/${projectId}`)}>閉じた画面から、もう一度開いてください</a>。</Notice> : null}
    {view === "summary" ? <>
      <p class="lead">紙、電話、スマホの答えを合わせた数です。{deadline ? `答えの締切は${formatJstDate(deadline)}です。` : "答えの締切はまだ決まっていません。"}</p>
      <div class="counts"><div class="count"><b>{answers.length}<small>世帯</small></b><span>{roster.length ? `${roster.length}世帯のうち` : "名簿はまだありません"}</span></div><div class="count"><b>{totals.people}<small>人</small></b><span>参加する</span></div><div class="count"><b>{helperCount}<small>人</small></b><span>手伝い</span></div></div>
      {answers.some((answer) => answer.childrenCount != null || answer.adultsCount != null || answer.seniorsCount != null) ? <p class="muted">参加する人の内わけは、{labels.map((label, index) => `${label}${answers.reduce((sum, answer) => sum + ([answer.childrenCount, answer.adultsCount, answer.seniorsCount][index] ?? 0), 0)}人`).join("、")}です。{answers.some((answer) => answer.childrenCount == null && answer.adultsCount == null && answer.seniorsCount == null) ? "内わけのない答えは合計だけに含めています。" : ""}</p> : null}
      {!closed ? <div class="action-links"><a class="button" href={`${root}?view=send`}>回答票を撮って送る</a></div> : null}
      <ul class="rows two">
        <li><a class="row-link" href={`${root}?view=unanswered`}><b>まだ答えていない世帯{remaining}世帯</b><span>班ごとに見て、印刷して班長に渡せます</span></a></li>
        {!closed ? <li><a class="row-link" href={`${root}?view=hand`}><b>電話や紙の答えを手で入れる</b><span>代表者のお名前、班、人数を入れます</span></a></li> : null}
        <li><a class="row-link" href={`${root}?view=list`}><b>答えの一覧</b><span>読み違いは、ここで直せます</span></a></li>
        <li><a class="row-link" href={`${root}?view=helpers`}><b>手伝いの一覧{helperCount}人</b><span>当番表の下書きを作れます</span></a></li>
      </ul>
      {!closed ? <details class="fold"><summary>答えの締切を変える</summary><div><form method="post" action={`${root}/deadline`}><label for="due">答えの締切</label><input id="due" name="due_on" type="date" value={deadline ?? ""} required /><button class="secondary">締切を変える</button></form></div></details> : null}
    </> : null}
    {view === "send" && !closed ? <>
      <p class="lead">集まった回答票を撮ってください。一枚の写真に何枚写っていてもかまいません。</p>
      <form method="post" action={`${root}/sheet`} enctype="multipart/form-data"><div class="field"><label class="file-button">カメラで回答票を撮る<input name="part" type="file" accept="image/*,.pdf" capture="environment" required /></label></div><div class="action-links"><button>送る</button></div></form>
      <details class="hint"><summary>読みにくい字があったとき</summary><div><p>そのまま送ってください。読めないところは答えの一覧に出ます。全部を見直す必要はありません。</p></div></details>
    </> : null}
    {view === "sent" ? <><p class="lead">読み取れた分から数えに入れます。読み違いは、答えの一覧で直せます。</p><section class="next"><strong>次は</strong><p>答えの数に入ったか見てください。</p><a class="button" href={root}>答えを見る</a></section><a class="quiet" href={`${root}?view=send`}>続けて撮って送る</a><p><a class="quiet" href={`${root}?view=list`}>答えの一覧で直す</a></p><p class="muted">写真が残るので、紙は捨ててかまいません。班長から預かった紙も同じです。</p></> : null}
    {view === "hand" && !closed ? <><p class="lead">聞いた内容を入れてください。</p><form method="post" action={`${root}/phone`}>
      <div class="field"><label for="household">代表者のお名前</label><input id="household" name="household" required maxlength={120} /></div>
      <fieldset><legend>班</legend><div class="choice half">{districts.map((district) => <label><input type="radio" name="district" value={district} /> {district}</label>)}<label><input type="radio" name="district" value="" checked /> 分からない</label></div></fieldset>
      <div class="admin-answer-counts"><CountFields labels={labels} /></div>
      <details class="fold"><summary>手伝いの希望があるとき</summary><div><label for="helper">手伝う方のお名前</label><input id="helper" name="helper_name" maxlength={120} /><label for="times">手伝える時間帯</label><input id="times" name="helper_times" maxlength={240} /></div></details>
      <div class="action-bar"><button>この答えを入れる</button></div>
    </form></> : null}
    {view === "unanswered" ? <><p class="lead">名簿の世帯のうち、まだ答えが届いていない世帯です。参加しない世帯も入っています。</p><div class="action-links"><button type="button" onclick="window.print()">この一覧を印刷する</button></div>
      <section class="answer-unanswered-print"><h2 class="print-only">{project.title} まだ答えていない世帯</h2>{!roster.length ? <p>名簿はまだありません。名簿を入れると、まだ答えていない世帯を見られます。</p> : unanswered.map((group) => <section><h2>{group.district}（{group.households.length}世帯）</h2>{group.households.length ? <ul>{group.households.map((name) => <li>{name}</li>)}</ul> : <p>まだ答えていない世帯はありません。</p>}</section>)}</section>
      <p class="muted">印刷して班長に渡すと、声をかけてもらえます。名前の書き方が名簿と違うと、答えていてもここに出ることがあります。</p></> : null}
    {view === "list" ? <><p class="lead">押すと、直したり消したりできます。</p><ul class="rows two">{answers.map((answer) => <li><a class="row-link" href={`${root}/${encodeURIComponent(answer.answerId)}/edit`}><b>{answer.household}</b><span>{answer.district || "班が分からない"}　{countText(answer, labels)}</span><span>{answer.source === "web" ? "スマホの答え" : answer.source === "phone" ? "電話の答え" : answer.source === "line" ? "LINEの答え" : "紙の回答票から読みました"}</span></a></li>)}</ul>
      {!answers.length ? <p>答えはまだありません。</p> : null}<p>班が分からない{answers.filter((answer) => !answer.district).length}世帯</p>
      {sheets.results.map((sheet) => <details class="fold"><summary>{sheet.filename || "回答票の読み取り"}</summary><div><a class="quiet" href={adminPath(c.var.ward.slug, `/intake/originals/${encodeURIComponent(sheet.original_id)}`)}>回答票の写真を読む</a>{renderSheetRows(sheet.body, projectId, sheet.original_id, c.var.ward.slug, closed, answers, labels)}</div></details>)}</> : null}
    {view === "helpers" ? <><p class="lead">世帯の答えにある手伝いと、手伝いだけの申し込みを合わせました。</p>{!closed ? <form class="action-links" method="post" action={adminPath(c.var.ward.slug, `/projects/${projectId}/draft/duty_roster/start`)}><button>当番表の下書きを作る</button></form> : null}
      {helperCount ? <table class="stack"><thead><tr><th>お名前</th><th>時間帯</th><th>申し込み</th></tr></thead><tbody>{offers.map((offer) => <tr><td data-label="お名前">{offer.name}</td><td data-label="時間帯">{offer.times}</td><td data-label="申し込み">手伝いだけ</td></tr>)}{helpers.map((helper) => <tr><td data-label="お名前">{helper.name}</td><td data-label="時間帯">{helper.times}</td><td data-label="申し込み">世帯の答え（{helper.district || "班が分からない"}）</td></tr>)}</tbody></table> : <p>手伝いの希望はまだありません。</p>}<p class="muted">手伝いだけの申し込みの名前は、行事を閉じると消えます。</p></> : null}
  </AdminPage>);
});

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

admin.get("/answers/:projectId/:answerId/edit", async (c) => {
  const { ward } = c.var;
  const projectId = c.req.param("projectId");
  const [project, answer] = await Promise.all([
    c.env.DB.prepare("SELECT title, closed_at FROM projects WHERE ward_id = ? AND project_id = ?")
      .bind(ward.wardId, projectId).first<{ title: string; closed_at: string | null }>(),
    getAnswer(c.env.DB, ward.wardId, projectId, c.req.param("answerId")),
  ]);
  if (!project || !answer) return c.notFound();
  const { labels } = await residentContext(c.env.DB, ward.wardId, projectId);
  const back = adminPath(ward.slug, `/answers/${encodeURIComponent(projectId)}`);
  const endpoint = `${back}/${encodeURIComponent(answer.answerId)}`;
  return c.html(<Layout title="答えを直す・消す" siteName={ward.name} noindex adminHomeHref={adminPath(ward.slug, "/")}>
    <p><a href={`${back}?view=list`}>答えの一覧へ戻る</a></p>
    <h1>{project.title} の答えを直す・消す</h1><p class="lead">直したいところを書き換えて保存してください。保存する前なら、一覧へ戻ると元のままです。「この答えを消す」を押すと、この一件を集計から外します。</p>
    {project.closed_at ? <p class="notice">この行事は閉じています。答えを直すときは<a href={adminPath(ward.slug, `/close/${encodeURIComponent(projectId)}`)}>「もう一度開く」の画面へ進んでください</a>。</p> : <>
      <form method="post" action={`${endpoint}/edit`} class="panel">
        <label for="edit-household">代表者のお名前</label><input id="edit-household" name="household" type="text" value={answer.household} required maxLength={120} />
        <label for="edit-district">班</label><input id="edit-district" name="district" type="text" value={answer.district} maxLength={80} />
        <div class="admin-answer-counts"><CountFields labels={labels} answer={answer} prefix="edit" /></div>
        <label for="edit-helper">手伝う人の名前（書かなくてかまいません）</label><input id="edit-helper" name="helper_name" type="text" value={answer.helperName ?? ""} maxLength={240} />
        <label for="edit-times">手伝える時間帯（書かなくてかまいません）</label><input id="edit-times" name="helper_times" type="text" value={answer.helperTimes ?? ""} maxLength={240} />
        <p><button type="submit">直した答えを保存する</button></p>
        <p><a href={`${back}?view=list`}>保存せずに戻る</a></p>
      </form>
      <form method="post" action={`${endpoint}/delete`}>
        <button type="submit" class="danger">この答えを消す</button> <p class="help-text">この一件を答えの一覧と集計から消します。消したあとに入れ直すときは、答えの画面の「電話や紙の答えを手で入れる」を使ってください。</p>
      </form>
    </>}
  </Layout>);
});

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
    return adminResult(c, "代表者のお名前、班、人数、手伝いの入力を確認してください。ブラウザの戻るボタンで書き直せます。", 400, { href: adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`), label: "答えの画面に戻る" }, "答えの画面で内容を確かめてください。閉じた行事の答えを直すときは、先に行事を開き直してください。");
  }
  const saved = await updateAnswer(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), c.req.param("answerId"),
    { household, district, ...counts!, helperName, helperTimes });
  if (!saved) return adminResult(c, "答えを保存できませんでした。答えの一覧に戻って確認してください。閉じた行事は、先に開き直してください。", 409, { href: adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`), label: "答えの画面に戻る" }, "答えの画面で内容を確かめてください。閉じた行事の答えを直すときは、先に行事を開き直してください。");
  return c.redirect(`${adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`)}?view=list&done=edit`, 303);
});

admin.post("/answers/:projectId/:answerId/delete", async (c) => {
  const deleted = await deleteAnswer(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), c.req.param("answerId"));
  if (!deleted) return adminResult(c, "答えを消せませんでした。答えの一覧に戻って確認してください。閉じた行事は、先に開き直してください。", 409, { href: adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`), label: "答えの画面に戻る" }, "答えの画面で内容を確かめてください。閉じた行事の答えを直すときは、先に行事を開き直してください。");
  return c.redirect(`${adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`)}?view=list&done=delete`, 303);
});

admin.post("/answers/:projectId/phone", async (c) => {
  const form = await c.req.parseBody();
  const household = typeof form.household === "string" ? form.household.trim() : "";
  const district = typeof form.district === "string" ? form.district.trim() : "";
  const counts = parseAnswerCounts(form);
  const peopleCount = counts?.peopleCount ?? -1;
  if (!household || !Number.isInteger(peopleCount) || peopleCount < 0 || peopleCount > 1000) return adminResult(c, "入力を確認してください。", 400, { href: adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`), label: "答えの画面に戻る" }, "答えの画面で内容を確かめてください。閉じた行事の答えを直すときは、先に行事を開き直してください。");
  await addAnswer(c.env.DB, c.var.ward.wardId, { projectId: c.req.param("projectId"), household, district, ...counts!, helperName: asString(form.helper_name), helperTimes: asString(form.helper_times), source: "phone", accountId: c.var.account.accountId });
  return c.redirect(`${adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`)}?done=hand`, 303);
});

admin.post("/answers/:projectId/sheet", async (c) => {
  const form = await c.req.formData();
  const file = form.get("part");
  if (!(file instanceof File)) return adminResult(c, "回答票を選んでください。", 400, { href: adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`), label: "答えの画面に戻る" }, "答えの画面で内容を確かめてください。閉じた行事の答えを直すときは、先に行事を開き直してください。");
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
  if (!household || !Number.isInteger(peopleCount) || peopleCount < 0 || peopleCount > 1000 || !Number.isInteger(rowIndex) || rowIndex < 0) return adminResult(c, "読み取りを確認してください。", 400, { href: adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`), label: "答えの画面に戻る" }, "答えの画面で内容を確かめてください。閉じた行事の答えを直すときは、先に行事を開き直してください。");
  const originalId = c.req.param("originalId");
  const link = await c.env.DB.prepare(`SELECT o.original_id, p.closed_at FROM originals o
    JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
    JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id
    WHERE o.ward_id = ? AND o.original_id = ? AND j.project_id = ? AND j.read_kind = 'answer_sheet'`)
    .bind(c.var.ward.wardId, originalId, c.req.param("projectId")).first<{ original_id: string; closed_at: string | null }>();
  if (!link) return c.notFound();
  if (link.closed_at) {
    return c.redirect(`${adminPath(c.var.ward.slug, `/close/${encodeURIComponent(c.req.param("projectId"))}`)}?error=answers_closed`, 303);
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
    return adminResult(c, error instanceof Error ? error.message : "締切を保存できませんでした。", 400, { href: adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`), label: "答えの画面に戻る" }, "答えの画面で内容を確かめてください。閉じた行事の答えを直すときは、先に行事を開き直してください。");
  }
  return c.redirect(`${adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`)}?done=deadline`, 303);
});

/** 住民が次の操作を選べる、入力の誤りと受付終了の画面。 */
function ResidentError({ wardName, message, next, href, label }: { wardName: string; message: string; next: string; href: string; label: string }) {
  return <Layout title={message} siteName={wardName}>
    <h1>{message}</h1><p>{next}</p><p><a class="button secondary" href={href}>{label}</a></p>
  </Layout>;
}

pub.get("/help/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const [opportunity] = await listHelpOpportunities(c.env.DB, c.var.ward.wardId, projectId);
  if (!opportunity) return c.html(<ResidentError wardName={c.var.ward.name} message="手伝いの受付は終わりました。" next="確認したいことは、班長か役員にお知らせください。" href={`/${c.var.ward.slug}/`} label="お知らせの一覧へ" />);
  const context = await residentContext(c.env.DB, c.var.ward.wardId, projectId);
  const choices = helpTimeChoices(opportunity.body);
  const newer = context.documents.find((document) => (document.kind === "notice" || document.kind === "announcement") && document.publishedAt > opportunity.publishedAt);
  return c.html(<Layout title={`${opportunity.title}を一回だけ手伝う`} siteName={c.var.ward.name}>
    <p><a href={`/${c.var.ward.slug}/`}>お知らせの一覧へ</a></p>
    <h1>{opportunity.title}で手伝える時間帯を教えてください</h1>
    <p class="lead">自治会に入っていなくても申し込めます。お名前と手伝える時間帯を教えてください。</p>
    {newer ? <p class="notice">この募集のあとに、新しいお知らせを載せました。<a href={`/${c.var.ward.slug}/p/${encodeURIComponent(projectId)}`}>新しいお知らせを読んでください</a>。</p> : null}
    <ArticleBody body={opportunity.body} />
    <form method="post" action={`/${c.var.ward.slug}/help/${encodeURIComponent(projectId)}`}>
      <label for="helper-name">お名前</label><input id="helper-name" name="helper_name" type="text" maxlength={120} required />
      <label for="helper-times">手伝える時間帯</label>
      {choices.length ? <select id="helper-times" name="helper_times" required><option value="">選んでください</option>{choices.map((time) => <option value={time}>{time}</option>)}</select>
        : <input id="helper-times" name="helper_times" type="text" maxlength={240} required />}
      <p>名前と時間帯は、この行事の準備に使い、行事が終わると消します。変更は区のページに載せます。</p>
      <button type="submit">申し込む</button>
    </form>
    <h2>分からないときは</h2><ResidentContact contact={context.contact} />
  </Layout>);
});

pub.post("/help/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const form = await c.req.parseBody();
  const name = asString(form.helper_name).trim();
  const times = asString(form.helper_times).trim();
  const href = `/${c.var.ward.slug}/help/${encodeURIComponent(projectId)}`;
  if (!name || !times || name.length > 120 || times.length > 240) return c.html(<ResidentError wardName={c.var.ward.name} message="お名前と手伝える時間帯を入れてください。" next="ブラウザの戻るボタンで戻り、書き直してください。" href={href} label="入力画面を開く" />, 400);
  const [opportunity] = await listHelpOpportunities(c.env.DB, c.var.ward.wardId, projectId);
  if (!opportunity) return c.html(<ResidentError wardName={c.var.ward.name} message="手伝いの受付は終わりました。" next="確認したいことは、班長か役員にお知らせください。" href={`/${c.var.ward.slug}/`} label="区のページへ" />, 400);
  const choices = helpTimeChoices(opportunity.body);
  if (choices.length && !choices.includes(times)) return c.html(<ResidentError wardName={c.var.ward.name} message="募集にある時間帯を選んでください。" next="ブラウザの戻るボタンで戻り、選び直してください。" href={href} label="入力画面を開く" />, 400);
  if (!await addHelpOffer(c.env.DB, c.var.ward.wardId, projectId, name, times)) return c.html(<ResidentError wardName={c.var.ward.name} message="手伝いの受付は終わりました。" next="確認したいことは、班長か役員にお知らせください。" href={`/${c.var.ward.slug}/`} label="区のページへ" />, 400);
  const context = await residentContext(c.env.DB, c.var.ward.wardId, projectId);
  return c.html(<Layout title="申し込みを受け付けました" siteName={c.var.ward.name}>
    <h1>申し込みを受け付けました</h1><p>ありがとうございました。この画面は閉じてかまいません。</p>
    <dl><dt>お名前</dt><dd>{name}</dd><dt>時間帯</dt><dd>{times}</dd></dl>
    <section class="notice"><h2>次は</h2><EventDetails item={context.item} /><p>手伝える時間帯: {times}</p><p>変更は区のページに載せます。</p></section>
    <p><a href={`/${c.var.ward.slug}/p/${encodeURIComponent(projectId)}`}>案内を読む</a></p>
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

function AnswerForm({ wardName, slug, projectId, title, squads, labels, selected = "", values = {}, error, choices = [] }: {
  wardName: string; slug: string; projectId: string; title: string; squads: string[]; labels: AnswerLabels;
  selected?: string; values?: Record<string, unknown>; error?: string; choices?: string[];
}) {
  const counts = parseAnswerCounts(values);
  const district = typeof values.district === "string" ? values.district : selected;
  return <Layout title="参加する人数を教えてください" siteName={wardName}>
    <p><a href={`/${slug}/p/${encodeURIComponent(projectId)}`}>{title}の案内へ</a></p>
    <h1>参加する人数を教えてください</h1><p class="lead">お名前と人数を書いて、送ってください。登録はいりません。</p>
    {error ? <Notice error>{error} 入れた人数は残っています。</Notice> : null}
    <form method="post" action={`/${slug}/answer/${encodeURIComponent(projectId)}${selected ? `?s=${encodeURIComponent(selected)}` : ""}`}>
      <label for="household">代表者のお名前</label><p class="muted">ふつうは世帯主の方のお名前です。ご家族のどなたが答えてもかまいません。例: 山田 太郎</p>
      <input id="household" name="household" type="text" maxlength={120} value={asString(values.household)} required />
      {selected ? <><p>班{selected}</p><details open={!!error}><summary>班が違うときは選び直す</summary><DistrictSelect districts={squads} selected={district} /></details></>
        : <><label for="district">班</label><DistrictSelect districts={squads} selected={district} /><p class="muted">分からないときは、そのまま送ってかまいません。役員が確かめます。</p></>}
      <CountFields labels={labels} answer={Object.keys(values).length ? counts ?? undefined : undefined} rawValues={values} />
      <details open={!!error && (!!values.helper_name || !!values.helper_times)}><summary>手伝える方はこちら（書かなくてかまいません）</summary>
        <label for="helper">手伝う方のお名前</label><input id="helper" name="helper_name" type="text" maxlength={120} value={asString(values.helper_name)} />
        <label for="times">手伝える時間帯</label>
        {choices.length ? <select id="times" name="helper_times"><option value="">選んでください</option>{choices.map((time) => <option value={time} selected={values.helper_times === time}>{time}</option>)}</select>
          : <input id="times" name="helper_times" type="text" maxlength={240} value={asString(values.helper_times)} />}
      </details>
      <p>紙の回答票を出した方は、ここで答えなくてかまいません。</p><button type="submit">この内容で送る</button>
    </form>
  </Layout>;
}

pub.get("/answer/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const project = await answerProject(c.env.DB, c.var.ward.wardId, projectId);
  if (!project) return c.notFound();
  const [squads, context] = await Promise.all([getSquads(c.env.DB, c.var.ward.wardId), residentContext(c.env.DB, c.var.ward.wardId, projectId)]);
  if (isAnswerClosed(project)) return c.html(<Layout title="答えの受付は終わりました" siteName={c.var.ward.name}><h1>{project.title}のご案内</h1><ReceptionClosed closed={!!project.closed_at} due={project.due_on} /><ResidentContact contact={context.contact} /><a href={`/${c.var.ward.slug}/p/${encodeURIComponent(projectId)}`}>案内を読む</a></Layout>);
  const selected = squads.includes(c.req.query("s") ?? "") ? c.req.query("s") : "";
  const recruitment = context.documents.find((document) => document.kind === "recruitment");
  return c.html(<AnswerForm wardName={c.var.ward.name} slug={c.var.ward.slug} projectId={projectId} title={project.title} squads={squads} labels={context.labels} selected={selected} choices={helpTimeChoices(recruitment?.body ?? "")} />);
});

pub.post("/answer/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const form = await c.req.parseBody();
  const project = await answerProject(c.env.DB, c.var.ward.wardId, projectId);
  if (!project) return c.notFound();
  const context = await residentContext(c.env.DB, c.var.ward.wardId, projectId);
  if (isAnswerClosed(project)) return c.html(<Layout title="答えの受付は終わりました" siteName={c.var.ward.name}><h1>答えの受付は終わりました</h1><ReceptionClosed closed={!!project.closed_at} due={project.due_on} /><ResidentContact contact={context.contact} /><a href={`/${c.var.ward.slug}/p/${encodeURIComponent(projectId)}`}>案内を読む</a></Layout>, 400);
  const household = asString(form.household).trim();
  const district = asString(form.district).trim();
  const counts = parseAnswerCounts(form);
  const helperName = asString(form.helper_name).trim();
  const helperTimes = asString(form.helper_times).trim();
  const squads = await getSquads(c.env.DB, c.var.ward.wardId);
  const error = !household ? "お名前が入っていません。お名前を入れて、もう一度送ってください。" : household.length > 120 || district.length > 80 || !counts || helperName.length > 120 || helperTimes.length > 240 ? "入力を確認してください。お名前と人数を書き直してください。" : district && squads.length && !squads.includes(district) ? "班を選び直してください。分からないときは「分からない」を選べます。" : "";
  if (error) return c.html(<AnswerForm wardName={c.var.ward.name} slug={c.var.ward.slug} projectId={projectId} title={project.title} squads={squads} labels={context.labels} selected={squads.includes(c.req.query("s") ?? "") ? c.req.query("s") : ""} values={form} error={error} choices={helpTimeChoices(context.documents.find((document) => document.kind === "recruitment")?.body ?? "")} />, 400);
  await addAnswer(c.env.DB, c.var.ward.wardId, { projectId, household, district, ...counts!, helperName, helperTimes, source: "web" });
  return c.html(<Layout title="答えを受け付けました" siteName={c.var.ward.name}>
    <h1>答えを受け付けました</h1><p>ありがとうございました。この画面は閉じてかまいません。</p>
    <dl><dt>代表者</dt><dd>{household}</dd><dt>班</dt><dd>{district || "班が分からない"}</dd><dt>人数</dt><dd>{countText(counts!, context.labels)}</dd></dl>
    {counts!.peopleCount > 0 ? <section class="notice"><h2>次は</h2><EventDetails item={context.item} /><p>変更は案内で確かめられます。</p></section> : null}
    <h2>間違えたときは</h2><p>もう一度送らず、下の連絡先にお知らせください。役員が直します。</p><ResidentContact contact={context.contact} />
    <p><a href={`/${c.var.ward.slug}/p/${encodeURIComponent(projectId)}`}>案内へ戻る</a></p>
  </Layout>);
});

function DistrictSelect({ districts, selected = "" }: { districts: string[]; selected?: string }) {
  return <select id="district" name="district"><option value="" selected={selected === ""}>分からない</option>{districts.map((district) => <option value={district} selected={selected === district}>{district}</option>)}</select>;
}

function RosterColumnPicker({ wardName, wardSlug, headers, rows }: { wardName: string; wardSlug: string; headers: string[]; rows: string[][] }) {
  return <Layout title="名簿の項目を選ぶ" siteName={wardName} noindex adminHomeHref={adminPath(wardSlug, "/")}><h1>代表者のお名前と班の項目を選んでください</h1><p class="lead">名簿の見出しに合わせて代表者のお名前と班の項目を選び、「名簿を入れる」を押してください。</p><p>先頭の行から項目を見つけられませんでした。</p><form method="post" action={adminPath(wardSlug, "/answers/roster")}>
    <input type="hidden" name="rows_json" value={JSON.stringify(rows)} />
    <label for="household-column">代表者のお名前</label><select id="household-column" name="household_column">{headers.map((header, index) => <option value={index}>{header || `${index + 1}番目`}</option>)}</select>
    <label for="district-column">班</label><select id="district-column" name="district_column">{headers.map((header, index) => <option value={index}>{header || `${index + 1}番目`}</option>)}</select>
    <button type="submit">名簿を入れる</button>
  </form></Layout>;
}

function renderSheetRows(body: string | null, projectId: string, originalId: string, wardSlug: string, closed: boolean, answers: AnswerRow[], labels: AnswerLabels) {
  if (!body) return <p>読み取り中です。時間をおいて開き直してください。</p>;
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
  if (reading.rows.length === 0) return <p>{reading.summary || "回答票から答えを見つけられませんでした。"}</p>;
  return <>
    <p>{reading.summary}</p>
    {reading.rows.map((row, index) => {
      const saved = answers.find((answer) => answer.originalId === originalId && answer.sheetRowIndex === index);
      const count = saved?.peopleCount ?? (row.adults ?? 0) + (row.children ?? 0) + (row.seniors ?? 0);
      const endpoint = adminPath(wardSlug, `/answers/${encodeURIComponent(projectId)}/sheet/${encodeURIComponent(originalId)}/row/${index}`);
      return <form class="panel" method="post" action={endpoint}>
        <h3>答え{index + 1}（{row.locator}）</h3>{saved ? <p class="notice done">入れました</p> : null}
        <label for={`sheet-household-${originalId}-${index}`}>代表者のお名前</label><input id={`sheet-household-${originalId}-${index}`} name="household" type="text" value={saved?.household ?? row.household_name} required maxlength={120} disabled={closed} />
        <label for={`sheet-district-${originalId}-${index}`}>班</label><input id={`sheet-district-${originalId}-${index}`} name="district" type="text" value={saved?.district ?? row.ward_group} maxlength={80} disabled={closed} />
        <div class="admin-answer-counts"><CountFields labels={labels} answer={saved ?? { peopleCount: count, childrenCount: row.children, adultsCount: row.adults, seniorsCount: row.seniors }} prefix={`sheet-${originalId}-${index}`} disabled={closed} /></div>
        <label for={`sheet-helper-${originalId}-${index}`}>手伝う人の名前</label><input id={`sheet-helper-${originalId}-${index}`} name="helper_name" type="text" value={saved?.helperName ?? row.helper_names.join("、")} maxlength={240} disabled={closed} />
        <label for={`sheet-times-${originalId}-${index}`}>手伝える時間帯</label><input id={`sheet-times-${originalId}-${index}`} name="helper_times" type="text" value={saved?.helperTimes ?? row.helper_slots.join("、")} maxlength={240} disabled={closed} />
        {!closed ? <><p>読み違いがあれば直して入れられます。</p>
        <button type="submit">{saved ? "直して入れ直す" : "この答えを入れる"}</button></> : null}
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
