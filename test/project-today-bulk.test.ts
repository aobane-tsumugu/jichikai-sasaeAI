import { env } from "cloudflare:workers";
import { html } from "hono/html";
import { expect, it } from "vitest";
import { seedAdmin, seedWard } from "../src/core/testing";
import { formatJstDate, shortDate } from "../src/core/time";
import { createProject, getProjectState, listProjects } from "../src/project/state";
import { daysRemaining, dateWords, openInquiries } from "../src/project/followup";
import { inquirySubject } from "../src/project/inquiry-send";
import { DEADLINE_LABEL, type DeadlineKind } from "../src/project/model";
import { get, postForm, realApp } from "./helpers";

const day = (offset: number) => new Date(Date.now() + 9 * 3600_000 + offset * 86400_000).toISOString().slice(0, 10);

async function addTask(db: D1Database, wardId: string, projectId: string, suffix: string, options: {
  end?: string | null; progress?: "open" | "started" | "done"; removed?: boolean; order?: number; created?: string;
} = {}) {
  const taskId = `${projectId}-${suffix}`;
  await db.prepare(`INSERT INTO project_map_tasks
    (ward_id, project_id, task_id, name, period_end, progress, removed_at, sort_order, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(wardId, projectId, taskId, `${suffix}（架空）`, options.end === undefined ? day(2) : options.end,
      options.progress ?? "open", options.removed ? "2026-01-01T00:00:00Z" : null,
      options.order ?? 100, options.created ?? "2026-01-01T00:00:00Z").run();
  return taskId;
}

async function addQuestion(db: D1Database, wardId: string, projectId: string, state: "open" | "later" | "answered" | "unknown") {
  const questionId = `${projectId}-${state}`;
  await db.prepare(`INSERT INTO project_questions
    (ward_id, project_id, question_id, kind, text, state, dedupe_key, created_at)
    VALUES (?, ?, ?, 'decide', '会場を教えてください（架空）', ?, ?, '2026-01-01T00:00:00Z')`)
    .bind(wardId, projectId, questionId, state, questionId).run();
}

/** 一括取得にする前の取得と描画を残した比較用。送った人の表示を加え、HTMLの順序、文、リンク、フォームをまとめて比べる。 */
async function legacyMain(db: D1Database, wardId: string, root: string): Promise<string> {
  const entries: Array<{ date: string | null; until?: boolean; taskId?: string; projectId: string; project: string; label: string; href: string }> = [];
  for (const project of await listProjects(db, wardId)) {
    for (const [kind, date] of Object.entries(project.deadlines)) {
      if (kind === "event_day" && date < day(0)) continue;
      entries.push({ date, projectId: project.projectId, project: project.title, label: DEADLINE_LABEL[kind as DeadlineKind],
        href: kind === "submit_due" && project.kind === "city_request" ? `/requests/city/${project.projectId}` : kind === "answer_due" ? `/answers/${project.projectId}` : `/projects/${project.projectId}/map` });
    }
    const state = await getProjectState(db, wardId, project.projectId);
    if (!state) throw new Error("比較する架空の準備がありません");
    for (const task of state.mapTasks.filter((t) => t.progress !== "done" && t.periodEnd && t.taskKey !== "day")) {
      entries.push({ date: task.periodEnd, until: true, taskId: task.taskId, projectId: project.projectId, project: project.title,
        label: task.name, href: `/projects/${project.projectId}/map/${task.taskId}` });
    }
    for (const question of state.questions.filter((q) => q.state === "open" || q.state === "later")) {
      entries.push({ date: null, projectId: project.projectId, project: project.title, label: "質問",
        href: `/projects/${project.projectId}/questions#question-${question.questionId}` });
    }
  }
  entries.sort((a, b) => (a.date ?? "9999-99-99").localeCompare(b.date ?? "9999-99-99") || a.project.localeCompare(b.project, "ja"));
  const inquiries = (await openInquiries(db, wardId)).filter(({ group }) => group[0]!.kind === "inquiry");
  const dated = entries.filter((entry) => entry.date);
  const late = dated.filter((entry) => entry.date! < day(0) && entry.taskId);
  const coming = dated.filter((entry) => !late.includes(entry));
  const questions = entries.filter((entry) => !entry.date);
  const row = (entry: (typeof entries)[number]) => html`<li><a class="row-link" href="${root}${entry.href}"><b>${entry.project}　${entry.label}</b><span>${`${entry.until ? `${shortDate(entry.date!)}まで` : formatJstDate(entry.date!)}　${daysRemaining(entry.date!)}`}</span></a>${entry.taskId ? html`<form method="post" action="${root}/projects/${entry.projectId}/map/${entry.taskId}/done"><input type="hidden" name="back" value="today"/><button class="quiet">済みにする</button></form>` : ""}</li>`;
  const inquirySection = inquiries.length ? html`<ul class="rows">${inquiries.slice(0, 3).map(({ group }) => html`<li><a class="row-link" href="${root}/inquiries/${encodeURIComponent(group[0]!.inquiry_id)}"><b>問い合わせ「${inquirySubject(group[0]!.subject)}」</b><span>送った人: 名前の分からない人</span><span>${(dateWords(group[0]!.subject).length ? `急ぎかもしれません（${dateWords(group[0]!.subject).map((word) => `「${word}」`).join("")}とあります）。` : "") || `${formatJstDate(group[0]!.received_at)}に届きました`}</span></a></li>`)}</ul>` : "";
  const lead = html`<p class="lead">締切の近い順に並べています。どれから始めてもかまいません。押すと、その仕事の画面が開きます。</p>`;
  const comingSection = coming.length ? html`<h2>これからの仕事</h2><ul class="rows">${coming.map(row)}</ul>` : "";
  const lateSection = late.length ? html`<h2>時期を過ぎた仕事</h2><p class="muted">終わっているものは「済みにする」を押してください。まだのものは、開くと時期を直せます。</p><ul class="rows">${late.map(row)}</ul>` : "";
  const questionSection = questions.length ? html`<p class="link-line"><a href="${root}${questions[0]!.href.split("#")[0]!}">AIからの質問（${questions.length}件）を見る</a></p><p class="muted">質問は、分かるものだけ答えてください。答えなくても進められます。</p>` : "";
  return String(await html`<main><a class="back" href="${root}/">← 最初の画面へ</a><h1>今やること</h1>${inquirySection}${lead}${comingSection}${lateSection}${questionSection}</main>`);
}

