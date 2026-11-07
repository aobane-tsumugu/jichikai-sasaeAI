// 区の一年の地図。一般の自治会の一年を仮に置き、行事と届いた資料でこの区の内容に変えていく。
import { adminPath } from "../core/auth";
import { newId } from "../core/ids";
import { formatJstDate } from "../core/time";
import type { WardInfo } from "../env";
import type { ProjectState, ProjectSummary } from "../project/types";

export interface YearBase { key: string; title: string; kind: string; from: number; to: number }

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
];

export type YearState = "example" | "fact" | "checking";

export interface YearRow { key: string; title: string; note: string; state: YearState; from: number; to: number; href: string; order: number; level?: Level }

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

interface RecordRow { project_id: string; title: string; kind: string; year: number; event_day: string | null }

export async function wardYear(db: D1Database, ward: WardInfo, projects: readonly ProjectSummary[], states: readonly (ProjectState | null)[], today: string) {
  const [materialCounts, answerCounts] = await Promise.all([
    db.prepare(`SELECT j.project_id, COUNT(*) AS n FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
      WHERE o.ward_id = ? AND j.project_id IS NOT NULL AND o.withdrawn_at IS NULL AND j.withdrawn_at IS NULL GROUP BY j.project_id`).bind(ward.wardId).all<{ project_id: string; n: number }>(),
    db.prepare("SELECT project_id, COUNT(*) AS n FROM project_answers WHERE ward_id = ? GROUP BY project_id").bind(ward.wardId).all<{ project_id: string; n: number }>(),
  ]);
  const materialsOf = (id: string) => materialCounts.results.find((row) => row.project_id === id)?.n ?? 0;
  const answersOf = (id: string) => answerCounts.results.find((row) => row.project_id === id)?.n ?? 0;
  const [overrides, records] = await Promise.all([
    db.prepare("SELECT item_id, title, month, date_text, added, removed_at, source_original_id FROM ward_year_items WHERE ward_id = ?").bind(ward.wardId)
      .all<{ item_id: string; title: string; month: number | null; date_text: string; added: number; removed_at: string | null; source_original_id: string | null }>(),
    db.prepare(`SELECT p.project_id, p.title, p.kind, p.year, (SELECT d.due_on FROM project_deadlines d WHERE d.ward_id = p.ward_id AND d.project_id = p.project_id AND d.kind = 'event_day') AS event_day
      FROM projects p WHERE p.ward_id = ? AND p.closed_at IS NOT NULL ORDER BY p.closed_at DESC LIMIT 12`).bind(ward.wardId).all<RecordRow>(),
  ]);
  const removed = new Set(overrides.results.filter((row) => row.removed_at).map((row) => row.item_id));
  const used = new Set<string>();
  const similar = (a: string, b: string) => Array.from({ length: Math.max(a.length - 1, 0) }, (_, index) => a.slice(index, index + 2)).some((part) => b.includes(part));
  const rows: YearRow[] = [];
  // 名前の似た仮の行を先に置き換える。無ければ同じ種類の行。どちらも無ければ足すだけにする。
  const claim = (kind: string, month: number, title: string) => {
    const open = YEAR_BASE.filter((entry) => !used.has(entry.key) && inRange(month, entry));
    const base = open.find((entry) => similar(entry.title, title)) ?? (kind ? open.find((entry) => entry.kind === kind) : undefined);
    if (base) used.add(base.key);
  };
  projects.forEach((project, index) => {
    const day = project.deadlines.event_day ?? project.deadlines.submit_due;
    const state = states[index];
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
    const start = firstTask && Number(firstTask.slice(0, 4)) === Number(day.slice(0, 4)) ? position(monthOf(firstTask), dayOf(firstTask)) : position(month, dayOf(day));
    rows.push({ key: project.projectId, title: project.title, note: [formatJstDate(day), activityNote(materialsOf(project.projectId), answersOf(project.projectId))].filter(Boolean).join("。"), state: "fact", level: levelOf(materialsOf(project.projectId) + answersOf(project.projectId)), from: start, to: Math.max(position(month, dayOf(day)) + 2, start + 2), href: adminPath(ward, `/projects/${project.projectId}/map`), order: position(month, dayOf(day)) });
  });
  for (const record of records.results) {
    if (!record.event_day || rows.some((row) => row.title === record.title)) continue;
    const month = monthOf(record.event_day);
    claim(record.kind, month, record.title);
    const at = position(month, dayOf(record.event_day));
    rows.push({ key: record.project_id, title: record.title, note: [`${record.year}年に終わったもの`, activityNote(materialsOf(record.project_id), answersOf(record.project_id))].filter(Boolean).join("。"), state: "fact", level: levelOf(materialsOf(record.project_id) + answersOf(record.project_id)), from: at, to: at + 2, href: adminPath(ward, `/archive/${record.project_id}`), order: at });
  }
  for (const row of overrides.results.filter((entry) => entry.added && !entry.removed_at && entry.month)) {
    const at = position(row.month!);
    if (row.source_original_id) claim("", row.month!, row.title);
    rows.push({ key: row.item_id, title: row.title, note: row.date_text || (row.source_original_id ? "届いた資料から読み取りました" : ""), state: "fact", level: levelOf(row.source_original_id ? 1 : 0), from: at, to: at + 4, href: adminPath(ward, `/year/${row.item_id}`), order: at });
  }
  for (const base of YEAR_BASE) {
    if (used.has(base.key) || removed.has(base.key)) continue;
    const from = position(base.from);
    rows.push({ key: base.key, title: base.title, note: "", state: "example", from, to: position(base.to, 30) + 1, href: adminPath(ward, `/year/${base.key}`), order: from });
  }
  rows.sort((a, b) => a.order - b.order);
  const [, month, day] = today.split("-").map(Number) as [number, number, number];
  return { rows, today: position(month, day) / 100 };
}

