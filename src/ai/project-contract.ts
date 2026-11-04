// 束 3 の src/project/api.ts への口の型。束 3 の最初の commit が main に入ったら、実装を project-binding.ts で本物に替える。
// 手は五つのまま増やさない。下書きと地図の下書きも「差分を書く」の種類（kind）として渡す。
import type { Env } from "../env";

export type ChangeKind = "item" | "row" | "decision" | "conflict" | "map_task" | "draft" | "map_draft";
export type Confidence = "high" | "medium" | "low";

export interface OpenProject {
  projectId: string;
  title: string;
  kind: string;
  year: number | null;
}

/** 札から割り出した、書く先と出どころの文脈。引数のプロジェクト ID は信じず、必ずここから来る。 */
export interface WriteContext {
  wardId: string;
  projectId: string;
  jobId: string;
  /** 包みの版（差分の重複を弾く印の材料） */
  packVersion: string;
  agentVersion: number | null;
}

export interface ChangeInput {
  kind: ChangeKind;
  /** 出どころの原本。item、row、decision、map_task は実在する物だけが来る（書く手が検査済み） */
  originalId: string | null;
  /** 元の箇所（ページ、行、セル） */
  locator: string;
  /** 資料の年（読み取りの document_year）。今年の中身になるか参考になるかを、束 3 がこれと出どころから決める */
  year: number | null;
  /** 書く対象。項目の名前、表と相手、地図の仕事の名前、文書の種類など */
  target: string;
  /** 種類ごとの中身。束 3 が形を決めて検査する */
  data: unknown;
  confidence: Confidence;
}

export interface QuestionInput {
  /** unreadable は読めなかった所、decide は決めてほしい物、map_gap は地図に足りない物 */
  kind: "unreadable" | "decide" | "map_gap";
  target: string;
  text: string;
  originalId: string | null;
  locator: string;
  options: string[];
}

export interface ProjectApi {
  listOpenProjects(env: Env, wardId: string): Promise<OpenProject[]>;
  getProjectState(env: Env, wardId: string, projectId: string): Promise<unknown>;
  applyChange(env: Env, ctx: WriteContext, change: ChangeInput): Promise<{ status: string; note?: string }>;
  addQuestion(env: Env, ctx: WriteContext, question: QuestionInput): Promise<{ status: string; note?: string }>;
}
