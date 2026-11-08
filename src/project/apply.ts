import { projectFeatures } from "./task-features";
// 差分の適用（設計書 5.4 の規則）。束 2 の MCP の手「差分を書く」と、役員画面の直しが呼ぶ。
//
// 守る規則:
// - 出どころの無い差分、実在しない原本の差分は捨てる。捨てたことは問いの一覧（取り込めなかった変更）に出る。
// - 重複を弾く印（原本の ID、包みの版、手の種類、書く対象）が同じなら、二度目は保存した結果をそのまま返す。
//   同じ印で中身が違えば受けない（key_reused）。
// - 今年の中身か参考の中身かは、出どころから決める（呼ぶ側に選ばせない）。
// - 今年の中身が既にある項目に違う中身が来たら、上書きせず食い違いとして並べる。人の入力は役員の判断なので上書きする。
//   AI の案は、人や資料の決めた中身を上書きしない。
// - 表の行は、同じ相手（照合の鍵）に当たれば更新、当たらなければ追加。曖昧な時は保留して問いに並べる。
// - 文書は、頼っている項目や表が変わると古い印が付く。出した物はそのまま残る。
//
// 書き込みは db.batch（一つの取引）で行う。プロジェクトの中の差分は Workers が一つずつ送る前提（設計書 5.12）。
import { newId, nowIso } from "../core/ids";
import { eventPeriodText, parseEventDay } from "../core/time";
import { eventDayStatements, getProjectState } from "./state";
import { materialExemptionQuestions } from "../rota/material-exemptions";
import {
  CONFIDENCES,
  DOCUMENT_DEPENDENCIES,
  DOCUMENT_KINDS,
  DOCUMENT_KIND_LABEL,
  ITEM_LABEL,
  ITEM_SCREEN_LABEL,
  TABLES,
  cleanRowData,
  displayFieldValue,
  isItemKey,
  isTableKey,
  normalizeKey,
  rowDisplayName,
  rowMatchKey,
  type Confidence,
  type DocumentKind,
  type ItemKey,
  type QuestionKind,
  type RowData,
  type Source,
  type TableKey,
} from "./model";
import { checkSourceShape, normalizeSource, placeSource, markReferenceSource } from "./source";
import type { ApplyOptions, ApplyResult, ChangeInput, ItemChange, MapTaskChange, RowChange } from "./types";
import { dedupeKeyOf, hashOf, quote, sameText, stableStringify } from "./util";
import { compareOriginals, comparisonText, pairCaptions } from "../ai/compare-originals";

type Db = D1Database;

interface ProjectRow {
  kind: string;
  year: number;
  closed_at: string | null;
  state_version: number;
}

/** 問いの追加（差分に付いて並ぶ物）。 */
export interface NewQuestion {
  kind: QuestionKind;
  text: string;
  target: string | null;
  detail: Record<string, unknown> | null;
  /** 差分の重複を弾く印に足す語。同じ差分から出る問いの中で一意にする。 */
  suffix: string;
  source?: Source | undefined;
}

interface Plan {
  status: "applied" | "same" | "kept" | "conflict" | "held" | "dropped";
  reason?: string;
  /** 差分の記録の後に実行する書き込み。 */
  statements: D1PreparedStatement[];
  questions: NewQuestion[];
  /** 状態の版を上げるか（applied のときだけ上がる）。 */
  bump: boolean;
  /** 古い印を付ける文書の種類。 */
  staleKinds: DocumentKind[];
  conflictFields?: string[];
  existingQuestionIds?: string[];
}

interface Ctx {
  db: Db;
  wardId: string;
  projectId: string;
  project: ProjectRow;
  changeId: string;
  now: string;
  dedupeKey: string;
  confidence: Confidence;
  source: Source;
  options: ApplyOptions;
}

const CHANGE_KINDS: readonly string[] = ["item", "row", "conflict", "stale", "map_task"];

/** MCP から来た物は型を信じない。object でなければ空の object として扱う。 */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

const MAX_VALUE = 2000;
const MAX_PACK = 100;

// ---- 検査 ----

type Checked<T> = { ok: true; value: T } | { ok: false; reason: string };

interface Normalized {
  change: ChangeInput;
  source: Source;
  target: string;
  /** 表の行の、検査を通した列。 */
  rowData?: RowData;
}

async function verifySource(db: Db, wardId: string, source: Source, options: ApplyOptions, allowUnknownProposalYear = false): Promise<string | null> {
  const shape = checkSourceShape(source, allowUnknownProposalYear);
  if (!shape.ok) return shape.reason;
  if ((source.kind === "original" || (source.kind === "ai_proposal" && source.ref)) && options.verifyOriginal) {
    if (!(await options.verifyOriginal(source.ref as string))) return "出どころの元の資料が見つかりません";
  }
  if (source.kind === "person") {
    const account = await db
      .prepare("SELECT 1 AS ok FROM accounts WHERE ward_id = ? AND account_id = ? AND removed_at IS NULL")
      .bind(wardId, source.accountId as string)
      .first();
    if (!account) return "入力した人が見つかりません";
  }
  return null;
}

