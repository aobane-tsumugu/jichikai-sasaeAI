// 地図の型。プロジェクトを開く時に、種類ごとの一般の仕事を置く（設計書 3.1、L-152）。
// 役員は眺めて、要らない仕事を消し、足りない仕事を足す。しなくても流れは止まらない。
//
// offset は行事の日（期限群の event_day）からの日数。行事の日が決まっていなければ時期は空のまま置く。
// opens は、仕事を押した時にその仕事から開く物。材料、案、答え、収支の四つ。

export type MapOpens = "materials" | "draft" | "answers" | "ledger";

export interface TemplateTask {
  /** 型の仕事の名前。プロジェクトの中で一意。AI が仕事に当てる時の鍵になる。 */
  key: string;
  name: string;
  /** 行事の日からの日数（負は前）。 */
  start: number;
  end: number;
  opens: readonly MapOpens[];
}

/** 種類ごとの型。行事は設計書の「実行委員、会場、協賛、案内、回答、当番表、当日、報告」。 */
export const MAP_TEMPLATES: Record<string, readonly TemplateTask[]> = {
  event: [
    { key: "committee", name: "実行委員を決める", start: -75, end: -55, opens: ["materials"] },
    { key: "venue", name: "会場を押さえる", start: -70, end: -45, opens: ["materials", "draft"] },
    { key: "sponsors", name: "協賛をお願いする", start: -60, end: -25, opens: ["materials", "ledger"] },
    { key: "announcement", name: "案内を配る", start: -45, end: -30, opens: ["draft", "materials"] },
    { key: "answers", name: "参加と手伝いの答えを集める", start: -30, end: -14, opens: ["answers", "materials"] },
    { key: "duty_roster", name: "当番表と配置を決める", start: -21, end: -7, opens: ["draft", "answers"] },
    { key: "day", name: "当日", start: 0, end: 0, opens: ["materials", "ledger"] },
    { key: "report", name: "報告をまとめる", start: 1, end: 14, opens: ["draft", "ledger"] },
  ],
  general_meeting: [
    { key: "agenda", name: "議案を決める", start: -45, end: -21, opens: ["materials", "draft"] },
    { key: "notice", name: "招集を配る", start: -21, end: -14, opens: ["draft"] },
    { key: "answers", name: "出欠を集める", start: -14, end: -3, opens: ["answers"] },
    { key: "day", name: "当日", start: 0, end: 0, opens: ["materials"] },
    { key: "minutes", name: "議事録をまとめる", start: 1, end: 14, opens: ["materials"] },
  ],
  city_request: [
    { key: "read", name: "通知を読む", start: -30, end: -25, opens: ["materials"] },
    { key: "reply", name: "答えや配るものを用意する", start: -25, end: -7, opens: ["materials", "draft"] },
    { key: "submit", name: "提出する", start: -7, end: 0, opens: ["draft"] },
  ],
  board_meeting: [
    { key: "agenda", name: "議題を集める", start: -14, end: -3, opens: ["materials", "draft"] },
    { key: "day", name: "当日", start: 0, end: 0, opens: ["materials"] },
    { key: "minutes", name: "決めたことをまとめる", start: 1, end: 7, opens: ["draft"] },
  ],
  duty: [
    { key: "assign", name: "担当を決める", start: -21, end: -7, opens: ["materials", "draft"] },
    { key: "notify", name: "担当に知らせる", start: -7, end: -3, opens: ["draft"] },
    { key: "day", name: "当日", start: 0, end: 0, opens: ["materials"] },
  ],
  request: [
    { key: "content", name: "要望の中身をまとめる", start: -30, end: -14, opens: ["materials", "draft"] },
    { key: "submit", name: "出す", start: -14, end: 0, opens: ["draft"] },
  ],
};

/** 仕事を押した時に開く物。型にない仕事（役員が足した物）は材料だけ。 */
export function opensOf(kind: string, taskKey: string | null): readonly MapOpens[] {
  const task = MAP_TEMPLATES[kind]?.find((t) => t.key === taskKey);
  return task?.opens ?? ["materials"];
}

/** YYYY-MM-DD に日数を足す（UTC の暦で計算する。時刻を持たないので時差の影響を受けない）。 */
export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}
