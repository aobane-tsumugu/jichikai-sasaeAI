// 地図の型。プロジェクトを開く時に、種類ごとの一般の仕事を置く（設計書 3.1、L-152）。
// 役員は眺めて、要らない仕事を消し、足りない仕事を足す。しなくても流れは止まらない。
//
// 準備は始まる日、報告は終わる日から数える。実施の日が決まっていなければ時期は空のまま置く。
// opens は、仕事を押した時にその仕事から開く物。材料、案、答え、収支の四つ。

import type { DocumentKind, ProjectKind } from "../project/model";

export type MapOpens = "materials" | "draft" | "answers" | "ledger" | "committee" | "sponsors";

export interface TemplateTask {
  /** 型の仕事の名前。プロジェクトの中で一意。AI が仕事に当てる時の鍵になる。 */
  key: string;
  name: string;
  /** 行事の日からの日数（負は前）。 */
  start: number;
  end: number;
  opens: readonly MapOpens[];
  draftKind?: DocumentKind;
  /** 仕事の画面の先頭に出す一言。何をする仕事かを、初めての人に伝える。 */
  guide?: string;
}

/** 種類ごとの型。行事は設計書の「実行委員、会場、協賛、案内、回答、当番表、当日、報告」。 */
export const MAP_TEMPLATES: Record<string, readonly TemplateTask[]> = {
  event: [
    { key: "committee", name: "実行委員を決める", start: -75, end: -55, opens: ["committee", "materials"], guide: "実行委員になってくれる人を決めます。決まったら実行委員名簿に入れると、案内や当番表で使えます。" },
    { key: "venue", name: "会場を押さえる", start: -70, end: -45, opens: ["ledger", "materials", "draft"], guide: "会場を電話などで押さえます。決まったら、借りたところと日を運営メモに残せます。来年の担当の人も読めます。" },
    { key: "sponsors", name: "協賛をお願いする", start: -60, end: -25, opens: ["sponsors", "ledger", "materials"], guide: "協賛をお願いする先を回ります。協賛先の一覧を印刷して持って行けます。" },
    { key: "announcement", name: "案内を住民に知らせる", start: -45, end: -30, opens: ["draft", "materials"], draftKind: "announcement", guide: "案内の下書きを直して住民に知らせます。住民向けのページに載せ、LINEで送り、紙を印刷できるようにします。" },
    { key: "answers", name: "参加と手伝いの返事を集める", start: -30, end: -14, opens: ["answers", "materials"], guide: "住民から届く出欠と手伝いを集めます。紙、電話、スマホの返事が一つにまとまります。" },
    { key: "duty_roster", name: "当番表と配置を決める", start: -21, end: -7, opens: ["draft", "answers"], draftKind: "duty_roster", guide: "手伝いの返事をもとに、当番表と配置を決めて、実行委員と班長のページに載せます。" },
    { key: "day", name: "当日", start: 0, end: 0, opens: ["materials", "ledger"], guide: "行事の当日です。撮った写真や受付のメモは、そのまま送れます。" },
    { key: "report", name: "報告をまとめる", start: 1, end: 14, opens: ["draft", "ledger"], draftKind: "report", guide: "行事の報告をまとめて、終わりにします。来年の人への一言も残せます。" },
  ],
  general_meeting: [
    { key: "agenda", name: "議案を決める", start: -45, end: -21, opens: ["materials", "draft"], draftKind: "procedure", guide: "総会で話し合うことを決めます。去年の議案や役員会の紙は、そのまま送れます。" },
    { key: "notice", name: "招集を住民に知らせる", start: -21, end: -14, opens: ["draft"], draftKind: "announcement", guide: "総会の招集の下書きを直して住民に知らせます。住民向けのページに載せ、LINEで送り、紙を印刷できるようにします。" },
    { key: "answers", name: "出欠を集める", start: -14, end: -3, opens: ["answers"], guide: "出席、委任、欠席の返事を集めます。紙、電話、スマホの返事が一つにまとまります。" },
    { key: "day", name: "当日", start: 0, end: 0, opens: ["materials"], guide: "総会の当日です。決まったことを書いた紙は、撮って送れます。" },
    { key: "minutes", name: "議事録をまとめる", start: 1, end: 14, opens: ["draft", "materials"], draftKind: "report", guide: "決まったことを議事録にまとめます。" },
  ],
  city_request: [
    { key: "read", name: "通知を読む", start: -30, end: -25, opens: ["materials"], guide: "市から届いた通知を読みます。撮って送ると、その写真がここに残ります。" },
    { key: "reply", name: "市への回答や、住民に知らせるものを用意する", start: -25, end: -7, opens: ["materials", "draft"], draftKind: "procedure", guide: "市への回答や、住民に知らせるものを用意します。" },
    { key: "submit", name: "提出する", start: -7, end: 0, opens: ["draft"], draftKind: "report", guide: "市に提出します。出したら、この仕事を済みにしてください。" },
  ],
  board_meeting: [
    { key: "agenda", name: "議題を集める", start: -14, end: -3, opens: ["materials", "draft"], draftKind: "procedure", guide: "役員会で話すことを集めます。" },
    { key: "day", name: "当日", start: 0, end: 0, opens: ["materials"], guide: "役員会の当日です。決まったことを書いた紙は、撮って送れます。" },
    { key: "minutes", name: "決めたことをまとめる", start: 1, end: 7, opens: ["draft", "materials"], draftKind: "report", guide: "役員会で決めたことをまとめます。" },
  ],
  duty: [
    { key: "assign", name: "当番表を作る", start: -21, end: -7, opens: ["materials", "draft"], draftKind: "duty_roster", guide: "毎週の当番は、曜日を一度選ぶと一年分の日付を名簿の順で割り当てます。免除や名簿が変わったときも、下書きを作り直せます。" },
    { key: "notify", name: "担当に知らせる", start: -7, end: -3, opens: ["draft"], draftKind: "notice", guide: "担当の人に、日と場所を知らせます。" },
    { key: "day", name: "当日", start: 0, end: 0, opens: ["materials"] },
  ],
  request: [
    { key: "content", name: "要望の中身をまとめる", start: -30, end: -14, opens: ["materials", "draft"], draftKind: "procedure", guide: "市に出す要望の中身をまとめます。" },
    { key: "submit", name: "出す", start: -14, end: 0, opens: ["draft"], draftKind: "report", guide: "市に要望を出します。出したら、この仕事を済みにしてください。" },
  ],
};

