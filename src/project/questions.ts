// 問いを書く（束 2 の MCP の手「問いを書く」と、役員画面が呼ぶ）。設計書 3.1、5.4。
// 問いは一つの一覧（読めなかった所、今年決めること、地図の空き、食い違い、取り込めなかった変更）に並ぶ。
// 役員は「答える」「分からない」「後で」から選び、答えなくても配るのを止めない。
import { newId, nowIso } from "../core/ids";
import { checkSourceShape, normalizeSource } from "./source";
import type { AddQuestionResult, ApplyOptions, QuestionInput } from "./types";
import { dedupeKeyOf, hashOf, stableStringify } from "./util";

/** 書く手が使える問いの種類。取り込めなかった変更（discarded）は Workers が作る。 */
const WRITABLE_KINDS: readonly string[] = ["unreadable", "decide", "map_gap", "conflict"];

const MAX_TEXT = 500;
const MAX_OPTIONS = 6;

/**
 * 問いを書く。重複を弾く印は差分と同じ作り（原本の ID、包みの版、手の種類、問いの文）で、
 * 同じ問いは二度並ばない。同じ印で kind、target、options、出どころが違えば受けない。
 * AI からは reuseOpenText を指定し、原本をまたいで未回答の同じ文をまとめる。
 */
export async function addQuestion(
  db: D1Database,
  wardId: string,
  projectId: string,
  input: QuestionInput,
  options: Pick<ApplyOptions, "verifyOriginal"> & { reuseOpenText?: boolean } = {},
): Promise<AddQuestionResult> {
  const project = await db
    .prepare("SELECT closed_at FROM projects WHERE ward_id = ? AND project_id = ?")
    .bind(wardId, projectId)
    .first<{ closed_at: string | null }>();
  if (!project) return { status: "rejected", reason: "no_project" };
  if (project.closed_at) return { status: "rejected", reason: "closed" };

  const text = typeof input.text === "string" ? input.text.trim() : "";
  if (text === "" || text.length > MAX_TEXT) return { status: "rejected", reason: "bad_input", detail: "質問の文が空か長すぎます" };
  if (!WRITABLE_KINDS.includes(input.kind)) {
    return { status: "rejected", reason: "bad_input", detail: "質問の種類が合いません" };
  }
  if (typeof input.packVersion !== "string" || input.packVersion === "") {
    return { status: "rejected", reason: "bad_input", detail: "読み取った内容を確かめられませんでした" };
  }
  if (
    input.options !== undefined &&
    (!Array.isArray(input.options) ||
      input.options.length > MAX_OPTIONS ||
      input.options.some((o) => typeof o !== "string" || o.trim() === "" || o.length > MAX_TEXT))
  ) {
    return { status: "rejected", reason: "bad_input", detail: "選べるものの形が合いません" };
  }
  if (input.target !== undefined && (typeof input.target !== "string" || input.target.length > 200)) {
    return { status: "rejected", reason: "bad_input", detail: "質問の対象が合いません" };
  }

  let source = undefined;
  if (input.source) {
    const shape = checkSourceShape(input.source);
    if (!shape.ok) return { status: "rejected", reason: "bad_source", detail: shape.reason };
    if (input.source.kind === "original" && options.verifyOriginal && !(await options.verifyOriginal(input.source.ref as string))) {
      return { status: "rejected", reason: "bad_source", detail: "出どころの元の資料が見つかりません" };
    }
    source = normalizeSource(input.source);
  }

  if (options.reuseOpenText) {
    const open = await db.prepare("SELECT question_id, text FROM project_questions WHERE ward_id = ? AND project_id = ? AND state IN ('open', 'later') ORDER BY created_at, question_id")
      .bind(wardId, projectId).all<{ question_id: string; text: string }>();
    const same = open.results.find((question) => question.text.trim() === text);
    if (same) return { status: "same", questionId: same.question_id };
  }

  const questionId = newId();
  // AI の問いは未回答の文でまとめる。答えた後には同じ入力からでも新しく作れる。
  const ref = options.reuseOpenText ? questionId : source?.ref ?? (source ? source.kind : `none:${input.requestId ?? ""}`);
  const dedupeKey = await dedupeKeyOf({ ref, packVersion: input.packVersion, hand: "question", target: text });
  // 保存した形（kind, ref, locator, year）で比べる
  const contentHash = await hashOf({
    kind: input.kind,
    text,
    target: input.target ?? null,
    options: input.options ?? null,
    source: source ? { kind: source.kind, ref: source.ref, locator: source.locator, year: source.year } : null,
  });

  const existing = options.reuseOpenText ? null : await db
    .prepare("SELECT question_id, kind, text, target, detail, source_kind, source_ref, source_locator, source_year FROM project_questions WHERE ward_id = ? AND project_id = ? AND dedupe_key = ?")
    .bind(wardId, projectId, dedupeKey)
    .first<{
      question_id: string;
      kind: string;
      text: string;
      target: string | null;
      detail: string | null;
      source_kind: string | null;
      source_ref: string | null;
      source_locator: string | null;
      source_year: number | null;
    }>();
  if (existing) {
    const detail = existing.detail ? (JSON.parse(existing.detail) as { options?: string[] }) : null;
    const existingSource = existing.source_kind
      ? { kind: existing.source_kind, ref: existing.source_ref ?? undefined, locator: existing.source_locator ?? undefined, year: existing.source_year ?? undefined }
      : null;
    const existingHash = await hashOf({
      kind: existing.kind,
      text: existing.text,
      target: existing.target,
      options: detail?.options ?? null,
      source: existingSource,
    });
    return existingHash === contentHash
      ? { status: "same", questionId: existing.question_id }
      : { status: "rejected", reason: "key_reused" };
  }

  await db
    .prepare(
      `INSERT INTO project_questions
         (question_id, ward_id, project_id, kind, text, target, detail, state, source_kind, source_ref, source_locator, source_year,
          pack_version, dedupe_key, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      questionId,
      wardId,
      projectId,
      input.kind,
      text,
      input.target ?? null,
      input.options ? stableStringify({ options: input.options }) : null,
      source?.kind ?? null,
      source?.ref ?? null,
      source?.locator ?? null,
      source?.year ?? null,
      input.packVersion,
      dedupeKey,
      nowIso(),
    )
    .run();
  return { status: "added", questionId };
}
