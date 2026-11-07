// 区の一年の地図。一般の自治会の一年を仮に置き、行事と届いた資料でこの区の内容に変えていく。
import { adminPath } from "../core/auth";
import { newId } from "../core/ids";
import { eventPeriodText, seasonText } from "../core/time";
import type { WardInfo } from "../env";
import type { ProjectState, ProjectSummary } from "../project/types";
import { Hono } from "hono";
import { AdminPage } from "../core/admin-ui";
import { cleanName } from "../core/password";
import { Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { createProject, getProjectState, listOpenProjects } from "../project/api";
import { getKnowItem, KNOW_LIMITS, saveKnowItem } from "./store";
import { WEEKDAYS } from "../rota/schedule";

export interface YearBase { key: string; title: string; kind: string; from: number; to: number; recurrence?: string; knowKey?: string }

/** 05_JOBS の仕事を月に置いた一般の例。区に合わないものは外せる。 */
export const YEAR_BASE: readonly YearBase[] = [
  { key: "general-meeting", title: "定期総会", kind: "general_meeting", from: 4, to: 4 },
  { key: "dues", title: "会費の集金", kind: "", from: 4, to: 5 },
  { key: "spring-clean", title: "春の清掃", kind: "", from: 5, to: 5 },
  { key: "drill", title: "防災訓練", kind: "", from: 9, to: 9 },
  { key: "summer", title: "夏の行事", kind: "event", from: 7, to: 8 },
  { key: "elders", title: "敬老の行事", kind: "", from: 9, to: 9 },
  { key: "autumn", title: "秋の行事", kind: "event", from: 10, to: 11 },
  { key: "autumn-clean", title: "秋の清掃", kind: "", from: 11, to: 11 },
  { key: "year-end", title: "年末の役員会", kind: "board_meeting", from: 12, to: 12 },
  { key: "new-year", title: "新年の集まり", kind: "", from: 1, to: 1 },
  { key: "officers", title: "役員を決める", kind: "", from: 2, to: 2 },
  { key: "settlement", title: "決算と総会の準備", kind: "", from: 3, to: 3 },
  { key: "garbage-duty", title: "ごみ当番", kind: "duty", from: 4, to: 3, recurrence: "毎週月曜", knowKey: "duties" },
  { key: "bulletin-delivery", title: "市報や回覧の配布", kind: "", from: 4, to: 3, recurrence: "毎月", knowKey: "delivery" },
  { key: "hall-care", title: "集会所の管理", kind: "", from: 4, to: 3, recurrence: "随時", knowKey: "safety" },
];

export type YearState = "example" | "fact" | "checking";

export interface YearRow { key: string; title: string; note: string; state: YearState; from: number; to: number; href: string; order: number; level?: Level; eventFrom?: number; eventTo?: number }

/**
 * 活動の量の段。割合は出せないので、その行に入っている資料と答えの数を足した数で分ける。
 * 済んだ仕事は数えない。仕事の数は種類の型で違い、済みは押したかどうかで変わるので、動いた量を表さない。
 * 境目は使いながら直す。
 */
export const ACTIVITY_STEPS = [1, 5, 15, 40] as const;
type Level = 1 | 2 | 3 | 4 | 5;
const levelOf = (count: number): Level => (ACTIVITY_STEPS.filter((step) => count >= step).length + 1) as Level;
const activityNote = (materials: number, answers: number) => materials || answers ? `${[materials ? `資料${materials}件` : "", answers ? `出欠の返事${answers}件` : ""].filter(Boolean).join("と")}が入っています。` : "";
/** 凡例の段の言葉。境目から作るので、境目を直せば凡例も変わる。 */
const levelLabels = (): string[] => ACTIVITY_STEPS.map((step, index) => index === 0 ? `${step - 1}件` : step - 1 === ACTIVITY_STEPS[index - 1] ? `${step - 1}件` : `${ACTIVITY_STEPS[index - 1]}〜${step - 1}件`).concat(`${ACTIVITY_STEPS[ACTIVITY_STEPS.length - 1]}件から`);

/** 4月を左端にした、一年の中の位置（%）。 */
const position = (month: number, day = 1) => (((month + 8) % 12) + (Math.min(day, 30) - 1) / 30) / 12 * 100;
const monthOf = (date: string) => Number(date.slice(5, 7));
const dayOf = (date: string) => Number(date.slice(8, 10));
const inRange = (month: number, base: YearBase) => {
  const shift = (value: number) => (value + 8) % 12;
  return Math.abs(shift(month) - shift(base.from)) <= 1 || Math.abs(shift(month) - shift(base.to)) <= 1;
};

interface RecordRow { project_id: string; title: string; kind: string; year: number; event_day: string | null; event_end: string | null }
interface YearItem { item_id: string; title: string; month: number | null; date_text: string; recurrence_text: string; added: number; removed_at: string | null; source_original_id: string | null }

export async function wardYear(db: D1Database, ward: WardInfo, projects: readonly ProjectSummary[], states: readonly (ProjectState | null)[], today: string) {
  const [materialCounts, answerCounts] = await Promise.all([
    db.prepare(`SELECT j.project_id, COUNT(*) AS n FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
      WHERE o.ward_id = ? AND j.project_id IS NOT NULL AND o.withdrawn_at IS NULL AND j.withdrawn_at IS NULL GROUP BY j.project_id`).bind(ward.wardId).all<{ project_id: string; n: number }>(),
    db.prepare("SELECT project_id, COUNT(*) AS n FROM project_answers WHERE ward_id = ? GROUP BY project_id").bind(ward.wardId).all<{ project_id: string; n: number }>(),
  ]);
  const materialsOf = (id: string) => materialCounts.results.find((row) => row.project_id === id)?.n ?? 0;
  const answersOf = (id: string) => answerCounts.results.find((row) => row.project_id === id)?.n ?? 0;
  const [overrides, records, schedules] = await Promise.all([
    db.prepare("SELECT item_id, title, month, date_text, recurrence_text, added, removed_at, source_original_id FROM ward_year_items WHERE ward_id = ?").bind(ward.wardId)
      .all<YearItem>(),
    db.prepare(`SELECT p.project_id, p.title, p.kind, p.year, (SELECT d.due_on FROM project_deadlines d WHERE d.ward_id = p.ward_id AND d.project_id = p.project_id AND d.kind = 'event_day') AS event_day,
      (SELECT d.due_on FROM project_deadlines d WHERE d.ward_id = p.ward_id AND d.project_id = p.project_id AND d.kind = 'event_end') AS event_end
      FROM projects p WHERE p.ward_id = ? AND p.closed_at IS NOT NULL ORDER BY p.closed_at DESC LIMIT 12`).bind(ward.wardId).all<RecordRow>(),
    db.prepare("SELECT project_id, weekday FROM rota_schedules WHERE ward_id = ?").bind(ward.wardId).all<{ project_id: string; weekday: number }>(),
  ]);
  const removed = new Set(overrides.results.filter((row) => row.removed_at).map((row) => row.item_id));
  const used = new Set<string>();
  const similar = (a: string, b: string) => Array.from({ length: Math.max(a.length - 1, 0) }, (_, index) => a.slice(index, index + 2)).some((part) => b.includes(part));
  const rows: YearRow[] = [];
  // 名前の似た仮の行を先に置き換える。無ければ同じ種類の行。どちらも無ければ足すだけにする。
  const claim = (kind: string, month: number, title: string) => {
    const open = YEAR_BASE.filter((entry) => !used.has(entry.key) && (entry.recurrence || inRange(month, entry)));
    const base = open.find((entry) => similar(entry.title, title)) ?? (kind ? open.find((entry) => entry.kind === kind) : undefined);
    if (base) used.add(base.key);
  };
  projects.forEach((project, index) => {
    const day = project.deadlines.event_day ?? project.deadlines.submit_due;
    const endDay = project.deadlines.event_end ?? day;
    const state = states[index];
    const schedule = schedules.results.find((row) => row.project_id === project.projectId);
    const recurring = overrides.results.find((row) => row.recurrence_text && !row.removed_at && row.title === project.title);
    if (schedule || recurring) {
      claim(project.kind, 4, project.title);
      rows.push({ key: project.projectId, title: project.title, note: `${schedule ? `毎週${WEEKDAYS[schedule.weekday]}曜` : recurring!.recurrence_text}。${activityNote(materialsOf(project.projectId), answersOf(project.projectId))}`,
        state: "fact", level: levelOf(materialsOf(project.projectId) + answersOf(project.projectId)), from: 0, to: 100, eventFrom: 0, eventTo: 100,
        href: adminPath(ward, `/projects/${project.projectId}/${project.kind === "duty" ? "draft/duty_roster" : "map"}`), order: 0 });
      return;
    }
    if (!day) {
      // 同じ種類の行があれば重ね、無ければ今の時期に置く。進めている行事は必ず地図に出す。
      const base = YEAR_BASE.find((entry) => !used.has(entry.key) && similar(entry.title, project.title)) ?? YEAR_BASE.find((entry) => !used.has(entry.key) && entry.kind === project.kind);
      if (base) used.add(base.key);
      const from = base ? position(base.from) : position(monthOf(today), dayOf(today));
      const taskless = state && !state.mapTasks.length;
      rows.push({ key: project.projectId, title: project.title, note: taskless ? "仕事はまだありません。やることから足せます" : "日はまだ決まっていません", state: "fact", level: levelOf(materialsOf(project.projectId) + answersOf(project.projectId)), from, to: base ? position(base.to, 30) + 1 : from + 4, href: adminPath(ward, `/projects/${project.projectId}/map`), order: from });
      return;
    }
    const month = monthOf(day);
    const firstTask = state?.mapTasks.map((task) => task.periodStart).filter((value): value is string => Boolean(value)).sort()[0];
    claim(project.kind, month, project.title);
    const start = firstTask && firstTask < day ? position(monthOf(firstTask), dayOf(firstTask)) : position(month, dayOf(day));
    const eventFrom = position(month, dayOf(day));
    const eventTo = position(monthOf(endDay!), dayOf(endDay!)) + 100 / 360;
    rows.push({ key: project.projectId, title: project.title,
      note: `${eventPeriodText(day, endDay)}。${firstTask && firstTask < day ? `準備は${seasonText(firstTask)}からです。` : ""}${activityNote(materialsOf(project.projectId), answersOf(project.projectId))}`,
      state: "fact", level: levelOf(materialsOf(project.projectId) + answersOf(project.projectId)), from: start, to: eventTo, eventFrom, eventTo,
      href: adminPath(ward, `/projects/${project.projectId}/map`), order: eventFrom });
  });
  for (const record of records.results) {
    if (!record.event_day || rows.some((row) => row.title === record.title)) continue;
    const month = monthOf(record.event_day);
    claim(record.kind, month, record.title);
    const at = position(month, dayOf(record.event_day));
    rows.push({ key: record.project_id, title: record.title, note: `${record.year}年${eventPeriodText(record.event_day, record.event_end ?? record.event_day)}。終わりにしました。${activityNote(materialsOf(record.project_id), answersOf(record.project_id))}`, state: "fact", level: levelOf(materialsOf(record.project_id) + answersOf(record.project_id)), from: at, to: position(monthOf(record.event_end ?? record.event_day), dayOf(record.event_end ?? record.event_day)) + 100 / 360, href: adminPath(ward, `/archive/${record.project_id}`), order: at });
  }
  for (const row of overrides.results.filter((entry) => entry.recurrence_text && !entry.removed_at)) {
    const base = YEAR_BASE.find((entry) => entry.key === row.item_id || entry.recurrence && similar(entry.title, row.title));
    if (base) used.add(base.key);
    if (rows.some((entry) => entry.title === (row.title || base?.title))) continue;
    rows.push({ key: row.item_id, title: row.title || base?.title || "", note: `${row.recurrence_text.replace(/。$/, "")}。${activityNote(row.source_original_id ? 1 : 0, 0)}`,
      state: "fact", level: levelOf(row.source_original_id ? 1 : 0), from: 0, to: 100, href: adminPath(ward, `/year/${row.item_id}`), order: 0 });
  }
  for (const row of overrides.results.filter((entry) => entry.added && !entry.removed_at && !entry.recurrence_text && entry.month)) {
    const at = position(row.month!);
    if (row.source_original_id) claim("", row.month!, row.title);
    rows.push({ key: row.item_id, title: row.title, note: row.date_text || (row.source_original_id ? "届いた資料から読み取りました" : ""), state: "fact", level: levelOf(row.source_original_id ? 1 : 0), from: at, to: at + 4, href: adminPath(ward, `/year/${row.item_id}`), order: at });
  }
  for (const base of YEAR_BASE) {
    if (used.has(base.key) || removed.has(base.key)) continue;
    const from = position(base.from);
    rows.push({ key: base.key, title: base.title, note: base.recurrence ? `${base.recurrence}。` : "", state: "example", from: base.recurrence ? 0 : from, to: base.recurrence ? 100 : position(base.to, 30) + 1, href: adminPath(ward, `/year/${base.key}`), order: base.recurrence ? 0 : from });
  }
  rows.sort((a, b) => a.order - b.order);
  const [, month, day] = today.split("-").map(Number) as [number, number, number];
  return { rows, today: position(month, day) / 100 };
}

/** トップの地図は今に近い行だけにする。行事が増えても画面が伸びないように。全部は一年の画面で見る。 */
export function nearToday(rows: YearRow[], today: number, limit = 14): YearRow[] {
  if (rows.length <= limit) return rows;
  const distance = (row: YearRow) => { if (row.from === 0 && row.to === 100) return 0; const gap = Math.abs(row.order - today * 100); return Math.min(gap, 100 - gap); };
  return [...rows].sort((a, b) => distance(a) - distance(b)).slice(0, limit).sort((a, b) => a.order - b.order);
}

export function YearLegend() {
  return <div class="shade-legend"><p>灰色の予定は、よくある自治会の例を仮に置いたもので、まだこの自治会のことではありません。押すと、この自治会で今年の準備を始めたり、資料を送ったり、この自治会に無い予定を外したりできます。毎週や毎月続く予定は、押すと、くり返す時期と進め方を書けます。紺の予定は、届いた資料や準備中のものから分かった、この自治会の予定です。紺が濃いほど、資料や出欠の返事がたくさん入っています。黄色の予定には、AIからの質問があります。</p>
    <p>薄い部分は準備する時期、濃い部分は実施する期間です。</p><p>実施する期間の濃さの目安（資料と返事の数）:</p>
    <ol>{levelLabels().map((label, index) => <li><i class={`l${index + 1}`} />{label}</li>)}</ol></div>;
}

export function YearMap({ rows, today }: { rows: YearRow[]; today: number }) {
  const segments = (from: number, to: number) => to < from ? [{ from, to: 100 }, { from: 0, to }] : [{ from, to }];
  return <div class="map year-map" style={`--today: ${today}`}>
    <div class="map-months"><span>{[4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3].map((month) => (month - 1) % 3 === 0 ? <i class="q">{month === 4 || month === 1 ? `${month}月` : month}</i> : <i>{month}</i>)}</span></div>
    <ol class="map-list">{rows.map((row) => <li><a class={`map-row ${row.state}${row.level ? ` l${row.level}` : ""}`} href={row.href}>
      <span class="map-name"><b>{row.title}</b>{row.note ? <small>{row.note}</small> : null}</span>
      <span class="map-track">{segments(row.from, row.to).map((part) => <i style={`--from:${part.from}%;--to:${Math.min(part.to, 100)}%;${row.eventFrom === undefined ? "" : "opacity:0.25"}`} />)}
        {row.eventFrom !== undefined && row.eventTo !== undefined ? segments(row.eventFrom, row.eventTo).map((part) => <i style={`--from:${part.from}%;--to:${Math.min(part.to, 100)}%`} />) : null}</span>
    </a></li>)}</ol>
    <div class="map-today"><span>今日</span></div>
  </div>;
}

export async function removeYearBase(db: D1Database, wardId: string, key: string, removed: boolean): Promise<void> {
  await db.prepare(`INSERT INTO ward_year_items (ward_id, item_id, removed_at) VALUES (?, ?, ?)
    ON CONFLICT (ward_id, item_id) DO UPDATE SET removed_at = excluded.removed_at`).bind(wardId, key, removed ? new Date().toISOString() : null).run();
}

export async function addYearItem(db: D1Database, wardId: string, input: { title: string; month: number | null; dateText: string; originalId: string | null; recurrence?: string }): Promise<string> {
  const id = newId();
  await db.prepare("INSERT INTO ward_year_items (ward_id, item_id, title, month, date_text, added, source_original_id, recurrence_text) VALUES (?, ?, ?, ?, ?, 1, ?, ?)")
    .bind(wardId, id, input.title, input.recurrence ? null : input.month, input.dateText, input.originalId, input.recurrence?.trim() ?? "").run();
  return id;
}

const todayJst = () => new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
const dutyTitle = (title: string) => /当番|集会所.*(?:掃除|清掃)/.test(title);
const knowKeyOf = (title: string) => dutyTitle(title) ? "duties" : /市報|回覧|配布/.test(title) ? "delivery"
  : /役員会/.test(title) ? "board" : /問い合わせ/.test(title) ? "inquiries" : "safety";

/** 通年の画面は一年の処理に置き、既存の役員用の差し込み口から登録する。 */
export const yearRecurringAdmin = new Hono<AdminEnv>();

yearRecurringAdmin.get("/year", async (c) => {
  const { ward, account } = c.var;
  const projects = await listOpenProjects(c.env.DB, ward.wardId);
  const states = await Promise.all(projects.map((project) => getProjectState(c.env.DB, ward.wardId, project.projectId)));
  const year = await wardYear(c.env.DB, ward, projects, states, todayJst());
  const removed = await c.env.DB.prepare("SELECT item_id, title, added FROM ward_year_items WHERE ward_id = ? AND removed_at IS NOT NULL ORDER BY created_at")
    .bind(ward.wardId).all<{ item_id: string; title: string; added: number }>();
  const taken = removed.results.map((row) => ({ key: row.item_id, title: row.added ? row.title : YEAR_BASE.find((base) => base.key === row.item_id)?.title ?? "" })).filter((row) => row.title);
  return c.html(<AdminPage ward={ward} account={account} title="この自治会の一年" back={{ href: adminPath(ward, "/"), label: "最初の画面へ" }}>
    <h1>この自治会の一年</h1>
    <p class="lead">予定を押すと、時期やくり返しを書けます。通年の予定は一年を通して表示します。</p>
    {c.req.query("notice") === "saved" ? <Notice>予定を保存しました。予定を押すと、書き直したり外したりできます。</Notice> : null}
    <YearLegend /><YearMap rows={year.rows} today={year.today} />
    <details class="fold" open={c.req.query("error") === "input"}><summary>予定を足す</summary><div>
      {c.req.query("error") === "input" ? <p>名前と時期を確かめてください。通年の予定には「毎週月曜」「毎月」「随時」のように書いてください。</p> : null}
      <form method="post" action={adminPath(ward, "/year")}>
        <div class="field"><label for="year-title">名前</label><input id="year-title" name="title" required maxlength={KNOW_LIMITS.title} /></div>
        <div class="field"><label for="year-month">時期</label><select id="year-month" name="month"><option value="0">通年</option>{[4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3].map((month) => <option value={String(month)}>{month}月</option>)}</select></div>
        <div class="field"><label for="year-recurrence">くり返し（通年のとき）</label><input id="year-recurrence" name="recurrence" maxlength={200} placeholder="毎週月曜、毎月、随時など" /></div>
        <button class="secondary">この予定を足す</button>
      </form></div></details>
    {taken.length ? <details class="fold"><summary>外した予定（{taken.length}つ）</summary><div>{taken.map((base) => <form method="post" action={adminPath(ward, `/year/${base.key}/restore`)}><p>{base.title}</p><button class="secondary">この予定を戻す</button></form>)}</div></details> : null}
  </AdminPage>);
});

yearRecurringAdmin.post("/year", async (c, next) => {
  const form = await c.req.formData();
  if (form.get("month") !== "0") return next();
  const title = cleanName(String(form.get("title") ?? ""));
  const recurrence = String(form.get("recurrence") ?? "").trim();
  if (!title || title.length > KNOW_LIMITS.title || !recurrence || recurrence.length > 200) return c.redirect(`${adminPath(c.var.ward, "/year")}?error=input`, 303);
  await addYearItem(c.env.DB, c.var.ward.wardId, { title, month: null, dateText: "", recurrence, originalId: null });
  return c.redirect(`${adminPath(c.var.ward, "/year")}?notice=saved`, 303);
});

async function recurringItem(db: D1Database, wardId: string, key: string) {
  const base = YEAR_BASE.find((entry) => entry.key === key && entry.recurrence);
  const row = await db.prepare("SELECT item_id, title, month, date_text, recurrence_text, added, removed_at, source_original_id FROM ward_year_items WHERE ward_id = ? AND item_id = ?")
    .bind(wardId, key).first<YearItem>();
  if (!base && !row?.recurrence_text) return null;
  const title = row?.title || base?.title || "";
  return { key, title, recurrence: row?.recurrence_text || base?.recurrence || "", example: !row?.recurrence_text,
    duty: base?.kind === "duty" || dutyTitle(title), knowKey: base?.knowKey ?? knowKeyOf(title), removed: Boolean(row?.removed_at), originalId: row?.source_original_id };
}

yearRecurringAdmin.get("/year/:key", async (c, next) => {
  const { ward, account } = c.var;
  const item = await recurringItem(c.env.DB, ward.wardId, c.req.param("key"));
  if (!item) return next();
  const know = await getKnowItem(c.env.DB, ward.wardId, item.knowKey);
  const root = adminPath(ward, `/year/${item.key}`);
  const year = Number(todayJst().slice(0, 4));
  return c.html(<AdminPage ward={ward} account={account} title={item.title} back={{ href: adminPath(ward, "/year"), label: "この自治会の一年へ" }}>
    <h1>{item.title}</h1><p class="lead">くり返す時期と、この自治会での進め方を書けます。</p>
    {item.example ? <p>一般の自治会の例を仮に置いています。この自治会ではどうしているかを書いて保存してください。</p> : <p>通年。{item.recurrence}。</p>}
    {c.req.query("error") ? <p>くり返す時期と進め方の長さを確かめて、もう一度保存してください。</p> : null}
    {c.req.query("notice") === "saved" ? <Notice>予定と自治会の基本情報を保存しました。下の欄で書き直せます。</Notice> : null}
    <form method="post" action={`${root}/recurring`}>
      <div class="field"><label for="recurrence">くり返す時期</label><input id="recurrence" name="recurrence" value={item.recurrence} maxlength={200} required /></div>
      <div class="field"><label for="body">この自治会での進め方</label><textarea id="body" name="body" rows={5} maxlength={KNOW_LIMITS.body}>{know?.body ?? ""}</textarea></div>
      <button>予定と自治会の基本情報を保存する</button>
    </form>
    <p><a class="quiet" href={adminPath(ward, `/know/${item.knowKey}`)}>自治会の基本情報で{know?.title ?? "進め方"}を読む</a></p>
    {item.originalId ? <a class="quiet" href={adminPath(ward, `/intake/originals/${item.originalId}`)}>元の資料を読む</a> : null}
    {item.duty && !item.removed ? <section class="panel"><h2>一年分の当番表を作る</h2><p>曜日を一度選び、名簿の順に日付を割り当てます。免除と転入・転出は作り直すと反映できます。</p>
      <form method="post" action={`${root}/prepare`}><button>{year}年の{item.title}の当番表を作る</button></form></section> : null}
    <form method="post" action={`${root}/${item.removed ? "restore" : "remove"}`}><p>外した予定は、一年の画面から戻せます。</p><button class="secondary">{item.removed ? "一年に戻す" : "この予定を外す"}</button></form>
  </AdminPage>);
});

yearRecurringAdmin.post("/year/:key/recurring", async (c) => {
  const { ward } = c.var;
  const item = await recurringItem(c.env.DB, ward.wardId, c.req.param("key"));
  if (!item) return c.notFound();
  const form = await c.req.formData();
  const recurrence = String(form.get("recurrence") ?? "").trim();
  const body = String(form.get("body") ?? "");
  const root = adminPath(ward, `/year/${item.key}`);
  if (!recurrence || recurrence.length > 200 || body.length > KNOW_LIMITS.body) return c.redirect(`${root}?error=input`, 303);
  await c.env.DB.prepare(`INSERT INTO ward_year_items (ward_id, item_id, title, recurrence_text) VALUES (?, ?, ?, ?)
    ON CONFLICT (ward_id, item_id) DO UPDATE SET recurrence_text = excluded.recurrence_text, month = NULL`)
    .bind(ward.wardId, item.key, item.title, recurrence).run();
  await saveKnowItem(c.env.DB, ward.wardId, item.knowKey, { body });
  return c.redirect(`${root}?notice=saved`, 303);
});

yearRecurringAdmin.post("/year/:key/prepare", async (c) => {
  const { ward, account } = c.var;
  const item = await recurringItem(c.env.DB, ward.wardId, c.req.param("key"));
  if (!item || !item.duty || item.removed) return c.notFound();
  const year = Number(todayJst().slice(0, 4));
  const existing = await c.env.DB.prepare("SELECT project_id, closed_at FROM projects WHERE ward_id = ? AND kind = 'duty' AND title = ? AND year = ? ORDER BY created_at DESC LIMIT 1")
    .bind(ward.wardId, item.title, year).first<{ project_id: string; closed_at: string | null }>();
  if (existing?.closed_at) return c.redirect(adminPath(ward, `/archive/${existing.project_id}`), 303);
  const projectId = existing?.project_id ?? (await createProject(c.env.DB, ward.wardId, { kind: "duty", title: item.title, year, accountId: account.accountId })).projectId;
  return c.redirect(adminPath(ward, `/projects/${projectId}/draft/duty_roster`), 303);
});