/** 仕事を手で足した時も、既存の仕事の名前と鍵を対応させる。自由な名前を推測で分類しない。 */
export function taskKeyOf(key: string | null, name = ""): string | null {
  return key ?? ({ "担当を決める": "assign", "提出する": "submit", "出欠を集める": "answers", "委任と出欠を集める": "delegation" } as Record<string, string>)[name.trim()]
    ?? Object.values(MAP_TEMPLATES).flat().find((task) => task.name === name.trim())?.key ?? null;
}
function definition(taskKey: string | null, family = "event"): TemplateTask | undefined {
  if (taskKey === "delegation") return MAP_TEMPLATES.general_meeting?.find((task) => task.key === "answers");
  return MAP_TEMPLATES[family]?.find((task) => task.key === taskKey)
    ?? Object.values(MAP_TEMPLATES).flat().find((task) => task.key === taskKey);
}
/** 文書の仕事は種類によらず同じ鍵から開く。kindは古い呼び出しとの互換。 */
export function taskDraftKind(taskKey: string | null, _kind: ProjectKind = "event"): DocumentKind {
  return ({ assign: "duty_roster", duty_roster: "duty_roster", agenda: "procedure", reply: "procedure", content: "procedure",
    submit: "report", report: "report", minutes: "report", notify: "notice", notice: "announcement" } as Partial<Record<string, DocumentKind>>)[taskKey ?? ""] ?? "announcement";
}
export function initialDraftKind(kind: ProjectKind): DocumentKind {
  return taskDraftKind(MAP_TEMPLATES[kind]?.find((task) => task.draftKind)?.key ?? null);
}
export function draftTaskKeys(kind: ProjectKind, documentKind: DocumentKind): string[] {
  return (MAP_TEMPLATES[kind] ?? []).filter((task) => task.draftKind && taskDraftKind(task.key) === documentKind).map((task) => task.key);
}
export function guideOf(family: string, taskKey: string | null): string {
  return definition(taskKey, family)?.guide ?? "";
}
export function opensOf(family: string, taskKey: string | null): readonly MapOpens[] {
  return definition(taskKey, family)?.opens ?? ["materials"];
}

/** YYYY-MM-DD に日数を足す（UTC の暦で計算する。時刻を持たないので時差の影響を受けない）。 */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** 実施の仕事は期間全体、実施後の仕事は終わる日から数える。 */
export function templatePeriod(task: Pick<TemplateTask, "start" | "end">, day: string, endDay = day) {
  return {
    start: addDays(task.start > 0 ? endDay : day, task.start),
    end: addDays(task.end > 0 || (task.start === 0 && task.end === 0) ? endDay : day, task.end),
  };
}
