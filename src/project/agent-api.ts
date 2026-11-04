import type { ProjectApi, ChangeInput, WriteContext, QuestionInput } from "../ai/project-contract";
import { applyChange } from "./apply";
import { addQuestion } from "./questions";
import { listOpenProjects, getProjectState } from "./state";
import { ITEM_LABEL, TABLES, DOCUMENT_KIND_LABEL, DOCUMENT_KINDS, isItemKey, isTableKey, type DocumentKind, type Source } from "./model";
import { saveAIDraft } from "./actions";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sourceFor(change: ChangeInput): Source | null {
  if (!change.originalId) return null;
  const data = record(change.data);
  const year = typeof data.source_year === "number" && Number.isInteger(data.source_year) ? data.source_year : undefined;
  return { kind: "original", ref: change.originalId, locator: change.locator || "全体", ...(year ? { year } : {}) };
}

function documentKind(target: string, data: Record<string, unknown>): DocumentKind | null {
  const candidate = typeof data.document_kind === "string" ? data.document_kind : target;
  if ((DOCUMENT_KINDS as readonly string[]).includes(candidate)) return candidate as DocumentKind;
  const label = DOCUMENT_KINDS.find((kind) => DOCUMENT_KIND_LABEL[kind] === candidate);
  return label ?? null;
}

const agentApi: ProjectApi = {
  async listOpenProjects(env, wardId) {
    return (await listOpenProjects(env.DB, wardId)).map((p) => ({ projectId: p.projectId, title: p.title, kind: p.kind, year: p.year }));
  },
  getProjectState(env, wardId, projectId) {
    return getProjectState(env.DB, wardId, projectId);
  },
  async applyChange(env, ctx: WriteContext, change: ChangeInput) {
    const data = record(change.data);
    const source = sourceFor(change);
    if (change.kind === "draft") {
      const kind = documentKind(change.target, data);
      if (!kind) return { status: "rejected", note: "文書の種類を特定できませんでした" };
      const packVersion = typeof data.pack_version === "string" ? data.pack_version.slice(0, 100) : ctx.packVersion;
      const ok = await saveAIDraft(env.DB, ctx.wardId, ctx.projectId, kind, packVersion, data);
      return { status: ok ? "applied" : "rejected", ...(ok ? {} : { note: "下書きを保存できませんでした" }) };
    }
    if (change.kind === "map_draft") return { status: "rejected", note: "地図の記録は閉じる時に扱います" };
    if (!source) return { status: "rejected", note: "出どころがありません" };
    if (change.kind === "item") {
      const key = isItemKey(change.target) ? change.target : Object.entries(ITEM_LABEL).find(([, label]) => label === change.target)?.[0];
      const value = typeof data.value === "string" ? data.value : "";
      if (!key || !isItemKey(key) || !value) return { status: "rejected", note: "項目の中身がありません" };
      const result = await applyChange(env.DB, ctx.wardId, ctx.projectId, { kind: "item", itemKey: key, value, source, confidence: change.confidence, packVersion: ctx.packVersion, ticketId: ctx.jobId });
      return { status: result.status };
    }
    if (change.kind === "row") {
      const tableCandidate = typeof data.table === "string" ? data.table : change.target;
      const table = isTableKey(tableCandidate) ? tableCandidate : Object.entries(TABLES).find(([, def]) => def.label === tableCandidate)?.[0];
      const rowData = record(data.data ?? data.row ?? data);
      if (!table || !isTableKey(table) || Object.keys(rowData).length === 0) return { status: "rejected", note: "表の行の中身がありません" };
      const clean = Object.fromEntries(Object.entries(rowData).filter(([, v]) => typeof v === "string" || typeof v === "number")) as Record<string, string | number>;
      const result = await applyChange(env.DB, ctx.wardId, ctx.projectId, { kind: "row", table, data: clean, source, confidence: change.confidence, packVersion: ctx.packVersion, ticketId: ctx.jobId });
      return { status: result.status };
    }
    if (change.kind === "map_task") {
      const progress = data.progress;
      if (progress !== "done" && progress !== "started") return { status: "rejected", note: "仕事の進み具合が合いません" };
      const task = await env.DB.prepare("SELECT task_key FROM project_map_tasks WHERE ward_id = ? AND project_id = ? AND removed_at IS NULL AND (task_key = ? OR name = ?) LIMIT 1")
        .bind(ctx.wardId, ctx.projectId, change.target, change.target).first<{ task_key: string | null }>();
      if (!task?.task_key) return { status: "rejected", note: "地図に当てはまる仕事がありません" };
      const result = await applyChange(env.DB, ctx.wardId, ctx.projectId, { kind: "map_task", taskKey: task.task_key, progress, source, confidence: change.confidence, packVersion: ctx.packVersion, ticketId: ctx.jobId });
      return { status: result.status };
    }
    if (change.kind === "decision") {
      const what = typeof data.what === "string" ? data.what : change.target;
      const decidedOn = typeof data.decidedOn === "string" ? data.decidedOn : "";
      const result = await applyChange(env.DB, ctx.wardId, ctx.projectId, { kind: "row", table: "decisions", data: { what, ...(decidedOn ? { decidedOn } : {}) }, source, confidence: change.confidence, packVersion: ctx.packVersion, ticketId: ctx.jobId });
      return { status: result.status };
    }
    return { status: "rejected", note: "対応していない内容です" };
  },
  async addQuestion(env, ctx: WriteContext, question: QuestionInput) {
    const source: Source | undefined = question.originalId ? { kind: "original", ref: question.originalId, locator: question.locator || "全体" } : undefined;
    const result = await addQuestion(env.DB, ctx.wardId, ctx.projectId, {
      kind: question.options.length ? "conflict" : "decide", text: question.text, options: question.options,
      ...(source ? { source } : {}), packVersion: ctx.packVersion, requestId: `${ctx.jobId}:${question.text}`,
    }, { verifyOriginal: async (originalId) => !!(await env.DB.prepare(`SELECT 1 AS ok FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
      WHERE o.ward_id = ? AND o.original_id = ? AND j.project_id = ? AND o.withdrawn_at IS NULL`).bind(ctx.wardId, originalId, ctx.projectId).first()) });
    return { status: result.status, ...("detail" in result ? { note: result.detail } : {}) };
  },
};

export { agentApi };