async function checkChange(
  db: Db,
  wardId: string,
  project: ProjectRow & { kind: string },
  change: ChangeInput,
  options: ApplyOptions,
): Promise<Checked<Normalized>> {
  if (typeof change !== "object" || change === null) return { ok: false, reason: "変更の形が合いません" };
  if (typeof change.packVersion !== "string" || change.packVersion === "" || change.packVersion.length > MAX_PACK) {
    return { ok: false, reason: "読み取った内容を確かめられませんでした" };
  }
  if (!(CONFIDENCES as readonly string[]).includes(change.confidence)) return { ok: false, reason: "確かさが合いません" };
  const sourceReason = await verifySource(db, wardId, change.source, options, change.kind === "row" && change.table === "duties");
  if (sourceReason) return { ok: false, reason: sourceReason };
  let source = await markReferenceSource(db, wardId, normalizeSource(change.source));
  if (source.kind === "original" && change.kind === "item") {
    const original = await db.prepare("SELECT filename FROM originals WHERE ward_id = ? AND original_id = ? AND withdrawn_at IS NULL")
      .bind(wardId, source.ref).first<{ filename: string }>();
    // 保存日や届いた日ではなく、資料名の年度と、日時・締切そのものに書かれた年を見る。
    const namedYear = original?.filename.normalize("NFKC").match(/((?:19|20|21)\d{2})年度?/);
    const datedDay = ["date_time", "due"].includes(change.itemKey) && typeof change.value === "string"
      ? parseEventDay(change.value, project.year) : null;
    const pastYear = [source.year, namedYear ? Number(namedYear[1]) : undefined, datedDay ? Number(datedDay.slice(0, 4)) : undefined]
      .find((year) => year !== undefined && year < project.year);
    if (pastYear !== undefined) source = { ...source, year: pastYear, qr: false };
    else if (source.year === undefined) source = { ...source, qr: false };
  }
  if (source.reference && change.kind !== "item" && change.kind !== "row") {
    return { ok: false, reason: "参考資料から今年のやることは変えません" };
  }

  switch (change.kind) {
    case "item": {
      if (!isItemKey(change.itemKey)) return { ok: false, reason: "項目の名前が合いません" };
      if (typeof change.value !== "string" || change.value.trim() === "") return { ok: false, reason: "項目の中身が空です" };
      if (change.value.length > MAX_VALUE) return { ok: false, reason: "項目の中身が長すぎます" };
      return { ok: true, value: { change, source, target: change.itemKey } };
    }
    case "row": {
      if (!isTableKey(change.table)) return { ok: false, reason: "表の名前が合いません" };
      const cleaned = cleanRowData(change.table, change.data);
      if (!cleaned.ok) return { ok: false, reason: cleaned.reason };
      return {
        ok: true,
        value: { change, source, target: `${change.table}:${rowMatchKey(change.table, cleaned.data)}`, rowData: cleaned.data },
      };
    }
    case "conflict": {
      if (typeof change.target !== "string" || change.target === "") return { ok: false, reason: "食い違いの対象が分かりません" };
      if (typeof change.summary !== "string" || change.summary.trim() === "") return { ok: false, reason: "食い違いの説明が空です" };
      if (
        !Array.isArray(change.options) ||
        change.options.length < 2 ||
        change.options.length > 6 ||
        change.options.some((o) => typeof o?.value !== "string" || o.value.trim() === "" || o.value.length > MAX_VALUE)
      ) {
        return { ok: false, reason: "食い違いの中身が二つ以上要ります" };
      }
      for (const option of change.options) {
        if (option.source) {
          const reason = await verifySource(db, wardId, option.source, options);
          if (reason) return { ok: false, reason };
        }
      }
      return { ok: true, value: { change, source, target: change.target } };
    }
    case "stale": {
      if (
        !Array.isArray(change.documents) ||
        change.documents.length === 0 ||
        change.documents.some((d) => !(DOCUMENT_KINDS as readonly string[]).includes(d))
      ) {
        return { ok: false, reason: "古くなる文書の種類が合いません" };
      }
      if (typeof change.reason !== "string" || change.reason.trim() === "") return { ok: false, reason: "古くなる理由が空です" };
      return { ok: true, value: { change, source, target: [...new Set(change.documents)].sort().join(",") } };
    }
    case "map_task": {
      if (typeof change.taskKey !== "string" || change.taskKey === "") return { ok: false, reason: "やることが分かりません" };
      if (change.progress !== "started" && change.progress !== "done") return { ok: false, reason: "仕事の進み方が合いません" };
      return { ok: true, value: { change, source, target: change.taskKey } };
    }
    default:
      return { ok: false, reason: "変更の種類が合いません" };
  }
}

// ---- 書き込みの部品 ----

function sourceBinds(source: Source): [string, string | null, string | null, number | null] {
  return [source.kind, source.ref ?? null, source.locator ?? null, source.year ?? null];
}

function insertChangeStatement(
  ctx: Ctx,
  n: Normalized,
  known: boolean,
  status: Plan["status"],
  reason: string | null,
  stored: object,
  payloadHash: string,
  dedupeKey: string,
  bump: boolean,
): D1PreparedStatement {
  // 形の合わない差分は、出どころも確かさも信用できないので、記録には入れない
  const [kind, ref, locator, year] = known ? sourceBinds(n.source) : [null, null, null, null];
  const raw = asRecord(n.change);
  return ctx.db
    .prepare(
      `INSERT INTO project_changes
         (change_id, ward_id, project_id, kind, target, status, reason, dedupe_key, payload_hash, payload, result, pack_version,
          source_kind, source_ref, source_locator, source_year, confidence, ticket_id, state_version_after, created_at, created_by_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          (SELECT state_version FROM projects WHERE ward_id = ? AND project_id = ?) + ?, ?, ?)`,
    )
    .bind(
      ctx.changeId,
      ctx.wardId,
      ctx.projectId,
      CHANGE_KINDS.includes(raw.kind as string) ? (raw.kind as string) : "unknown",
      n.target,
      status,
      reason,
      dedupeKey,
      payloadHash,
      stableStringify(n.change),
      stableStringify(stored),
      typeof raw.packVersion === "string" ? raw.packVersion : "",
      kind,
      ref,
      locator,
      year,
      known ? (raw.confidence as string) : null,
      typeof raw.ticketId === "string" ? raw.ticketId : null,
      ctx.wardId,
      ctx.projectId,
      bump ? 1 : 0,
      ctx.now,
      known ? (n.source.kind === "person" ? n.source.accountId ?? null : ctx.options.actorAccountId ?? null) : null,
    );
}

