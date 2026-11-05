import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { Layout } from "../core/ui";
import type { AdminEnv, WardEnv } from "../env";
import type { AnswerSheetReading } from "../ai/schema";
import type { Reading } from "../ai/schema";
import type { Waitable } from "../intake/types";
import { receiveOriginal, getReadings } from "../intake/api";
import { SEND_SCRIPT } from "../intake/browser-script";
import { getSquads } from "../settings/store";
import { lookupPrintQr } from "../print/qr";
import {
  addAnswer,
  chooseRosterColumns,
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
    <Layout title="戻る" siteName={c.var.ward.name} noindex adminHomeHref={adminPath(c.var.ward.slug, "/")}>
      <h1>戻る</h1>
      <p><a href={`/${c.var.ward.slug}/`} aria-label="区のページ">区のページ</a></p>
      <p><a class="button" href={adminPath(c.var.ward.slug, "/answers/roster")}>名簿を入れる</a></p>
      <h2>回答を確認する</h2>
      {rows.results.length === 0 ? <p class="panel">プロジェクトはまだありません。</p> : (
        <ul>{rows.results.map((row) => <li><a href={adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(row.project_id)}`)}>{row.title}（{row.year}年）</a> <a href={adminPath(c.var.ward.slug, `/space/${encodeURIComponent(row.project_id)}`)}>空間の設定</a> <a href={`/${encodeURIComponent(c.var.ward.slug)}/answer/${encodeURIComponent(row.project_id)}`}>回答ページ</a></li>)}</ul>
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
      <h1>名簿</h1>
      <p>CSV または Excel の一覧を選んでください。先頭の行から世帯名と班を見つけます。見つからない時だけ項目を選びます。</p>
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
      {saved ? <p class="muted">前回使った項目位置: 世帯名 {saved.household + 1} 番目、班 {saved.district + 1} 番目</p> : null}
      {copies.length ? <div class="panel"><h2>班ごとの部数</h2><ul>{copies.map((row) => <li>{row.district}: {row.copies} 部</li>)}</ul></div> : null}
      {entries.length ? <div class="panel"><h2>世帯と班</h2><div style="overflow-x:auto"><table><thead><tr><th>世帯</th><th>班</th></tr></thead><tbody>{entries.map((entry) => <tr><td>{entry.household}</td><td>{entry.district}</td></tr>)}</tbody></table></div></div> : null}
    </Layout>,
  );
});

async function RosterPhotoResult({ wardSlug, wardId, db, jobId }: { wardSlug: string; wardId: string; db: D1Database; jobId: string }) {
  const readings = await getReadings(db, wardId, jobId);
  const reading = readings.find((row) => "tables" in row.body)?.body;
  if (!reading || !("tables" in reading)) return <p class="notice">読み取りが終わると、ここに名簿が表示されます。ページを開き直してください。</p>;
  const tables = reading.tables.filter((table) => table.rows.length > 0);
  return <section class="panel"><h2>読み取った名簿</h2>{tables.map((table, index) => <form method="post" action={adminPath(wardSlug, "/answers/roster/photo/import")}>
    <p>{table.name}（{table.rows.length} 行）</p><div style="overflow-x:auto"><table><tbody>{table.rows.slice(0, 12).map((row) => <tr>{row.cells.map((cell) => <td>{cell}</td>)}</tr>)}</tbody></table></div>
    <input type="hidden" name="jobId" value={jobId} /><input type="hidden" name="tableIndex" value={index} /><button type="submit">この名簿を使う</button>
  </form>)}</section>;
}

admin.post("/answers/roster/photo", async (c) => {
  const form = await c.req.formData();
  const photo = form.get("photo");
  if (!(photo instanceof File)) return c.text("名簿の写真を選んでください。", 400);
  const outcome = await receiveOriginal(c.env, waitableContext(c), {
    wardId: c.var.ward.wardId, via: "system", readKind: "general",
    parts: [{ kind: "photo", filename: photo.name || "名簿の写真", mediaType: photo.type, bytes: new Uint8Array(await photo.arrayBuffer()) }],
  });
  if (!outcome.jobId) return c.redirect(adminPath(c.var.ward.slug, "/answers/roster"), 303);
  return c.redirect(`${adminPath(c.var.ward.slug, "/answers/roster")}?job=${encodeURIComponent(outcome.jobId)}`, 303);
});

admin.post("/answers/roster/photo/import", async (c) => {
  const form = await c.req.formData();
  const jobId = String(form.get("jobId") ?? "");
  const index = Number(form.get("tableIndex"));
  const readings = await getReadings(c.env.DB, c.var.ward.wardId, jobId);
  const reading = readings.find((row) => "tables" in row.body)?.body;
  if (!reading || !("tables" in reading) || !Number.isInteger(index) || !reading.tables[index]) return c.text("読み取った名簿を確認できません。", 400);
  const table = reading.tables[index];
  const districts = await getDistricts(c.env.DB, c.var.ward.wardId);
  let householdColumn = table.columns.findIndex((column) => /世帯|氏名|名前/.test(column));
  let districtColumn = table.columns.findIndex((column) => /班|組/.test(column));
  if (householdColumn < 0 || districtColumn < 0) {
    const second = table.rows.length > 0 ? table.rows[0]?.cells.findIndex((cell, cellIndex) => cellIndex > 0 && districts.includes(cell.trim())) ?? -1 : -1;
    if (second >= 0) { householdColumn = 0; districtColumn = second; }
  }
  if (householdColumn < 0 || districtColumn < 0 || householdColumn === districtColumn) return c.text("世帯名と班の列を読み取れませんでした。名簿ファイルから読み込んでください。", 400);
  const rows = [table.columns, ...table.rows.map((row) => row.cells)];
  const entries = rowsToRoster(rows, { household: householdColumn, district: districtColumn });
  await replaceRoster(c.env.DB, c.var.ward.wardId, entries, { household: householdColumn, district: districtColumn });
  return c.redirect(adminPath(c.var.ward.slug, "/answers/roster"), 303);
});

admin.post("/answers/roster", async (c) => {
  const form = await c.req.formData();
  const rowsRaw = form.get("rows_json");
  if (typeof rowsRaw === "string") {
    const rows = JSON.parse(rowsRaw) as string[][];
    const household = Number(form.get("household_column"));
    const district = Number(form.get("district_column"));
    const columns = { household, district };
    const entries = rowsToRoster(rows, columns);
    await replaceRoster(c.env.DB, c.var.ward.wardId, entries, columns);
    return c.redirect(adminPath(c.var.ward.slug, "/answers/roster"), 303);
  }
  const data = form.get("part");
  const extracted = form.get("part_extracted");
  if (!(data instanceof File)) return c.text("名簿ファイルを選んでください。", 400);
  let rows: string[][];
  if (/\.csv$/i.test(data.name)) {
    rows = parseCsv(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await data.arrayBuffer()));
  } else {
    if (typeof extracted !== "string" || !extracted) return c.text("Excel ファイルを読み取れませんでした。", 400);
    const workbook = JSON.parse(extracted) as { tables?: Array<{ rows?: unknown }> };
    const first = workbook.tables?.[0]?.rows;
    if (!Array.isArray(first) || !first.every((row) => Array.isArray(row) && row.every((cell) => typeof cell === "string"))) {
      return c.text("先頭のシートに表がありません。", 400);
    }
    rows = first as string[][];
  }
  const detected = chooseRosterColumns(rows[0] ?? []);
  const rawColumns = form.get("columns");
  let columns: RosterColumns | null = detected ?? (await getSavedRosterColumns(c.env.DB, c.var.ward.wardId));
  if (!columns && typeof rawColumns === "string") {
    try {
      columns = JSON.parse(rawColumns) as RosterColumns;
    } catch {
      columns = null;
    }
  }
  if (!columns) return c.html(<RosterColumnPicker wardSlug={c.var.ward.slug} headers={rows[0] ?? []} rows={rows} />);
  const entries = rowsToRoster(rows, columns);
  await replaceRoster(c.env.DB, c.var.ward.wardId, entries, columns);
  return c.redirect(adminPath(c.var.ward.slug, "/answers/roster"), 303);
});

admin.get("/answers/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const project = await c.env.DB.prepare("SELECT project_id, title FROM projects WHERE ward_id = ? AND project_id = ?")
    .bind(c.var.ward.wardId, projectId).first<{ project_id: string; title: string }>();
  if (!project) return c.notFound();
  const [answers, unanswered, helpers, deadline, districts, totals] = await Promise.all([
    listAnswers(c.env.DB, c.var.ward.wardId, projectId),
    listUnansweredByDistrict(c.env.DB, c.var.ward.wardId, projectId),
    listHelperRequests(c.env.DB, c.var.ward.wardId, projectId),
    getAnswerDeadline(c.env.DB, c.var.ward.wardId, projectId),
    getDistricts(c.env.DB, c.var.ward.wardId),
    getAnswerTotals(c.env.DB, c.var.ward.wardId, projectId),
  ]);
  const sheets = await c.env.DB.prepare(
    `SELECT o.original_id, o.filename, o.job_id, r.body, j.status
     FROM jobs j JOIN originals o ON o.ward_id = j.ward_id AND o.job_id = j.job_id
     LEFT JOIN readings r ON r.ward_id = j.ward_id AND r.job_id = j.job_id
     WHERE j.ward_id = ? AND j.project_id = ? AND j.read_kind = 'answer_sheet' AND j.withdrawn_at IS NULL
     ORDER BY j.created_at DESC`,
  ).bind(c.var.ward.wardId, projectId).all<{ original_id: string; filename: string; job_id: string; body: string | null; status: string }>();
  return c.html(
    <Layout title={`戻る - ${project.title}`} siteName={c.var.ward.name} noindex adminHomeHref={adminPath(c.var.ward.slug, "/")}>
      <p><a href={adminPath(c.var.ward.slug, "/answers")}>戻る一覧</a></p>
      <h1>{project.title} の回答</h1>
      <p class="panel">参加人数: {totals.people} 人。手伝いの希望: {totals.helperRequests} 件。</p>
      <h2>電話の代理入力</h2>
      <form method="post" action={adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(projectId)}/phone`)} class="panel">
        <label for="household">世帯名</label><input id="household" name="household" type="text" required maxLength={120} />
        <label for="district">班</label><DistrictSelect districts={districts} />
        <label for="people">参加人数</label><input id="people" name="people_count" type="number" min="0" max="1000" required />
        <label for="helper">手伝う人の名前（任意）</label><input id="helper" name="helper_name" type="text" maxLength={120} />
        <label for="times">手伝える時間帯（任意）</label><input id="times" name="helper_times" type="text" maxLength={240} />
        <button type="submit">回答を入れる</button>
      </form>
      <h2>回答票を読み取る</h2>
      <form id="send-form" method="post" action={adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(projectId)}/sheet`)} enctype="multipart/form-data">
        <label for="cam">回答票の写真</label><input id="cam" name="part" type="file" accept={["image/*", ".pdf"].join(",")} capture="environment" />
        <label for="files">またはファイル</label><input id="files" name="part" type="file" accept={["image/*", ".pdf"].join(",")} />
        <input type="hidden" name="text" value="" /><input type="hidden" name="project_id" value={projectId} />
        <p id="send-status" class="notice" role="status"></p><button id="send-button" type="submit">回答票を送る</button>
      </form>
      <script dangerouslySetInnerHTML={{ __html: SEND_SCRIPT }} />
      <h2>回答の一覧</h2>
      {answers.length === 0 ? <p class="panel">回答はまだありません。</p> : <div class="panel" style="overflow-x:auto"><table><thead><tr><th>世帯</th><th>班</th><th>人数</th><th>手伝い</th><th>受け方</th></tr></thead><tbody>{answers.map((a) => <tr><td>{a.household}</td><td>{a.district}</td><td>{a.peopleCount}</td><td>{a.helperName ? `${a.helperName} / ${a.helperTimes}` : ""}</td><td>{a.source === "web" ? "Web" : a.source === "phone" ? "電話" : a.source === "line" ? "LINE" : "回答票"}</td></tr>)}</tbody></table></div>}
      <h2>未回答（班ごと）</h2>
      {unanswered.length === 0 ? <p>名簿はまだありません。</p> : unanswered.map((group) => <section class="panel"><h3>{group.district}</h3>{group.households.length === 0 ? <p>未回答の世帯はありません。</p> : <ul>{group.households.map((name) => <li>{name}</li>)}</ul>}</section>)}
      <h2>催促の一覧（印刷）</h2><p>紙で班長に渡してください。</p><button type="button" onclick="window.print()">印刷する</button>
      <h2>締切</h2><p>現在の締切: {deadline ?? "未設定"}</p><form method="post" action={adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(projectId)}/deadline`)}><label for="due">締切日（延長する場合は新しい日）</label><input id="due" name="due_on" type="date" value={deadline ?? ""} required /><button type="submit">締切を保存</button></form>
      <h2>手伝いの一覧</h2>
      {helpers.length === 0 ? <p>手伝いの希望はまだありません。</p> : <div class="panel" style="overflow-x:auto"><table><thead><tr><th>名前</th><th>時間帯</th><th>世帯</th><th>班</th></tr></thead><tbody>{helpers.map((helper) => <tr><td>{helper.name}</td><td>{helper.times}</td><td>{helper.household}</td><td>{helper.district}</td></tr>)}</tbody></table></div>}
      <h2>回答票の読み取り</h2>
      {sheets.results.map((sheet) => <section class="panel"><h3>{sheet.filename}</h3><p><a href={adminPath(c.var.ward.slug, `/intake/originals/${encodeURIComponent(sheet.original_id)}`)}>回答票の原本を開く</a></p>{renderSheetRows(sheet.body, projectId, sheet.original_id, c.var.ward.slug)}</section>)}
    </Layout>,
  );
});

