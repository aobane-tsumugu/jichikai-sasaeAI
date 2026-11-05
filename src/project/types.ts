// src/project/api.ts が export する型。他の束（束 2 の MCP の手、束 4、5、7）はこの型を通して状態を読み書きする。
import type {
  Confidence,
  DeadlineKind,
  DocumentKind,
  ItemKey,
  MapProgress,
  ProjectKind,
  QuestionKind,
  QuestionState,
  RowData,
  Scope,
  Source,
  TableKey,
} from "./model";

// ---- プロジェクト ----

export interface ProjectSummary {
  projectId: string;
  kind: ProjectKind;
  title: string;
  year: number;
  /** 閉じた（凍結）時刻。開いていれば null。 */
  closedAt: string | null;
  stateVersion: number;
  /** 行事の日など、期限群（日付は JST の YYYY-MM-DD）。 */
  deadlines: Partial<Record<DeadlineKind, string>>;
}

export interface CreateProjectInput {
  kind: ProjectKind;
  title: string;
  year: number;
  /** 行事の日（YYYY-MM-DD）。あれば期限群に入れ、地図の仕事の時期を置く。 */
  eventDay?: string;
  /** 去年の地図を種にする時の、元のプロジェクト。 */
  seedProjectId?: string;
  accountId?: string;
}

// ---- 差分 ----

interface ChangeBase {
  /** どの版の包みで読んだか。重複を弾く印と、作り直す物の選び方に使う。 */
  packVersion: string;
  source: Source;
  confidence: Confidence;
  /** 列の記録（束 2）の札の ID。記録に残すだけで、検査には使わない。 */
  ticketId?: string;
  /**
   * 原本が出どころでない差分（人の入力）の重複を弾く印。フォームの二度押しを防ぎたい時に付ける。
   * 無ければ、人の入力は毎回別の差分になる。
   */
  requestId?: string;
}

/** 項目の中身を書く。今年か参考かは、出どころから API が決める。 */
export interface ItemChange extends ChangeBase {
  kind: "item";
  itemKey: ItemKey;
  value: string;
  /** 年不明の資料が今年の話に見える時の印。今年の中身には入れず、違う所だけを問う。 */
  maybeThisYear?: boolean;
}

/** 表の行の追加と更新。同じ相手（照合の鍵）に当たれば更新、当たらなければ追加。 */
export interface RowChange extends ChangeBase {
  kind: "row";
  table: TableKey;
  data: RowData;
}

/** 資料同士の食い違い（AI が気づいた物）。二つ以上の中身を並べて、役員が一つ選ぶ問いになる。 */
export interface ConflictChange extends ChangeBase {
  kind: "conflict";
  /** 項目の名前、または「表の名前:相手」。 */
  target: string;
  summary: string;
  options: { value: string; source?: Source }[];
}

/** 古くなる文書。出した物は変わらず、案に古い印が付く。 */
export interface StaleChange extends ChangeBase {
  kind: "stale";
  documents: DocumentKind[];
  reason: string;
}

/** 地図の仕事に当てる（進んだ、済んだ）。前に戻す変更は受けない。 */
export interface MapTaskChange extends ChangeBase {
  kind: "map_task";
  taskKey: string;
  progress: Exclude<MapProgress, "open">;
}

export type ChangeInput = ItemChange | RowChange | ConflictChange | StaleChange | MapTaskChange;

export interface ApplyOptions {
  /** 出どころの原本が区の中に実在するか。束 2 の MCP の手が渡す。無ければ形の検査だけをする。 */
  verifyOriginal?: (originalId: string) => Promise<boolean>;
  /** 変更を行った役員のアカウント。人の入力の時は出どころの accountId と同じにする。 */
  actorAccountId?: string;
  /** 資料を今年の物に直す時、今年の中身と違う所を上書きせず問いにする。 */
  compareCurrent?: boolean;
}

interface ResultBase {
  /** 同じ印の二度目で、保存した結果をそのまま返した時 true。 */
  duplicate: boolean;
}