it("三つの準備の締切・やること・質問が、修正前と同じHTMLで同じ順に出る", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const first = await createProject(env.DB, ward.wardId, { kind: "event", title: "あの準備（架空）", year: 2025, eventDay: day(-1) });
  const second = await createProject(env.DB, ward.wardId, { kind: "city_request", title: "あの準備（架空）", year: 2026 });
  const third = await createProject(env.DB, ward.wardId, { kind: "event", title: "いの準備（架空）", year: 2026, eventDay: day(2) });
  for (const project of [first, second, third]) {
    // 型の仕事を外し、下で順序と除外条件を見分けられる仕事を入れる。
    await env.DB.prepare("UPDATE project_map_tasks SET removed_at = '2026-01-01T00:00:00Z' WHERE ward_id = ? AND project_id = ?")
      .bind(ward.wardId, project.projectId).run();
    await env.DB.prepare("INSERT INTO project_deadlines (ward_id, project_id, kind, due_on) VALUES (?, ?, 'answer_due', ?), (?, ?, 'submit_due', ?), (?, ?, 'board_meeting_day', ?)")
      .bind(ward.wardId, project.projectId, day(-1), ward.wardId, project.projectId, day(2), ward.wardId, project.projectId, day(2)).run();
    await addTask(env.DB, ward.wardId, project.projectId, "遅い順", { order: 102 });
    await addTask(env.DB, ward.wardId, project.projectId, "後の時刻", { order: 100, created: "2026-01-02T00:00:00Z" });
    await addTask(env.DB, ward.wardId, project.projectId, "先の時刻", { order: 100, progress: "started" });
    await addTask(env.DB, ward.wardId, project.projectId, "時期を過ぎた仕事", { end: day(-1) });
    await addTask(env.DB, ward.wardId, project.projectId, "済んだ仕事", { progress: "done" });
    await addTask(env.DB, ward.wardId, project.projectId, "外した仕事", { removed: true });
    await addTask(env.DB, ward.wardId, project.projectId, "時期のない仕事", { end: null });
    const dayTask = await addTask(env.DB, ward.wardId, project.projectId, "当日の仕事");
    await env.DB.prepare("UPDATE project_map_tasks SET task_key = 'day' WHERE ward_id = ? AND project_id = ? AND task_id = ?")
      .bind(ward.wardId, project.projectId, dayTask).run();
    for (const state of ["open", "later", "answered", "unknown"] as const) await addQuestion(env.DB, ward.wardId, project.projectId, state);
  }
  const closed = await createProject(env.DB, ward.wardId, { kind: "event", title: "終わった準備（架空）", year: 2026, eventDay: day(2) });
  await addTask(env.DB, ward.wardId, closed.projectId, "終わった準備の仕事");
  await addQuestion(env.DB, ward.wardId, closed.projectId, "open");
  await env.DB.prepare("UPDATE projects SET closed_at = '2026-01-01T00:00:00Z' WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, closed.projectId).run();
  const otherWard = await seedWard(env.DB);
  const other = await createProject(env.DB, otherWard.wardId, { kind: "event", title: "別の自治会の準備（架空）", year: 2026, eventDay: day(2) });
  await addTask(env.DB, otherWard.wardId, other.projectId, "別の自治会の仕事");
  await addQuestion(env.DB, otherWard.wardId, other.projectId, "open");
  await env.DB.prepare("INSERT INTO inquiry_records (ward_id, inquiry_id, kind, subject, answer, received_at, created_at) VALUES (?, ?, 'inquiry', '明日の会場について（架空）', '', ?, ?)")
    .bind(ward.wardId, `${ward.wardId}-inquiry`, new Date().toISOString(), new Date().toISOString()).run();

  const root = `/${ward.slug}/admin`;
  const expected = await legacyMain(env.DB, ward.wardId, root);
  const response = await get(realApp, `${root}/projects/today`, cookie);
  expect(response.status).toBe(200);
  const actual = (await response.text()).match(/<main>[\s\S]*?<\/main>/)?.[0];
  expect(actual).toBe(expected);
  expect(actual).toContain(`href="${root}/requests/city/${second.projectId}"`);
  expect(actual).toContain(`href="${root}/answers/${first.projectId}"`);
  expect(actual).toContain(`href="${root}/projects/${second.projectId}/questions">AIからの質問（6件）を見る`);
  expect(actual).not.toMatch(/済んだ仕事|外した仕事|時期のない仕事|当日の仕事|終わった準備|別の自治会/);
  // 同日の締切が先、同名の準備は一覧の順、仕事は並び番号・作成時刻の順を保つ。
  const labels = [...expected.matchAll(/<b>([^<]+)<\/b>/g)].map((match) => match[1]);
  expect(labels.filter((label) => label?.includes("あの準備"))).toEqual([
    "あの準備（架空）　返事の締切", "あの準備（架空）　返事の締切", "あの準備（架空）　終わる日",
    "あの準備（架空）　役員会の日", "あの準備（架空）　提出期限", "あの準備（架空）　先の時刻（架空）",
    "あの準備（架空）　後の時刻（架空）", "あの準備（架空）　遅い順（架空）",
    "あの準備（架空）　役員会の日", "あの準備（架空）　提出期限", "あの準備（架空）　先の時刻（架空）",
    "あの準備（架空）　後の時刻（架空）", "あの準備（架空）　遅い順（架空）",
    "あの準備（架空）　時期を過ぎた仕事（架空）", "あの準備（架空）　時期を過ぎた仕事（架空）",
  ]);
  const taskId = `${second.projectId}-先の時刻`;
  const done = await postForm(realApp, `${root}/projects/${second.projectId}/map/${taskId}/done`, { back: "today" }, cookie);
  expect(done.status).toBe(303);
  expect(done.headers.get("location")).toBe(`${root}/projects/today?notice=done`);
  const after = await get(realApp, `${root}/projects/today?notice=done`, cookie);
  const afterHtml = await after.text();
  expect(afterHtml).toContain("済みにしました。戻すときは、やることでその仕事を開きます。");
  expect(afterHtml).not.toContain(`action="${root}/projects/${second.projectId}/map/${taskId}/done"`);
});