function insertQuestionStatement(ctx: Ctx, q: NewQuestion, id: string, packVersion: string): D1PreparedStatement {
  const source = q.source;
  return ctx.db
    .prepare(
      `INSERT INTO project_questions
         (question_id, ward_id, project_id, kind, text, target, detail, state, source_kind, source_ref, source_locator, source_year,
          pack_version, dedupe_key, change_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id,
      ctx.wardId,
      ctx.projectId,
      q.kind,
      q.text,
      q.target,
      q.detail ? stableStringify(q.detail) : null,
      source?.kind ?? null,
      source?.ref ?? null,
      source?.locator ?? null,
      source?.year ?? null,
      packVersion,
      `${ctx.dedupeKey}:${q.suffix}`,
      ctx.changeId,
      ctx.now,
    );
}

function lowConfidenceQuestion(ctx: Ctx, text: string, target: string): NewQuestion {
  return { kind: "unreadable", text, target, detail: null, suffix: "low", source: ctx.source };
}

/** 頼っている文書のうち、まだ古くなっていない物の種類。 */
async function documentsDependingOn(
  ctx: Ctx,
  dependency: { item?: ItemKey; table?: TableKey },
): Promise<DocumentKind[]> {
  const kinds = DOCUMENT_KINDS.filter((kind) => {
    const dep = DOCUMENT_DEPENDENCIES[kind];
    return (dependency.item && dep.items.includes(dependency.item)) || (dependency.table && dep.tables.includes(dependency.table));
  });
  return existingFreshDocuments(ctx, kinds);
}

async function existingFreshDocuments(ctx: Ctx, kinds: readonly DocumentKind[]): Promise<DocumentKind[]> {
  if (kinds.length === 0) return [];
  const marks = kinds.map(() => "?").join(",");
  const rows = await ctx.db
    .prepare(
      `SELECT DISTINCT kind, document_id FROM documents
       WHERE ward_id = ? AND project_id = ? AND stale_since_version IS NULL AND kind IN (${marks})`,
    )
    .bind(ctx.wardId, ctx.projectId, ...kinds)
    .all<{ kind: DocumentKind; document_id: string }>();
  return rows.results.filter((r) => r.document_id !== ctx.options.publishedDocumentId).map((r) => r.kind);
}

// ---- 項目 ----

interface ValueRow {
  value_id: string;
  content: string;
  source_kind: string;
  source_ref: string | null;
  source_locator: string | null;
  source_year: number | null;
}

function insertValueStatement(
  ctx: Ctx,
  itemKey: ItemKey,
  content: string,
  placement: ReturnType<typeof placeSource>,
  n: Normalized,
): D1PreparedStatement {
  const [kind, ref, locator, year] = sourceBinds(n.source);
  return ctx.db
    .prepare(
      `INSERT INTO project_item_values
         (value_id, ward_id, project_id, item_key, scope, ref_year, content, source_kind, source_ref, source_locator, source_year,
          confidence, change_id, created_at, created_by_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId(),
      ctx.wardId,
      ctx.projectId,
      itemKey,
      placement.scope,
      placement.scope === "reference" ? placement.refYear : null,
      content,
      kind,
      ref,
      locator,
      year,
      ctx.confidence,
      ctx.changeId,
      ctx.now,
      n.source.kind === "person" ? (n.source.accountId ?? null) : null,
    );
}

function supersedeValueStatement(ctx: Ctx, valueId: string): D1PreparedStatement {
  return ctx.db
    .prepare("UPDATE project_item_values SET superseded_at = ? WHERE ward_id = ? AND value_id = ?")
    .bind(ctx.now, ctx.wardId, valueId);
}

/** 同じ原本の読み直し以外は、届いた順で参考を入れ替えない。 */
async function planOriginalConflict(ctx: Ctx, n: Normalized, change: ItemChange, before: ValueRow,
  placement: ReturnType<typeof placeSource>): Promise<Plan | null> {
  if (n.source.kind !== "original" || !n.source.ref || before.source_kind !== "original" || !before.source_ref
    || n.source.ref === before.source_ref) return null;
  const pair = await compareOriginals(ctx.db, ctx.wardId, ctx.projectId, before.source_ref, n.source.ref);
  if (!pair) return null;
  const oldIndex = pair.originals.findIndex((original) => original.original_id === before.source_ref);
  const newIndex = 1 - oldIndex;
  const captions = pairCaptions(pair);
  const oldCaption = captions[oldIndex]!;
  const newCaption = captions[newIndex]!;
  const previousQuestion = await ctx.db.prepare(`SELECT question_id FROM project_questions
    WHERE ward_id = ? AND project_id = ? AND target = ? AND json_extract(detail, '$.comparisonKey') = ? LIMIT 1`)
    .bind(ctx.wardId, ctx.projectId, change.itemKey, pair.key).first();
  if (previousQuestion) return { status: "kept", statements: [], questions: [], bump: false, staleKinds: [] };

  const reference = placement.scope === "reference";
  const times = pair.originals.map((original) => original.document_date ? Date.parse(original.document_date) : NaN);
  const datedNewer = Number.isFinite(times[0]) && Number.isFinite(times[1]) && times[0] !== times[1]
    ? pair.originals[times[0]! > times[1]! ? 0 : 1]!.original_id : null;
  const automatic = reference && datedNewer !== null && datedNewer === pair.result.newer;
  const takeIncoming = reference && pair.result.newer === n.source.ref;
  const chosenCaption = takeIncoming ? newCaption : oldCaption;
  const reason = automatic
    ? `${chosenCaption}を取りました（${pair.result.assessment.replace(/[。]+$/g, "")}）。`
    : `${chosenCaption}をひとまず使います。どちらが最後のものか、役員に聞いています。`;
  const statements: D1PreparedStatement[] = [];
  if (reference) {
    if (takeIncoming) {
      statements.push(supersedeValueStatement(ctx, before.value_id), insertValueStatement(ctx, change.itemKey, change.value.trim(), placement,
        { ...n, source: { ...n.source, locator: `${n.source.locator ?? "全体"}。${reason}` } }));
    } else {
      const locator = `${before.source_locator?.split("。資料を比べた結果：")[0] ?? "全体"}。資料を比べた結果：${reason}`;
      statements.push(ctx.db.prepare("UPDATE project_item_values SET source_locator = ? WHERE ward_id = ? AND project_id = ? AND value_id = ?")
        .bind(locator, ctx.wardId, ctx.projectId, before.value_id));
    }
  }
  const label = ITEM_SCREEN_LABEL[change.itemKey];
  const when = reference ? placement.refYear === ctx.project.year - 1 ? "去年の" : placement.refYear === null ? "年の分からない資料の" : `${placement.refYear}年の` : "今年の";
  const questions: NewQuestion[] = automatic ? [] : [{
    kind: "conflict", target: change.itemKey, suffix: "conflict", source: n.source,
    text: `${when}「${label}」が、二つの資料で違います。${oldCaption}は「${before.content}」、${newCaption}は「${change.value.trim()}」です。`
      + comparisonText(pair) + (reference ? "どちらが最後のものですか。答えるまでも下書きは作れます。" : "今年はどちらの中身にしますか。"),
    detail: { itemKey: change.itemKey, options: [before.content, change.value.trim()], currentValueId: before.value_id,
      changeId: ctx.changeId, comparisonKey: pair.key, ...(reference ? { scope: "reference", refYear: placement.refYear } : {}),
      sources: [{ kind: "original", ref: before.source_ref, locator: before.source_locator ?? "全体", ...(before.source_year ? { year: before.source_year } : {}) }, n.source],
      originals: pair.originals.map((original, index) => ({ originalId: original.original_id, description: captions[index]! })),
    },
  }];
  const hasCurrent = reference && Boolean(await ctx.db.prepare(`SELECT value_id FROM project_item_values
    WHERE ward_id = ? AND project_id = ? AND item_key = ? AND scope = 'current' AND superseded_at IS NULL LIMIT 1`)
    .bind(ctx.wardId, ctx.projectId, change.itemKey).first());
  return { status: takeIncoming ? "applied" : automatic ? "kept" : "conflict", statements, questions, bump: takeIncoming,
    staleKinds: takeIncoming && !hasCurrent ? await documentsDependingOn(ctx, { item: change.itemKey }) : [] };
}

/** 去年の資料についての回答は今年の決定にせず、参考と誰が選んだかだけを残す。nullはこの問いの対象外。 */
export async function answerOriginalReference(db: D1Database, wardId: string, projectId: string, questionId: string,
  accountId: string, answer: string): Promise<boolean | null> {
  const question = await db.prepare(`SELECT detail FROM project_questions
    WHERE ward_id = ? AND project_id = ? AND question_id = ? AND kind = 'conflict' AND state IN ('open', 'later')`)
    .bind(wardId, projectId, questionId).first<{ detail: string | null }>();
  if (!question?.detail) return null;
  const detail = JSON.parse(question.detail) as { scope?: string; refYear?: number | null; itemKey?: string; options?: string[]; sources?: Source[] };
  if (detail.scope !== "reference") return null;
  if (!detail.itemKey || !isItemKey(detail.itemKey) || !Array.isArray(detail.options) || !Array.isArray(detail.sources)
    || !(detail.refYear === null || (typeof detail.refYear === "number" && Number.isInteger(detail.refYear)))) return false;
  const index = detail.options.indexOf(answer);
  const source = detail.sources[index];
  if (index < 0 || source?.kind !== "original" || !source.ref) return false;
  const project = await db.prepare("SELECT kind, year, closed_at, state_version FROM projects WHERE ward_id = ? AND project_id = ?")
    .bind(wardId, projectId).first<ProjectRow>();
  if (!project || project.closed_at) return false;
  if (!(await db.prepare("SELECT account_id FROM accounts WHERE ward_id = ? AND account_id = ? AND removed_at IS NULL")
    .bind(wardId, accountId).first())) return false;
  if (!(await db.prepare("SELECT original_id FROM originals WHERE ward_id = ? AND original_id = ? AND withdrawn_at IS NULL")
    .bind(wardId, source.ref).first())) return false;
  const changeId = newId();
  const now = nowIso();
  const chosen = { ...source, locator: `${source.locator ?? "全体"}。二つの資料を比べ、役員が最後のものとして選びました。` };
  const change: ItemChange = { kind: "item", itemKey: detail.itemKey, value: answer, source: chosen, confidence: "high", packVersion: "reference-answer@1", requestId: questionId };
  const n: Normalized = { change, source: chosen, target: detail.itemKey };
  const ctx: Ctx = { db, wardId, projectId, project, changeId, now, source: chosen, confidence: "high", dedupeKey: `reference-answer:${questionId}`, options: { actorAccountId: accountId } };
  const hasCurrent = await db.prepare(`SELECT value_id FROM project_item_values WHERE ward_id = ? AND project_id = ?
    AND item_key = ? AND scope = 'current' AND superseded_at IS NULL LIMIT 1`).bind(wardId, projectId, detail.itemKey).first();
  const staleKinds = hasCurrent ? [] : await documentsDependingOn(ctx, { item: detail.itemKey });
  const stored: StoredResult = { status: "applied", changeId, staleDocuments: staleKinds, questionIds: [] };
  const fresh = insertValueStatement(ctx, detail.itemKey, answer, { scope: "reference", refYear: detail.refYear }, n);
  await db.batch([
    insertChangeStatement(ctx, n, true, "applied", "役員が最後の資料を選びました。", stored, await hashOf(change), ctx.dedupeKey, true),
    db.prepare(`UPDATE project_item_values SET superseded_at = ? WHERE ward_id = ? AND project_id = ? AND item_key = ?
      AND scope = 'reference' AND ref_year IS ? AND superseded_at IS NULL`).bind(now, wardId, projectId, detail.itemKey, detail.refYear),
    fresh,
    db.prepare(`UPDATE project_item_values SET created_by_account_id = ? WHERE ward_id = ? AND project_id = ? AND change_id = ?`)
      .bind(accountId, wardId, projectId, changeId),
    db.prepare("UPDATE projects SET state_version = state_version + 1 WHERE ward_id = ? AND project_id = ?").bind(wardId, projectId),
    ...staleKinds.map((kind) => db.prepare(`UPDATE documents SET stale_since_version =
      (SELECT state_version FROM projects WHERE ward_id = ? AND project_id = ?)
      WHERE ward_id = ? AND project_id = ? AND kind = ? AND stale_since_version IS NULL`)
      .bind(wardId, projectId, wardId, projectId, kind)),
    db.prepare(`UPDATE project_questions SET state = 'answered', answer = ?, answered_at = ?, answered_by_account_id = ?
      WHERE ward_id = ? AND project_id = ? AND question_id = ? AND state IN ('open', 'later')`)
      .bind(answer, now, accountId, wardId, projectId, questionId),
  ]);
  return true;
}

async function planItem(ctx: Ctx, n: Normalized, change: ItemChange): Promise<Plan> {
  const plan = await planItemValue(ctx, n, change);
  // 過去・年不明の参考とAIの案は行事の日にしない。食い違う項目の中身も採らない。
  if (change.itemKey !== "date_time" || n.source.kind !== "original" || placeSource(n.source, ctx.project.year).scope !== "current"
    || (plan.status !== "applied" && plan.status !== "same")) return plan;
  const day = parseEventDay(change.value, ctx.project.year);
  const endDay = parseEventDay(change.value, ctx.project.year, "end");
  if (!day || !endDay) return plan;
  const state = await getProjectState(ctx.db, ctx.wardId, ctx.projectId);
  if (!state) return plan;
  const oldDay = state.project.deadlines.event_day;
  if (oldDay && (oldDay !== day || (state.project.deadlines.event_end ?? oldDay) !== endDay)) {
    const oldText = `${Number(oldDay.slice(0, 4))}年${eventPeriodText(oldDay, state.project.deadlines.event_end ?? oldDay)}`;
    return {
      status: "conflict", statements: [], bump: false, staleKinds: [],
      questions: [{
        kind: "conflict",
        text: `行事の日が食い違っています。今は「${oldText}」です。届いたものには「${quote(change.value.trim())}」とあります。どちらにしますか。`,
        target: "date_time",
        detail: { itemKey: "date_time", options: [oldText, change.value.trim()], changeId: ctx.changeId },
        suffix: "conflict", source: n.source,
      }],
    };
  }
  if (oldDay) return plan;
  return {
    ...plan, status: "applied", bump: true,
    statements: [...plan.statements, ...eventDayStatements(ctx.db, ctx.wardId, ctx.projectId, state, day, null, ctx.now, true, endDay)],
  };
}

async function planItemValue(ctx: Ctx, n: Normalized, change: ItemChange): Promise<Plan> {
  const content = change.value.trim();
  const label = ITEM_SCREEN_LABEL[change.itemKey];
  const placement = placeSource(n.source, ctx.project.year);
  const active = await ctx.db
    .prepare(
      `SELECT value_id, content, source_kind, source_ref, source_locator, source_year, scope, ref_year
       FROM project_item_values WHERE ward_id = ? AND project_id = ? AND item_key = ? AND superseded_at IS NULL`,
    )
    .bind(ctx.wardId, ctx.projectId, change.itemKey)
    .all<ValueRow & { scope: string; ref_year: number | null }>();

  // 資料の組ごとに聞き直さず、同じ年・同じ項目の問いへ違う値を足す。
  if (n.source.kind === "original") {
    const pending = await ctx.db.prepare(`SELECT question_id, text, detail FROM project_questions
      WHERE ward_id = ? AND project_id = ? AND kind = 'conflict' AND target = ? AND state IN ('open', 'later')
        AND json_extract(detail, '$.itemKey') = ? AND json_extract(detail, '$.documentKind') IS NULL`)
      .bind(ctx.wardId, ctx.projectId, change.itemKey, change.itemKey).all<{ question_id: string; text: string; detail: string }>();
    for (const question of pending.results) {
      const detail = JSON.parse(question.detail) as { scope?: string; refYear?: number | null; options: string[]; sources?: Source[] };
      const scope = detail.scope ?? "current";
      if (scope !== placement.scope || (placement.scope === "reference" && (detail.refYear ?? null) !== placement.refYear)) continue;
      const added = !detail.options.some((option) => sameText(option, content));
      if (added) {
        detail.options.push(content);
        detail.sources = [...(detail.sources ?? detail.options.slice(0, -1).map(() => n.source)), n.source];
      }
      const text = added ? `${question.text}ほかの資料には「${content}」とあります。` : question.text;
      const statements = [ctx.db.prepare(`UPDATE project_questions SET text = ?, detail = ?
        WHERE ward_id = ? AND project_id = ? AND question_id = ? AND state IN ('open', 'later')`)
        .bind(text, JSON.stringify(detail), ctx.wardId, ctx.projectId, question.question_id)];
      const reread = placement.scope === "reference" ? active.results.find((row) => row.scope === "reference"
        && row.ref_year === placement.refYear && row.source_ref === n.source.ref && !sameText(row.content, content)) : undefined;
      if (reread) statements.push(supersedeValueStatement(ctx, reread.value_id), insertValueStatement(ctx, change.itemKey, content, placement, n));
      return { status: "conflict", statements, questions: [], existingQuestionIds: [question.question_id], bump: !!reread,
        staleKinds: reread && !active.results.some((row) => row.scope === "current") ? await documentsDependingOn(ctx, { item: change.itemKey }) : [] };
    }
  }

  const lowQuestions = (): NewQuestion[] =>
    ctx.confidence === "low"
      ? [lowConfidenceQuestion(ctx, `「${label}」を「${quote(content)}」と読みましたが、自信がありません。合っていますか。`, change.itemKey)]
      : [];

  if (placement.scope === "reference") {
    const current = active.results.find((r) => r.scope === "current");
    const unknownYear = placement.refYear === null;
    const questions: NewQuestion[] = unknownYear
      ? change.maybeThisYear === true && current && !sameText(current.content, content)
        ? [{
            kind: "conflict",
            text: `「${label}」が食い違っています。今は「${quote(current.content)}」です。年の書かれていない資料には「${quote(content)}」とあります。どちらにしますか。`,
            target: change.itemKey,
            detail: { itemKey: change.itemKey, options: [current.content, content], currentValueId: current.value_id, changeId: ctx.changeId },
            suffix: "conflict",
            source: n.source,
          }]
        : []
      : lowQuestions();
    // 同じ資料の読み直しだけは入れ替える。別の資料の違いは中身全体を比べる。
    const sameYear = active.results.find((r) => r.scope === "reference" && (r.ref_year ?? 0) === (placement.refYear ?? 0));
    if (sameYear && sameText(sameYear.content, content)) {
      return { status: unknownYear && questions.length ? "conflict" : "same", statements: [], questions: unknownYear ? questions : [], bump: false, staleKinds: [] };
    }
    if (sameYear && sameYear.source_ref !== n.source.ref) {
      const compared = await planOriginalConflict(ctx, n, change, sameYear, placement);
      if (compared) return compared;
      // 元の資料が消されているなど、比べられないときも黙って上書きしない。
      return { status: "kept", statements: [], questions: [], bump: false, staleKinds: [] };
    }
    const statements: D1PreparedStatement[] = [];
    if (sameYear) statements.push(supersedeValueStatement(ctx, sameYear.value_id));
    statements.push(insertValueStatement(ctx, change.itemKey, content, placement, n));
    const hasCurrent = active.results.some((r) => r.scope === "current");
    // 今年の中身が無い間、下書きは参考から取るので、参考が変われば頼っている文書が古くなる
    const staleKinds = hasCurrent ? [] : await documentsDependingOn(ctx, { item: change.itemKey });
    return { status: "applied", statements, questions, bump: true, staleKinds };
  }

  const current = active.results.find((r) => r.scope === "current");
  if (!current) {
    return {
      status: "applied",
      statements: [insertValueStatement(ctx, change.itemKey, content, placement, n)],
      questions: lowQuestions(),
      bump: true,
      staleKinds: await documentsDependingOn(ctx, { item: change.itemKey }),
    };
  }
  if (sameText(current.content, content)) {
    return { status: "same", statements: [], questions: [], bump: false, staleKinds: [] };
  }

  const incoming = n.source.kind;
  const replace = async (): Promise<Plan> => ({
    status: "applied",
    statements: [supersedeValueStatement(ctx, current.value_id), insertValueStatement(ctx, change.itemKey, content, placement, n)],
    questions: lowQuestions(),
    bump: true,
    staleKinds: await documentsDependingOn(ctx, { item: change.itemKey }),
  });

  // 人の入力は役員の判断なので、今ある中身に代わる
  if (incoming === "person") return replace();
  if (incoming === "ai_proposal") {
    // AI の案は、決まった中身を上書きしない。案同士なら新しい案に入れ替える
    return current.source_kind === "ai_proposal"
      ? replace()
      : { status: "kept", statements: [], questions: [], bump: false, staleKinds: [] };
  }
  // 資料や Web の回答の中身。今ある中身が案なら入れ替え、決まった中身なら食い違いとして並べる
  if (current.source_kind === "ai_proposal" && !ctx.options.compareCurrent) return replace();
  const compared = await planOriginalConflict(ctx, n, change, current, placement);
  if (compared) return compared;
  return {
    status: "conflict",
    statements: [],
    bump: false,
    staleKinds: [],
    questions: [
      {
        kind: "conflict",
        text: `「${label}」が食い違っています。今ある「${quote(current.content)}」と、届いたものの「${quote(content)}」のどちらにしますか。`,
        target: change.itemKey,
        detail: {
          itemKey: change.itemKey,
          options: [current.content, content],
          currentValueId: current.value_id,
          changeId: ctx.changeId,
        },
        suffix: "conflict",
        source: n.source,
      },
    ],
  };
}

// ---- 表の行 ----

interface RowRecord {
  row_id: string;
  match_key: string;
  data: string;
  person_fields: string;
  source_kind: string;
}

/** 二つの照合の鍵が「似ている」か。違う部分が一つだけで、そこが一方を含む（または片方が空）の時。 */
function isNearKey(a: string, b: string): boolean {
  const pa = a.split("|");
  const pb = b.split("|");
  if (pa.length !== pb.length) return false;
  const differing = pa.map((part, i) => [part, pb[i] ?? ""] as const).filter(([x, y]) => x !== y);
  if (differing.length !== 1) return false;
  const [x, y] = differing[0] as readonly [string, string];
  if (x === "" || y === "") return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 2 && long.includes(short);
}

/** 鍵の違いが、片方の空の列だけか（日付の無い行と有る行など）。 */
function differsOnlyByBlank(a: string, b: string): boolean {
  const pa = a.split("|");
  const pb = b.split("|");
  if (pa.length !== pb.length) return false;
  const differing = pa.map((part, i) => [part, pb[i] ?? ""] as const).filter(([x, y]) => x !== y);
  return differing.length === 1 && differing.some(([x, y]) => x === "" || y === "");
}

function sameFieldValue(a: string | number, b: string | number): boolean {
  return typeof a === "number" || typeof b === "number" ? a === b : normalizeKey(a) === normalizeKey(b);
}

async function planRow(ctx: Ctx, n: Normalized, change: RowChange): Promise<Plan> {
  const table = change.table;
  const def = TABLES[table];
  const data = n.rowData as RowData;
  const exemptionText = String(data.what ?? "");
  // 資料の免除は運営上の判断を聞く。理由を共用の記録へ流さない。
  if (table === "decisions" && n.source.kind !== "person" && /免除/.test(exemptionText) &&
    (/当番/.test(exemptionText) || ((await projectFeatures(ctx.db, ctx.wardId, ctx.projectId)).rota && !/会費|参加費|負担金/.test(exemptionText)))) {
    return { status: "held", statements: [], bump: false, staleKinds: [],
      questions: await materialExemptionQuestions(ctx.db, ctx.wardId, ctx.projectId, ctx.project.year, exemptionText, n.source) };
  }
  const matchKey = rowMatchKey(table, data);
  const placement = placeSource(n.source, ctx.project.year);
  const refYear = placement.scope === "reference" ? placement.refYear : null;
  const name = rowDisplayName(table, data);
  const isPerson = n.source.kind === "person";

  const existing = await ctx.db
    .prepare(
      `SELECT row_id, match_key, data, person_fields, source_kind FROM project_rows
       WHERE ward_id = ? AND project_id = ? AND table_key = ? AND scope = ? AND COALESCE(ref_year, 0) = COALESCE(?, 0) AND removed_at IS NULL`,
    )
    .bind(ctx.wardId, ctx.projectId, table, placement.scope, refYear)
    .all<RowRecord>();

  const staleKinds = () => documentsDependingOn(ctx, { table });
  // 行ごとの読み違いの確かめは頼まない（前提 1）。確かさは行に残る
  // 空の列だけが違う相手が一つなら同じ相手として扱う。読み取りの書き方の揺れを問いにしない（前提 1）
  const blankOnly = existing.results.filter((r) => differsOnlyByBlank(r.match_key, matchKey));
  const exact = existing.results.find((r) => r.match_key === matchKey) ?? (blankOnly.length === 1 ? blankOnly[0] : undefined);
  if (exact) {
    const old = JSON.parse(exact.data) as RowData;
    const personFields = new Set(JSON.parse(exact.person_fields) as string[]);
    const next: RowData = { ...old };
    const changed: string[] = [];
    const conflicts: { field: string; current: string | number; incoming: string | number }[] = [];
    let kept = false;

    for (const [field, value] of Object.entries(data)) {
      const before = old[field];
      if (before === undefined) {
        next[field] = value;
        changed.push(field);
      } else if (sameFieldValue(before, value)) {
        continue;
      } else if (isPerson) {
        next[field] = value;
        changed.push(field);
      } else if (n.source.kind === "ai_proposal") {
        // AI の案は空の列を埋めるだけ。案が入れた列なら新しい案に入れ替える
        if (exact.source_kind === "ai_proposal" && !personFields.has(field)) {
          next[field] = value;
          changed.push(field);
        } else {
          kept = true;
        }
      } else if (personFields.has(field) || ctx.options.compareCurrent) {
        conflicts.push({ field, current: before, incoming: value });
      } else {
        next[field] = value;
        changed.push(field);
      }
    }
    if (isPerson) for (const field of changed) personFields.add(field);

    const questions: NewQuestion[] = conflicts.map((c) => ({
      kind: "conflict" as const,
      text: `「${def.label}」の「${quote(name)}」の「${def.fields[c.field]?.label ?? c.field}」が食い違っています。今ある「${displayFieldValue(table, c.field, c.current)}」と、届いたものの「${displayFieldValue(table, c.field, c.incoming)}」のどちらにしますか。`,
      target: `${table}:${matchKey}`,
      detail: {
        table,
        rowId: exact.row_id,
        field: c.field,
        options: [displayFieldValue(table, c.field, c.current), displayFieldValue(table, c.field, c.incoming)],
        values: [c.current, c.incoming],
        changeId: ctx.changeId,
      },
      suffix: `conflict:${c.field}`,
      source: n.source,
    }));

    if (changed.length === 0) {
      if (conflicts.length > 0) {
        return { status: "conflict", statements: [], questions, bump: false, staleKinds: [], conflictFields: conflicts.map((c) => c.field) };
      }
      return { status: kept ? "kept" : "same", statements: [], questions: [], bump: false, staleKinds: [] };
    }
    const [kind, ref, locator, year] = sourceBinds(n.source);
    const update = ctx.db
      .prepare(
        `UPDATE project_rows SET data = ?, person_fields = ?, source_kind = ?, source_ref = ?, source_locator = ?, source_year = ?,
           confidence = ?, change_id = ?, updated_at = ? WHERE ward_id = ? AND row_id = ?`,
      )
      .bind(
        stableStringify(next),
        stableStringify([...personFields].sort()),
        kind,
        ref,
        locator,
        year,
        ctx.confidence,
        ctx.changeId,
        ctx.now,
        ctx.wardId,
        exact.row_id,
      );
    const result: Plan = {
      status: "applied",
      statements: [update],
      questions: [...questions],
      bump: true,
      staleKinds: await staleKinds(),
    };
    if (conflicts.length > 0) result.conflictFields = conflicts.map((c) => c.field);
    return result;
  }

  // 同じ相手が見つからない。似た行があれば、同じ相手かを問いに並べて保留する（人が入れた行は追加する）
  if (!isPerson) {
    const near = existing.results.filter((r) => isNearKey(r.match_key, matchKey));
    if (near.length > 0) {
      const labels = near.map((r) => rowDisplayName(table, JSON.parse(r.data) as RowData));
      return {
        status: "held",
        statements: [],
        bump: false,
        staleKinds: [],
        questions: [
          {
            kind: "conflict",
            text: `「${def.label}」に「${quote(name)}」の行が入りましたが、一覧の「${labels.map((l) => quote(l)).join("」「")}」と同じ相手かもしれません。`,
            target: `${table}:${matchKey}`,
            detail: {
              table,
              candidateRowIds: near.map((r) => r.row_id),
              options: [...labels.map((l) => `「${quote(l)}」と同じ相手として更新する`), "別の相手として足す"],
              changeId: ctx.changeId,
            },
            suffix: "near",
            source: n.source,
          },
        ],
      };
    }
  }

  const [kind, ref, locator, year] = sourceBinds(n.source);
  const insert = ctx.db
    .prepare(
      `INSERT INTO project_rows
         (row_id, ward_id, project_id, table_key, scope, ref_year, match_key, data, person_fields, source_kind, source_ref, source_locator,
          source_year, confidence, change_id, created_at, updated_at, created_by_account_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      newId(),
      ctx.wardId,
      ctx.projectId,
      table,
      placement.scope,
      refYear,
      matchKey,
      stableStringify(data),
      stableStringify(isPerson ? Object.keys(data).sort() : []),
      kind,
      ref,
      locator,
      year,
      ctx.confidence,
      ctx.changeId,
      ctx.now,
      ctx.now,
      isPerson ? (n.source.accountId ?? null) : null,
    );
  return { status: "applied", statements: [insert], questions: [], bump: true, staleKinds: await staleKinds() };
}

// ---- 地図の仕事 ----

const PROGRESS_RANK = { open: 0, started: 1, done: 2 } as const;

async function planMapTask(ctx: Ctx, n: Normalized, change: MapTaskChange): Promise<Plan> {
  const task = await ctx.db
    .prepare(
      `SELECT task_id, name, progress FROM project_map_tasks
       WHERE ward_id = ? AND project_id = ? AND task_key = ? AND removed_at IS NULL`,
    )
    .bind(ctx.wardId, ctx.projectId, change.taskKey)
    .first<{ task_id: string; name: string; progress: keyof typeof PROGRESS_RANK }>();
  if (!task) {
    return { status: "dropped", reason: "やることに当てはまる仕事がありません", statements: [], questions: [], bump: false, staleKinds: [] };
  }
  // 済み・進んだの印は前に進める向きだけ。戻す時は役員が地図で直す
  if (PROGRESS_RANK[task.progress] >= PROGRESS_RANK[change.progress]) {
    return { status: "same", statements: [], questions: [], bump: false, staleKinds: [] };
  }
  const [kind, ref, locator] = sourceBinds(n.source);
  const update = ctx.db
    .prepare(
      `UPDATE project_map_tasks SET progress = ?, progress_source_kind = ?, progress_source_ref = ?, progress_source_locator = ?,
         progress_confidence = ?, progress_change_id = ? WHERE ward_id = ? AND task_id = ?`,
    )
    .bind(change.progress, kind, ref, locator, ctx.confidence, ctx.changeId, ctx.wardId, task.task_id);
  return {
    status: "applied",
    statements: [update],
    questions: [],
    bump: true,
    staleKinds: [],
  };
}

// ---- 資料同士の食い違い、古くなる文書 ----

function planConflict(ctx: Ctx, n: Normalized, change: Extract<ChangeInput, { kind: "conflict" }>): Plan {
  return {
    status: "conflict",
    statements: [],
    bump: false,
    staleKinds: [],
    questions: [
      {
        kind: "conflict",
        text: `${change.summary.trim()}（${change.options.map((o) => `「${quote(o.value)}」`).join("と")}）`,
        target: change.target,
        detail: { options: change.options.map((o) => o.value), sources: change.options.map((o) => o.source ?? null), changeId: ctx.changeId },
        suffix: "conflict",
        source: n.source,
      },
    ],
  };
}

async function planStale(ctx: Ctx, change: Extract<ChangeInput, { kind: "stale" }>): Promise<Plan> {
  const staleKinds = await existingFreshDocuments(ctx, [...new Set(change.documents)]);
  if (staleKinds.length === 0) return { status: "same", statements: [], questions: [], bump: false, staleKinds: [] };
  return { status: "applied", statements: [], questions: [], bump: true, staleKinds };
}

// ---- 入口 ----

interface StoredResult {
  status: Plan["status"];
  changeId: string;
  staleDocuments: DocumentKind[];
  questionIds: string[];
  reason?: string;
  conflictFields?: string[];
}

function toApplyResult(stored: StoredResult, stateVersion: number, duplicate: boolean): ApplyResult {
  const base = { duplicate, changeId: stored.changeId, stateVersion };
  switch (stored.status) {
    case "applied":
      return {
        ...base,
        status: "applied",
        staleDocuments: stored.staleDocuments,
        questionIds: stored.questionIds,
        ...(stored.conflictFields ? { conflictFields: stored.conflictFields } : {}),
      };
    case "same":
      return { ...base, status: "same" };
    case "kept":
      return { ...base, status: "kept" };
    case "conflict":
      return { ...base, status: "conflict", questionIds: stored.questionIds };
    case "held":
      return { ...base, status: "held", questionIds: stored.questionIds };
    case "dropped":
      return { ...base, status: "dropped", reason: stored.reason ?? "", questionIds: stored.questionIds };
  }
}

async function findByKey(db: Db, wardId: string, projectId: string, key: string) {
  return db
    .prepare(
      `SELECT change_id, payload_hash, result, state_version_after FROM project_changes
       WHERE ward_id = ? AND project_id = ? AND dedupe_key = ?`,
    )
    .bind(wardId, projectId, key)
    .first<{ change_id: string; payload_hash: string; result: string; state_version_after: number }>();
}

/**
 * 差分を適用する。
 *
 * 通った差分も、捨てた差分も、食い違いも、同じ物だった差分も、差分の記録に残す。
 * 返す status: applied（入った）、same（同じ物でした）、kept（決まった中身があるので案は入れなかった）、
 * conflict（食い違いとして並べた）、held（照合が曖昧で保留）、dropped（捨てた）、
 * rejected（受けなかった。プロジェクトが無い、閉じている、同じ印で中身が違う）。
 */
export async function applyChange(
  db: Db,
  wardId: string,
  projectId: string,
  change: ChangeInput,
  options: ApplyOptions = {},
): Promise<ApplyResult> {
  const project = await db
    .prepare("SELECT kind, year, closed_at, state_version FROM projects WHERE ward_id = ? AND project_id = ?")
    .bind(wardId, projectId)
    .first<ProjectRow & { kind: string }>();
  if (!project) return { status: "rejected", reason: "no_project" };
  if (project.closed_at) return { status: "rejected", reason: "closed" };

  const payloadHash = await hashOf(change);
  const checked = await checkChange(db, wardId, project, change, options);

  const base: Omit<Ctx, "dedupeKey" | "confidence" | "source"> = {
    db,
    wardId,
    projectId,
    project,
    changeId: newId(),
    now: nowIso(),
    options,
  };

  let plan: Plan;
  let normalized: Normalized;
  let dedupeKey: string;
  let droppedKey: string | null = null;
  let ctx: Ctx;

  if (!checked.ok) {
    // 形が合わない差分。通る形に直せないので、中身の印（payloadHash）で重複を弾く
    droppedKey = `dropped:${payloadHash}`;
    const seen = await findByKey(db, wardId, projectId, droppedKey);
    if (seen) return toApplyResult(JSON.parse(seen.result) as StoredResult, seen.state_version_after, true);
    const raw = asRecord(change);
    normalized = {
      change,
      source: { kind: "person" },
      target: typeof raw.itemKey === "string" ? raw.itemKey : "-",
    };
    dedupeKey = droppedKey;
    ctx = { ...base, dedupeKey, confidence: "low", source: normalized.source };
    plan = { status: "dropped", reason: checked.reason, statements: [], questions: [], bump: false, staleKinds: [] };
  } else {
    normalized = checked.value;
    const ref = normalized.source.ref ?? (normalized.source.kind === "person" ? `person:${change.requestId ?? newId()}`
      : normalized.source.kind === "ai_proposal" && change.ticketId ? `ai_proposal:${change.ticketId}` : normalized.source.kind);
    dedupeKey = await dedupeKeyOf({ ref, packVersion: change.packVersion, hand: change.kind, target: normalized.target });
    const seen = await findByKey(db, wardId, projectId, dedupeKey);
    if (seen) {
      if (seen.payload_hash === payloadHash) return toApplyResult(JSON.parse(seen.result) as StoredResult, seen.state_version_after, true);
      return { status: "rejected", reason: "key_reused" };
    }
    ctx = { ...base, dedupeKey, confidence: change.confidence, source: normalized.source };
    switch (change.kind) {
      case "item":
        plan = await planItem(ctx, normalized, change);
        break;
      case "row":
        plan = await planRow(ctx, normalized, change);
        break;
      case "conflict":
        plan = planConflict(ctx, normalized, change);
        break;
      case "stale":
        plan = await planStale(ctx, change);
        break;
      case "map_task":
        plan = await planMapTask(ctx, normalized, change);
        break;
    }
    if (plan.status === "dropped") {
      // 取り込めなかった差分は、本当の印を使わず別の印で残す（後で直して送り直せるように）
      droppedKey = `dropped:${payloadHash}`;
      const seenDropped = await findByKey(db, wardId, projectId, droppedKey);
      if (seenDropped) return toApplyResult(JSON.parse(seenDropped.result) as StoredResult, seenDropped.state_version_after, true);
      dedupeKey = droppedKey;
      ctx = { ...ctx, dedupeKey };
    }
  }

  if (plan.status === "dropped") {
    const summary = describeChange(change);
    plan.questions = [
      {
        kind: "discarded",
        text: `届いたものの「${summary}」を取り込めませんでした（${plan.reason ?? "理由は分かりません"}）。`,
        target: normalized.target === "-" ? null : normalized.target,
        detail: null,
        suffix: "dropped",
        source: checked.ok ? normalized.source : undefined,
      },
    ];
  }

  // 人が選ぶまで、食い違った資料の片方を今年の中身に残さない。
  for (const question of plan.questions) {
    if (question.kind !== "conflict" || !isItemKey(question.target) || question.detail?.scope === "reference"
      || question.detail?.documentKind || normalized.source.kind !== "original") continue;
    const current = await db.prepare(`SELECT value_id FROM project_item_values WHERE ward_id = ? AND project_id = ?
      AND item_key = ? AND scope = 'current' AND source_kind = 'original' AND superseded_at IS NULL`)
      .bind(wardId, projectId, question.target).all<{ value_id: string }>();
    plan.statements.push(...current.results.map((value) => supersedeValueStatement(ctx, value.value_id)));
    if (current.results.length) {
      plan.bump = true;
      plan.staleKinds = [...new Set([...plan.staleKinds, ...await documentsDependingOn(ctx, { item: question.target })])];
    }
  }
  const newQuestionIds = plan.questions.map(() => newId());
  const questionIds = [...(plan.existingQuestionIds ?? []), ...newQuestionIds];
  const stored: StoredResult = {
    status: plan.status,
    changeId: ctx.changeId,
    staleDocuments: plan.staleKinds,
    questionIds,
    ...(plan.reason ? { reason: plan.reason } : {}),
    ...(plan.conflictFields ? { conflictFields: plan.conflictFields } : {}),
  };

  const statements: D1PreparedStatement[] = [
    insertChangeStatement(ctx, normalized, checked.ok, plan.status, plan.reason ?? null, stored, payloadHash, dedupeKey, plan.bump),
  ];
  if (plan.bump) {
    statements.push(
      db
        .prepare("UPDATE projects SET state_version = state_version + 1 WHERE ward_id = ? AND project_id = ?")
        .bind(wardId, projectId),
    );
  }
  statements.push(...plan.statements);
  const packVersionRaw = asRecord(change).packVersion;
  const packVersion = typeof packVersionRaw === "string" ? packVersionRaw : "";
  plan.questions.forEach((q, i) => statements.push(insertQuestionStatement(ctx, q, newQuestionIds[i] as string, packVersion)));
  if (plan.staleKinds.length > 0) {
    const marks = plan.staleKinds.map(() => "?").join(",");
    statements.push(
      db
        .prepare(
          `UPDATE documents SET stale_since_version = (SELECT state_version FROM projects WHERE ward_id = ? AND project_id = ?)
           WHERE ward_id = ? AND project_id = ? AND stale_since_version IS NULL AND kind IN (${marks})`,
        )
        .bind(wardId, projectId, wardId, projectId, ...plan.staleKinds),
    );
  }

  try {
    await db.batch(statements);
  } catch (error) {
    // 同時に同じ印の差分が先に入った時は、先に入った結果を返す
    const message = error instanceof Error ? error.message : "";
    if (/UNIQUE constraint failed: project_changes/.test(message)) {
      const seen = await findByKey(db, wardId, projectId, dedupeKey);
      if (seen) {
        return seen.payload_hash === payloadHash
          ? toApplyResult(JSON.parse(seen.result) as StoredResult, seen.state_version_after, true)
          : { status: "rejected", reason: "key_reused" };
      }
    }
    throw error;
  }

  const after = await db
    .prepare("SELECT state_version_after FROM project_changes WHERE ward_id = ? AND change_id = ?")
    .bind(wardId, ctx.changeId)
    .first<{ state_version_after: number }>();
  return toApplyResult(stored, after?.state_version_after ?? project.state_version, false);
}

/** 捨てた差分を役員に見せる時の、何についての差分かの短い言い方。 */
function describeChange(change: ChangeInput): string {
  const raw = asRecord(change);
  switch (raw.kind) {
    case "item":
      return isItemKey(raw.itemKey) ? `${ITEM_LABEL[raw.itemKey]}: ${quote(String(raw.value ?? ""))}` : "項目";
    case "row":
      return isTableKey(raw.table) ? `${TABLES[raw.table].label}の行` : "表の行";
    case "conflict":
      return "食い違い";
    case "stale":
      return Array.isArray(raw.documents)
        ? (raw.documents as DocumentKind[]).map((d) => DOCUMENT_KIND_LABEL[d] ?? "文書").join("、")
        : "文書";
    case "map_task":
      return "やること";
    default:
      return "変更";
  }
}