/** トップの地図は今に近い行だけにする。行事が増えても画面が伸びないように。全部は一年の画面で見る。 */
export function nearToday(rows: YearRow[], today: number, limit = 14): YearRow[] {
  if (rows.length <= limit) return rows;
  const distance = (row: YearRow) => { const gap = Math.abs(row.order - today * 100); return Math.min(gap, 100 - gap); };
  return [...rows].sort((a, b) => distance(a) - distance(b)).slice(0, limit).sort((a, b) => a.order - b.order);
}

export function YearLegend() {
  return <div class="shade-legend"><p>灰色の予定は、よくある自治会の例を仮に置いたもので、まだこの自治会のことではありません。押すと、この自治会ではどうしているかを入れられます。紺の予定は、届いた資料や準備中のものから分かった、この自治会の予定です。紺が濃いほど、資料や出欠の返事がたくさん入っています。黄色の予定には、AIからの質問があります。</p>
    <p>濃さの目安（資料と返事の数）:</p>
    <ol>{levelLabels().map((label, index) => <li><i class={`l${index + 1}`} />{label}</li>)}</ol></div>;
}

export function YearMap({ rows, today }: { rows: YearRow[]; today: number }) {
  return <div class="map year-map" style={`--today: ${today}`}>
    <div class="map-months"><span>{[4, 5, 6, 7, 8, 9, 10, 11, 12, 1, 2, 3].map((month) => (month - 1) % 3 === 0 ? <i class="q">{month === 4 || month === 1 ? `${month}月` : month}</i> : <i>{month}</i>)}</span></div>
    <ol class="map-list">{rows.map((row) => <li><a class={`map-row ${row.state}${row.level ? ` l${row.level}` : ""}`} href={row.href}>
      <span class="map-name"><b>{row.title}</b>{row.note ? <small>{row.note}</small> : null}</span>
      <span class="map-track"><i style={`--from:${row.from}%;--to:${Math.min(row.to, 100)}%`} /></span>
    </a></li>)}</ol>
    <div class="map-today"><span>今日</span></div>
  </div>;
}

export async function removeYearBase(db: D1Database, wardId: string, key: string, removed: boolean): Promise<void> {
  await db.prepare(`INSERT INTO ward_year_items (ward_id, item_id, removed_at) VALUES (?, ?, ?)
    ON CONFLICT (ward_id, item_id) DO UPDATE SET removed_at = excluded.removed_at`).bind(wardId, key, removed ? new Date().toISOString() : null).run();
}

export async function addYearItem(db: D1Database, wardId: string, input: { title: string; month: number; dateText: string; originalId: string | null }): Promise<string> {
  const id = newId();
  await db.prepare("INSERT INTO ward_year_items (ward_id, item_id, title, month, date_text, added, source_original_id) VALUES (?, ?, ?, ?, ?, 1, ?)")
    .bind(wardId, id, input.title, input.month, input.dateText, input.originalId).run();
  return id;
}
