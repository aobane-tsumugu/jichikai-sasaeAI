import type { ProjectApi, ChangeInput, WriteContext, QuestionInput } from "../ai/project-contract";
import { applyChange } from "./apply";
import { addQuestion } from "./questions";
import { listOpenProjects, getProjectState } from "./state";
import { ITEM_LABEL, TABLES, DOCUMENT_KIND_LABEL, DOCUMENT_KINDS, cleanRowData, isItemKey, isTableKey, type DocumentKind, type RowData, type Source } from "./model";
import { saveAIDraft } from "./actions";
import { originalInProject } from "../intake/store";
import { nowIso } from "../core/ids";

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function sourceFor(change: ChangeInput): Source | null {
  if (!change.originalId) return null;
  const year = change.year !== null && Number.isInteger(change.year) ? change.year : undefined;
  return { kind: "original", ref: change.originalId, locator: change.locator || "全体", ...(year !== undefined ? { year } : {}) };
}

function documentKind(target: string, data: Record<string, unknown>): DocumentKind | null {
  const candidate = typeof data.document_kind === "string" ? data.document_kind : target;
  if ((DOCUMENT_KINDS as readonly string[]).includes(candidate)) return candidate as DocumentKind;
  const label = DOCUMENT_KINDS.find((kind) => DOCUMENT_KIND_LABEL[kind] === candidate);
  // 2026-11-07 に画面の「知らせ」を「連絡」にした。前の呼び名で来ても同じ種類として受ける。
  return label ?? (candidate === "知らせ" ? "notice" : null);
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
      if (!Number.isInteger(data.based_on_state_version) || (data.based_on_state_version as number) < 0) {
        return { status: "rejected", note: "下書きの元にした状態がありません。dataにbased_on_state_version（引いた状態の番号）を入れてください" };
      }
      const kind = documentKind(change.target, data);
      if (!kind) return { status: "rejected", note: "文書の種類を特定できませんでした" };
      const packVersion = typeof data.pack_version === "string" ? data.pack_version.slice(0, 100) : ctx.packVersion;
      if (kind === "duty_roster") {
        if (!Array.isArray(data.duties)) return { status: "rejected", note: "dutiesに当番の行を入れてください" };
        const before = await getProjectState(env.DB, ctx.wardId, ctx.projectId);
        if (!before || typeof data.text !== "string" || !Array.isArray(data.items)) return { status: "rejected", note: "当番表の本文とitemsがありません" };
        const duties: { data: RowData; year: number | null }[] = [];
        for (const entry of data.duties) {
          const { source_year: year, ...rawRow } = record(entry);
          const row = cleanRowData("duties", rawRow);
          if (!row.ok || (year !== null && (typeof year !== "number" || !Number.isInteger(year) || year < 1900 || year > 2200))) {
            return { status: "rejected", note: "dutiesは {slot, task, assignee, source_year: 参考の年}の行にしてください" };
          }
          duties.push({ data: row.data, year });
        }
        for (const duty of duties) {
          const result = await applyChange(env.DB, ctx.wardId, ctx.projectId, {
            kind: "row", table: "duties", data: duty.data,
            source: { kind: "ai_proposal", ...(duty.year === null ? {} : { year: duty.year }), locator: "当番表の割り当ての下書き" },
            confidence: "low", packVersion, ticketId: ctx.jobId,
          });
          if (result.status === "rejected" || result.status === "dropped") return { status: "rejected", note: "当番の下書きを保存できませんでした" };
        }
        // 当番の行を入れた後の状態を下書きの元にする。
        const current = await getProjectState(env.DB, ctx.wardId, ctx.projectId);
        if (!current) return { status: "rejected", note: "行事が見つかりません" };
        if (data.based_on_state_version === before.project.stateVersion) data.based_on_state_version = current.project.stateVersion;
      }
      const ok = await saveAIDraft(env.DB, ctx.wardId, ctx.projectId, kind, packVersion, data);
      return { status: ok ? "applied" : "rejected", ...(ok ? {} : { note: "下書きを保存できませんでした。dataは {text: 本文の文字列, items: [{key: 状態の項目の鍵, content: 文字列}], pack_version, based_on_state_version}にしてください" }) };
    }
    if (change.kind === "map_draft") {
      const rawTasks = data.tasks;
      if (!Array.isArray(rawTasks) || rawTasks.length === 0 || rawTasks.length > 100) return { status: "rejected", note: "やることがありません" };
      const job = await env.DB.prepare("SELECT account_id FROM jobs WHERE ward_id = ? AND job_id = ? AND project_id = ?")
        .bind(ctx.wardId, ctx.jobId, ctx.projectId).first<{ account_id: string | null }>();
      if (!job?.account_id) return { status: "rejected", note: "やることの下書きを保存できませんでした" };
      const current = await env.DB.prepare("SELECT task_id, task_key FROM project_map_tasks WHERE ward_id = ? AND project_id = ? AND removed_at IS NULL")
        .bind(ctx.wardId, ctx.projectId).all<{ task_id: string; task_key: string | null }>();
      const byKey = new Map(current.results.flatMap((task) => task.task_key ? [[task.task_key, task.task_id] as const] : []));
      const statements: D1PreparedStatement[] = [];
      for (const value of rawTasks) {
        if (typeof value !== "object" || value === null || Array.isArray(value)) return { status: "rejected", note: "やることの形が合いません" };
        const task = value as Record<string, unknown>;
        const key = typeof task.task_id === "string" ? task.task_id : typeof task.task_key === "string" ? byKey.get(task.task_key) : undefined;
        const taskId = current.results.some((row) => row.task_id === key) ? key : undefined;
        const name = typeof task.name === "string" ? task.name.trim().slice(0, 120) : "";
        if (!taskId || !name) return { status: "rejected", note: "やることを特定できませんでした" };
        const progress = task.progress === "done" || task.progress === "started" ? task.progress : "open";
        statements.push(env.DB.prepare(`UPDATE project_close_map SET period = ?, name = ?, progress = ?, requested_by = ?, difficulty = ?, next_year = ?, updated_at = ?, updated_by_account_id = ?
          WHERE ward_id = ? AND project_id = ? AND task_id = ?
            AND EXISTS (SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL)`)
          .bind(typeof task.period === "string" ? task.period.slice(0, 80) : "", name, progress,
            typeof task.requested_by === "string" ? task.requested_by.slice(0, 160) : "",
            typeof task.difficulty === "string" ? task.difficulty.slice(0, 1200) : "",
            typeof task.next_year === "string" ? task.next_year.slice(0, 1200) : "",
            nowIso(), job.account_id, ctx.wardId, ctx.projectId, taskId, ctx.wardId, ctx.projectId));
      }
      const saved = await env.DB.batch(statements);
      return saved.every((result) => (result.meta.changes ?? 0) === 1)
        ? { status: "applied" }
        : { status: "rejected", note: "やることの下書きを保存できませんでした" };
    }
    if (!source) return { status: "rejected", note: "出どころがありません" };
    if (change.originalId && !(await originalInProject(env.DB, ctx.wardId, ctx.projectId, change.originalId))) {
      return { status: "rejected", note: "出どころの元の資料がこの行事にありません" };
    }
    if (change.kind === "item") {
      const key = isItemKey(change.target) ? change.target : Object.entries(ITEM_LABEL).find(([, label]) => label === change.target)?.[0];
      const value = typeof data.value === "string" ? data.value : "";
      if (!key || !isItemKey(key) || !value) return { status: "rejected", note: "項目の中身がありません" };
      const result = await applyChange(env.DB, ctx.wardId, ctx.projectId, { kind: "item", itemKey: key, value, source, confidence: change.confidence, packVersion: ctx.packVersion, ticketId: ctx.jobId,
        ...(change.maybeThisYear === true ? { maybeThisYear: true } : {}) });
      return { status: result.status, ...(result.status !== "rejected" ? { duplicate: result.duplicate } : {}) };
    }
    if (change.kind === "row") {
      const tableCandidate = typeof data.table === "string" ? data.table : change.target;
      const table = isTableKey(tableCandidate) ? tableCandidate : Object.entries(TABLES).find(([, def]) => def.label === tableCandidate)?.[0];
      const rowData = record(data.data ?? data.row ?? data);
      if (!table || !isTableKey(table) || Object.keys(rowData).length === 0) return { status: "rejected", note: "表の行の中身がありません" };
      const clean = Object.fromEntries(Object.entries(rowData).filter(([, v]) => typeof v === "string" || typeof v === "number")) as Record<string, string | number>;
      const result = await applyChange(env.DB, ctx.wardId, ctx.projectId, { kind: "row", table, data: clean, source, confidence: change.confidence, packVersion: ctx.packVersion, ticketId: ctx.jobId });
      return { status: result.status, ...(result.status !== "rejected" ? { duplicate: result.duplicate } : {}) };
    }
    if (change.kind === "map_task") {
      const progress = data.progress;
      if (progress !== "done" && progress !== "started") return { status: "rejected", note: "仕事の進み具合が合いません" };
      const task = await env.DB.prepare("SELECT task_key FROM project_map_tasks WHERE ward_id = ? AND project_id = ? AND removed_at IS NULL AND (task_key = ? OR name = ?) LIMIT 1")
        .bind(ctx.wardId, ctx.projectId, change.target, change.target).first<{ task_key: string | null }>();
      if (!task?.task_key) return { status: "rejected", note: "やることに当てはまる仕事がありません" };
      const result = await applyChange(env.DB, ctx.wardId, ctx.projectId, { kind: "map_task", taskKey: task.task_key, progress, source, confidence: change.confidence, packVersion: ctx.packVersion, ticketId: ctx.jobId });
      return { status: result.status, ...(result.status !== "rejected" ? { duplicate: result.duplicate } : {}) };
    }
    if (change.kind === "decision") {
      const what = typeof data.what === "string" ? data.what : change.target;
      const decidedOn = typeof data.decidedOn === "string" ? data.decidedOn : "";
      const result = await applyChange(env.DB, ctx.wardId, ctx.projectId, { kind: "row", table: "decisions", data: { what, ...(decidedOn ? { decidedOn } : {}) }, source, confidence: change.confidence, packVersion: ctx.packVersion, ticketId: ctx.jobId });
      return { status: result.status, ...(result.status !== "rejected" ? { duplicate: result.duplicate } : {}) };
    }
    return { status: "rejected", note: "対応していない内容です" };
  },
  async addQuestion(env, ctx: WriteContext, question: QuestionInput) {
    const source: Source | undefined = question.originalId ? { kind: "original", ref: question.originalId, locator: question.locator || "全体" } : undefined;
    const result = await addQuestion(env.DB, ctx.wardId, ctx.projectId, {
      kind: question.options.length ? "conflict" : "decide", text: question.text, options: question.options,
      ...(source ? { source } : {}), packVersion: ctx.packVersion, requestId: `${ctx.jobId}:${question.text}`,
    }, { reuseOpenText: true, verifyOriginal: async (originalId) => !!(await env.DB.prepare(`SELECT 1 AS ok FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
      WHERE o.ward_id = ? AND o.original_id = ? AND j.project_id = ? AND o.withdrawn_at IS NULL`).bind(ctx.wardId, originalId, ctx.projectId).first()) });
    return {
      status: result.status,
      ...("questionId" in result ? { questionId: result.questionId } : {}),
      ...(result.status === "same" ? { note: "同じ質問が既にあります" } : "detail" in result ? { note: result.detail } : {}),
    };
  },
};

export { agentApi };