admin.post("/answers/:projectId/phone", async (c) => {
  const form = await c.req.parseBody();
  const household = typeof form.household === "string" ? form.household.trim() : "";
  const district = typeof form.district === "string" ? form.district.trim() : "";
  const peopleCount = Number(form.people_count);
  if (!household || !district || !Number.isInteger(peopleCount) || peopleCount < 0 || peopleCount > 1000) return c.text("入力を確認してください。", 400);
  await addAnswer(c.env.DB, c.var.ward.wardId, { projectId: c.req.param("projectId"), household, district, peopleCount, helperName: asString(form.helper_name), helperTimes: asString(form.helper_times), source: "phone", accountId: c.var.account.accountId });
  return c.redirect(adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`), 303);
});

admin.post("/answers/:projectId/sheet", async (c) => {
  const form = await c.req.formData();
  const file = form.get("part");
  if (!(file instanceof File)) return c.text("回答票を選んでください。", 400);
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
  return c.redirect(adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(projectId)}`), 303);
});

admin.post("/answers/:projectId/sheet/:originalId/row/:rowIndex", async (c) => {
  const form = await c.req.parseBody();
  const household = asString(form.household).trim();
  const district = asString(form.district).trim();
  const helperName = asString(form.helper_name).trim();
  const helperTimes = asString(form.helper_times).trim();
  const peopleCount = Number(form.people_count);
  const rowIndex = Number(c.req.param("rowIndex"));
  if (!household || !district || !Number.isInteger(peopleCount) || peopleCount < 0 || peopleCount > 1000 || !Number.isInteger(rowIndex) || rowIndex < 0) return c.text("読み取りを確認してください。", 400);
  const originalId = c.req.param("originalId");
  const link = await c.env.DB.prepare("SELECT o.original_id FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id WHERE o.ward_id = ? AND o.original_id = ? AND j.project_id = ? AND j.read_kind = 'answer_sheet'")
    .bind(c.var.ward.wardId, originalId, c.req.param("projectId")).first();
  if (!link) return c.notFound();
  await addAnswer(c.env.DB, c.var.ward.wardId, {
    projectId: c.req.param("projectId"), household, district, peopleCount, helperName, helperTimes,
    source: "sheet", originalId, sheetRowIndex: rowIndex, accountId: c.var.account.accountId,
  });
  return c.redirect(adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`), 303);
});

admin.post("/answers/:projectId/deadline", async (c) => {
  const form = await c.req.parseBody();
  try {
    await setAnswerDeadline(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), asString(form.due_on), c.var.account.accountId);
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "締切を保存できませんでした。", 400);
  }
  return c.redirect(adminPath(c.var.ward.slug, `/answers/${encodeURIComponent(c.req.param("projectId"))}`), 303);
});

pub.get("/answer/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const project = await c.env.DB.prepare(
    `SELECT p.project_id, p.title, p.closed_at, d.due_on FROM projects p
     LEFT JOIN project_deadlines d ON d.ward_id = p.ward_id AND d.project_id = p.project_id AND d.kind = 'answer_due'
     WHERE p.ward_id = ? AND p.project_id = ?`,
  ).bind(c.var.ward.wardId, projectId).first<{ project_id: string; title: string; closed_at: string | null; due_on: string | null }>();
  if (!project) return c.notFound();
  const squads = await getSquads(c.env.DB, c.var.ward.wardId);
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
  const closed = project.closed_at !== null || (project.due_on !== null && project.due_on < today);
  return c.html(
    <Layout title={`回答 - ${project.title}`} siteName={c.var.ward.name}>
      <h1>{project.title} の回答</h1>
      {closed ? <p class="notice">回答の受付は終わりました。</p> : <form method="post" action={`/${encodeURIComponent(c.var.ward.slug)}/answer/${encodeURIComponent(projectId)}`}>
        <label for="household">世帯名</label><input id="household" name="household" type="text" maxLength={120} required />
        <label for="district">班</label>{squads.length ? <select id="district" name="district" required><option value="">選んでください</option>{squads.map((squad) => <option value={squad}>{squad}</option>)}</select> : <input id="district" name="district" type="text" maxLength={80} required />}
        <label for="people">参加人数</label><input id="people" name="people_count" type="number" min="0" max="1000" required />
        <h2>手伝いの希望（任意）</h2>
        <label for="helper">手伝う人の名前</label><input id="helper" name="helper_name" type="text" maxLength={120} />
        <label for="times">手伝える時間帯</label><input id="times" name="helper_times" type="text" maxLength={240} />
        <button type="submit">回答を送る</button>
      </form>}
    </Layout>,
  );
});

pub.post("/answer/:projectId", async (c) => {
  const form = await c.req.parseBody();
  const household = asString(form.household).trim();
  const district = asString(form.district).trim();
  const peopleCount = Number(form.people_count);
  const helperName = asString(form.helper_name).trim();
  const helperTimes = asString(form.helper_times).trim();
  if (!household || !district || !Number.isInteger(peopleCount) || peopleCount < 0 || peopleCount > 1000 || helperName.length > 120 || helperTimes.length > 240) return c.text("入力を確認してください。", 400);
  const projectId = c.req.param("projectId");
  const project = await c.env.DB.prepare(
    `SELECT p.closed_at, d.due_on FROM projects p LEFT JOIN project_deadlines d
     ON d.ward_id = p.ward_id AND d.project_id = p.project_id AND d.kind = 'answer_due'
     WHERE p.ward_id = ? AND p.project_id = ?`,
  ).bind(c.var.ward.wardId, projectId).first<{ closed_at: string | null; due_on: string | null }>();
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
  if (!project || project.closed_at || (project.due_on !== null && project.due_on < today)) return c.text("回答の受付は終わりました。", 400);
  const squads = await getSquads(c.env.DB, c.var.ward.wardId);
  if (squads.length > 0 && !squads.includes(district)) return c.text("班を選び直してください。", 400);
  await addAnswer(c.env.DB, c.var.ward.wardId, { projectId, household, district, peopleCount, helperName, helperTimes, source: "web" });
  return c.html(<Layout title="回答を受け付けました" siteName={c.var.ward.name}><h1>回答を受け付けました</h1><p>ありがとうございました。</p></Layout>);
});

function DistrictSelect({ districts }: { districts: string[] }) {
  return districts.length ? <select id="district" name="district" required><option value="">選んでください</option>{districts.map((district) => <option value={district}>{district}</option>)}</select> : <input id="district" name="district" type="text" required />;
}

function RosterColumnPicker({ wardSlug, headers, rows }: { wardSlug: string; headers: string[]; rows: string[][] }) {
  return <Layout title="名簿の項目を選ぶ"><h1>世帯名と班の項目を選んでください</h1><p>先頭の行から項目を見つけられませんでした。</p><form method="post" action={adminPath(wardSlug, "/answers/roster")}>
    <input type="hidden" name="rows_json" value={JSON.stringify(rows)} />
    <label for="household-column">世帯名</label><select id="household-column" name="household_column">{headers.map((header, index) => <option value={index}>{header || `${index + 1} 番目`}</option>)}</select>
    <label for="district-column">班</label><select id="district-column" name="district_column">{headers.map((header, index) => <option value={index}>{header || `${index + 1} 番目`}</option>)}</select>
    <button type="submit">名簿を入れる</button>
  </form></Layout>;
}

function renderSheetRows(body: string | null, projectId: string, originalId: string, wardSlug: string) {
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
  if (reading.rows.length === 0) return <p>{reading.summary || "回答票から回答を見つけられませんでした。"}</p>;
  return <>
    <p>{reading.summary}</p>
    {reading.rows.map((row, index) => {
      const count = (row.adults ?? 0) + (row.children ?? 0);
      const endpoint = adminPath(wardSlug, `/answers/${encodeURIComponent(projectId)}/sheet/${encodeURIComponent(originalId)}/row/${index}`);
      return <form class="panel" method="post" action={endpoint}>
        <h4>回答 {index + 1}（{row.locator}）</h4>
        <label for={`sheet-household-${originalId}-${index}`}>世帯名</label><input id={`sheet-household-${originalId}-${index}`} name="household" type="text" value={row.household_name} required maxlength={120} />
        <label for={`sheet-district-${originalId}-${index}`}>班</label><input id={`sheet-district-${originalId}-${index}`} name="district" type="text" value={row.ward_group} required maxlength={80} />
        <label for={`sheet-people-${originalId}-${index}`}>参加人数</label><input id={`sheet-people-${originalId}-${index}`} name="people_count" type="number" value={count} min="0" max="1000" required />
        <label for={`sheet-helper-${originalId}-${index}`}>手伝う人の名前</label><input id={`sheet-helper-${originalId}-${index}`} name="helper_name" type="text" value={row.helper_names.join("、")} maxlength={240} />
        <label for={`sheet-times-${originalId}-${index}`}>手伝える時間帯</label><input id={`sheet-times-${originalId}-${index}`} name="helper_times" type="text" value={row.helper_slots.join("、")} maxlength={240} />
        <p>読み取った内容を確認し、必要なら直してから回答に入れてください。</p>
        <button type="submit">回答に入れる</button>
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
