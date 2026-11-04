// 束 2 入れると列の共通の型。D1 の表（migrations/0201_intake.sql）と対応する。

/** 入った物の進み具合。画面の言葉は pages.tsx の STATUS_LABEL。 */
export type JobStatus =
  | "received"
  | "reading"
  | "read"
  | "connecting"
  | "done"
  | "attention"
  | "failed"
  | "withdrawn";

/** 入ってきた道。 */
export type Via = "admin" | "space" | "line_direct" | "line_group" | "answer" | "system";

/** 仕事の種類。connect は入った物を繋げる。他は原本の無い仕事（下書き、報告、地図の下書き）。 */
export type JobTask = "connect" | "draft" | "report" | "map_draft";

export type OriginalKind = "photo" | "file" | "text";

export type ReadKind = "general" | "answer_sheet" | "restore";

/** 失敗の種類。jobs.failure に入る。 */
export type FailureKind = "" | "unsupported" | "too_large" | "unreadable" | "refused" | "error" | "connect";

export interface JobRow {
  job_id: string;
  ward_id: string;
  project_id: string | null;
  via: Via;
  read_kind: ReadKind;
  task: JobTask;
  instruction: string;
  ticket_hash: string | null;
  session_id: string | null;
  connect_attempt: number;
  connect_started_at: string | null;
  stop_reason: string;
  discard_count: number;
  discards: string;
  session_deleted_at: string | null;
  sender_label: string;
  ai_matched_at?: string | null;
  ai_match_reason?: string | null;
  account_id: string | null;
  status: JobStatus;
  attempt: number;
  lease_until: string | null;
  failure: FailureKind;
  created_at: string;
  updated_at: string;
  read_at: string | null;
  finished_at: string | null;
  withdrawn_at: string | null;
}

export interface OriginalRow {
  original_id: string;
  ward_id: string;
  job_id: string;
  position: number;
  kind: OriginalKind;
  content_hash: string;
  media_type: string;
  filename: string;
  byte_size: number;
  r2_path: string | null;
  received_at: string;
  withdrawn_at: string | null;
}

/** ExecutionContext のうち、裏で動かすのに使う部分。 */
export type Waitable = Pick<ExecutionContext, "waitUntil">;