export type ApplyResult =
  /** 入った。 */
  | (ResultBase & {
      status: "applied";
      changeId: string;
      stateVersion: number;
      /** 古い印が付いた文書。 */
      staleDocuments: DocumentKind[];
      /** この差分で並んだ問い。 */
      questionIds: string[];
      /** 表の行で、人の入力と食い違って入れなかった列。 */
      conflictFields?: string[];
    })
  /** 同じ中身が既にあった（画面では「同じ物でした」）。 */
  | (ResultBase & { status: "same"; changeId: string; stateVersion: number })
  /** 決まった中身が既にあるので、AI の案は入れなかった。 */
  | (ResultBase & { status: "kept"; changeId: string; stateVersion: number })
  /** 上書きせず、食い違いとして問いに並べた。 */
  | (ResultBase & { status: "conflict"; changeId: string; stateVersion: number; questionIds: string[] })
  /** 照合が曖昧で、同じ相手かを問いに並べて保留した。 */
  | (ResultBase & { status: "held"; changeId: string; stateVersion: number; questionIds: string[] })
  /** 出どころの検査などで捨てた。捨てたことは問いの一覧に出る。 */
  | (ResultBase & { status: "dropped"; changeId: string; stateVersion: number; reason: string; questionIds: string[] })
  /** 受けなかった（記録に残さない）。プロジェクトが無い、閉じている、同じ印で中身が違う。 */
  | { status: "rejected"; reason: "no_project" | "closed" | "key_reused" };

// ---- 問い ----

export interface QuestionInput {
  /** 'discarded' は捨てた差分を示すために Workers が作る物で、書く手は使わない。 */
  kind: Exclude<QuestionKind, "discarded">;
  text: string;
  /** 何についての問いか（項目の名前、「表の名前:相手」、地図の仕事の鍵）。 */
  target?: string;
  /** 選べる物。 */
  options?: string[];
  /** 読めなかった所の出どころ（原本と箇所）。 */
  source?: Source;
  packVersion: string;
  requestId?: string;
}

export type AddQuestionResult =
  | { status: "added"; questionId: string }
  /** 同じ問いが既にあった。 */
  | { status: "same"; questionId: string }
  | { status: "rejected"; reason: "no_project" | "closed" | "key_reused" | "bad_source" | "bad_input"; detail?: string };

// ---- 状態（読む側） ----

export interface SourceView {
  kind: Source["kind"];
  ref: string | null;
  locator: string | null;
  year: number | null;
}

export interface ValueView {
  valueId: string;
  content: string;
  scope: "current" | "reference";
  refYear: number | null;
  source: SourceView;
  confidence: Confidence;
  createdAt: string;
}

export interface ItemState {
  key: ItemKey;
  label: string;
  /** 今年の中身。空なら null。 */
  current: ValueView | null;
  /** 参考の中身（年ごと。新しい年が先、年不明は最後）。 */
  references: ValueView[];
}

export interface RowView {
  rowId: string;
  table: TableKey;
  scope: "current" | "reference";
  refYear: number | null;
  matchKey: string;
  data: RowData;
  /** 人が入れた列。AI の更新が食い違いとして並ぶ。 */
  personFields: string[];
  source: SourceView;
  confidence: Confidence;
  updatedAt: string;
}

export interface DocumentSummary {
  documentId: string;
  kind: DocumentKind;
  title: string;
  scope: Scope;
  /** 古い印。元にした状態より新しい差分が入った。 */
  stale: boolean;
  /** 最新の版（下書きを含む）。無ければ null。 */
  latestVersionNo: number | null;
  /** 最新の出した版。無ければ null。 */
  publishedVersionNo: number | null;
}

export interface QuestionView {
  questionId: string;
  kind: QuestionKind;
  text: string;
  target: string | null;
  options: string[] | null;
  state: QuestionState;
  answer: string | null;
  source: SourceView | null;
  createdAt: string;
}

export interface MapTaskView {
  taskId: string;
  taskKey: string | null;
  name: string;
  periodStart: string | null;
  periodEnd: string | null;
  sortOrder: number;
  progress: MapProgress;
  progressSource: SourceView | null;
  progressConfidence: Confidence | null;
  seatId: string | null;
}

export interface ProjectState {
  project: ProjectSummary;
  /** そのプロジェクトの種類で使う項目の全部（空の項目も含む）。 */
  items: ItemState[];
  /** 表ごとの有効な行（今年の中身と参考の中身）。 */
  tables: Record<TableKey, RowView[]>;
  documents: DocumentSummary[];
  /** まだ答えが出ていない問い（開いている物と後で）。 */
  questions: QuestionView[];
  mapTasks: MapTaskView[];
}
