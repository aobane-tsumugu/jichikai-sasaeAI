import { shortDate } from "../core/time";
import { SHORT_TEMPLATE, YEAR_BASE } from "../know/year";
import type { ProjectKind } from "./model";

/**
 * 準備を始める時の、やることの並びの決め方（決定ログ L-312、L-313）。
 * 役員にも AI にも、六つの種類を選ばせない。六つの種類には根拠が無く、軸が混ざっているため（reviews/20261107_project_kinds.md）。
 * 去年の同じ予定の準備があれば、その並びを今年の日に合わせて置き直す。無ければ、一年の予定ごとの並び（YEAR_BASE の template）。
 * どれでもなければ、知らせる、当日、まとめるの短い並び。
 * 中の種類の列（projects.kind）はすぐには消さないので、並びに合う値を入れておく。機能を出す判断は、種類からやることへ一つずつ移す。
 */
export interface StartTemplate {
  /** 中の種類の列に入れる値。役員には見せない。 */
  kind: ProjectKind;
  /** 型のうち、置く仕事の印。無い時は型の全部。 */
  taskKeys?: readonly string[];
  /** 去年の同じ予定の準備。あれば、その並びを写す。 */
  seedProjectId?: string;
  /** どこから並びを持ってきたか。画面の文に使う。 */
  from: "last_year" | "year_plan" | "short";
  /** 去年の当日（分かる時）。 */
  lastDay?: string;
  /** 一年の予定に書かれた題。資料の文書名とは分けて説明する。 */
  yearItemTitle?: string;
}

type Past = { projectId: string; title: string; kind: ProjectKind; year: number; closedAt: string | null; deadlines: { event_day?: string } };

export const normalizeStartTitle = (title: string) => title.normalize("NFKC")
  .replace(/[\p{P}\p{S}\s]/gu, "")
  .replace(/^(?:\d{4}|令和\d+|平成\d+)年度?の?/, "")
  .replace(/(?:のご案内|の案内|のお知らせ|の当番表)$/, "");

/** 名前から、始める時の並びを決める。名前の言葉から種類を当てることはしない。 */
export function startTemplate(title: string, past: ReadonlyArray<Past> = [], yearItems: readonly { key: string; title: string }[] = YEAR_BASE): StartTemplate {
  const name = normalizeStartTitle(title);
  const seed = [...past].filter((project) => name && project.closedAt && normalizeStartTitle(project.title) === name).sort((a, b) => b.year - a.year)[0];
  if (seed) return { kind: seed.kind, seedProjectId: seed.projectId, from: "last_year", ...(seed.deadlines.event_day ? { lastDay: seed.deadlines.event_day } : {}) };
  const item = yearItems.find((entry) => name && normalizeStartTitle(entry.title) === name);
  const base = item && YEAR_BASE.find((entry) => entry.key === item.key || normalizeStartTitle(entry.title) === name);
  const template = base?.template ?? SHORT_TEMPLATE;
  return { kind: template.kind, ...(template.tasks ? { taskKeys: template.tasks } : {}), from: item ? "year_plan" : "short", ...(item ? { yearItemTitle: item.title } : {}) };
}

/** 始める前に、何が置かれるかを、名前から始める画面と資料の画面に合わせて書く。 */
export function startTemplateText(title: string, template: StartTemplate, source: "name" | "materials" = "name"): string {
  if (template.from === "last_year") return template.lastDay
    ? `去年は${shortDate(template.lastDay)}に行いました。去年のやることを、今年の日に合わせて置き直します。`
    : "去年も行いました。去年のやることを、今年の日に合わせて置き直します。";
  if (template.from === "year_plan") {
    const name = source === "materials" ? `一年の予定の「${template.yearItemTitle ?? title}」` : `よくある自治会の${title}`;
    return `${name}のやることを置きます。${template.taskKeys?.includes("assign") ? "当番表があるので、担当を決める仕事も置きます。" : ""}あとで足したり外したりできます。`;
  }
  if (template.taskKeys?.includes("assign")) return "知らせる、担当を決める、当日、まとめるの四つのやることで始めます。あとで足したり外したりできます。";
  return "知らせる、当日、まとめるの三つだけのやることで始めます。あとで足したり外したりできます。";
}