it("準備が1件から50件に増えても、今やることのD1問い合わせの回数は増えない", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const statements: string[] = [];
  // 本物のD1へ渡すprepareだけを数える。batch内の文も数え、認証なども含めた応答全体を測る。
  const countedDb = new Proxy(env.DB, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => { statements.push(sql); return target.prepare(sql); };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const bindings: typeof env = Object.create(env, { DB: { value: countedDb, enumerable: true } });
  const root = `/${ward.slug}/admin`;
  const prepare = async (number: number) => {
    const project = await createProject(env.DB, ward.wardId, { kind: "event", title: `準備${number}（架空）`, year: 2026, eventDay: day(2) });
    await addTask(env.DB, ward.wardId, project.projectId, "確認する仕事");
    await addQuestion(env.DB, ward.wardId, project.projectId, "open");
  };
  await prepare(1);
  const first = await get(realApp, `${root}/projects/today`, cookie, bindings);
  expect(first.status).toBe(200);
  expect(await first.text()).toContain("AIからの質問（1件）を見る");
  const oneCount = statements.length;
  expect(oneCount).toBeGreaterThan(0);
  for (let number = 2; number <= 50; number++) await prepare(number);
  statements.length = 0;
  const fifty = await get(realApp, `${root}/projects/today`, cookie, bindings);
  expect(fifty.status).toBe(200);
  const body = await fifty.text();
  expect(body).toContain("AIからの質問（50件）を見る");
  expect(body).toContain("準備50（架空）　確認する仕事（架空）");
  expect(statements.length).toBe(oneCount);
  expect(statements.filter((sql) => /FROM project_map_tasks\b/.test(sql))).toHaveLength(1);
  expect(statements.filter((sql) => /FROM project_questions\b/.test(sql))).toHaveLength(1);
  expect(statements.some((sql) => /FROM project_item_values\b|FROM project_rows\b|FROM documents\b/.test(sql))).toBe(false);
});
