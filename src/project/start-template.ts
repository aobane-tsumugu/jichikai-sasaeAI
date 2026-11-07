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
}

type Past = { projectId: string; title: string; kind: ProjectKind; year: number; closedAt: string | null; deadlines: { event_day?: string } };

const normalize = (title: string) => title.replace(/\s+/g, "").replace(/^\d{4}年(度)?の?/, "");

/** 名前から、始める時の並びを決める。名前の言葉から種類を当てることはしない。 */
export function startTemplate(title: string, past: ReadonlyArray<Past> = []): StartTemplate {
  const name = normalize(title);
  const seed = [...past].filter((project) => project.closedAt && normalize(project.title) === name).sort((a, b) => b.year - a.year)[0];
  if (seed) return { kind: seed.kind, seedProjectId: seed.projectId, from: "last_year", ...(seed.deadlines.event_day ? { lastDay: seed.deadlines.event_day } : {}) };
  const base = YEAR_BASE.find((entry) => normalize(entry.title) === name);
  const template = base?.template ?? SHORT_TEMPLATE;
  return { kind: template.kind, ...(template.tasks ? { taskKeys: template.tasks } : {}), from: base ? "year_plan" : "short" };
}

/** 始める前に、何が置かれるかを一文で書く（L-313 で本人に見せた形）。 */
export function startTemplateText(title: string, template: StartTemplate): string {
  if (template.from === "last_year") return template.lastDay
    ? `去年は${shortDate(template.lastDay)}に行いました。去年のやることを、今年の日に合わせて置き直します。`
    : "去年も行いました。去年のやることを、今年の日に合わせて置き直します。";
  if (template.from === "year_plan") return `よくある自治会の${title}のやることを置きます。あとで足したり外したりできます。`;
  return "知らせる、当日、まとめるの三つだけのやることで始めます。あとで足したり外したりできます。";
}
