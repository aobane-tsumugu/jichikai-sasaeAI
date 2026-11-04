// 束 3 のプロジェクト（src/project/api.ts）への繋ぎ。MCP の手が呼ぶ。
// プロジェクトと区は札から割り出した物（WriteContext）で、agent の引数は信じない。
// 出どころの原本が実在するかは、ここで検査する関数（verifyOriginal）を束 3 に渡す。
import type { Env } from "../env";
import { originalInProject } from "../intake/store";
import * as project from "../project/api";
import type { ChangeInput as ProjectChange } from "../project/api";
import type { ChangeInput, ProjectApi, QuestionInput, WriteContext } from "./project-contract";

type Mapped = { ok: true; change: ProjectChange } | { ok: false; note: string };

function toProjectChange(change: ChangeInput, ctx: WriteContext): Mapped {
  const base = {
    packVersion: ctx.packVersion,
    confidence: change.confidence,
    source: {
      kind: "original" as const,
      ...(change.originalId ? { ref: change.originalId } : {}),
      locator: change.locator || "全体",
      ...(change.year ? { year: change.year } : {}),
    },
  };
  const data = (typeof change.data === "object" && change.data !== null ? change.data : {}) as Record<string, unknown>;
  switch (change.kind) {
    case "item":
      if (!project.isItemKey(change.target)) {
        return { ok: false, note: `項目の名前が違います。使えるのは ${project.ITEM_KEYS.join("、")} です。` };
      }
      return { ok: true, change: { ...base, kind: "item", itemKey: change.target, value: String(data.value ?? "") } };
    case "row":
      if (!project.isTableKey(change.target)) {
        return { ok: false, note: `表の名前が違います。使えるのは ${project.TABLE_KEYS.join("、")} です。` };
      }
      return { ok: true, change: { ...base, kind: "row", table: change.target, data: data as project.RowData } };
    case "decision":
      return {
        ok: true,
        change: {
          ...base,
          kind: "row",
          table: "decisions",
          data: { what: String(data.what ?? change.target), ...(data.decidedOn ? { decidedOn: String(data.decidedOn) } : {}) },
        },
      };
    case "conflict": {
      const options = Array.isArray(data.options) ? data.options : [];
      return {
        ok: true,
        change: {
          ...base,
          kind: "conflict",
          target: change.target,
          summary: String(data.summary ?? ""),
          options: options.map((o: { value?: unknown; original_id?: unknown; locator?: unknown }) => ({
            value: String(o.value ?? ""),
            ...(typeof o.original_id === "string" && o.original_id
              ? { source: { kind: "original" as const, ref: o.original_id, locator: String(o.locator ?? "全体") } }
              : {}),
          })),
        },
      };
    }
    case "map_task":
      if (data.progress !== "started" && data.progress !== "done") {
        return { ok: false, note: "data.progress は started か done にしてください。" };
      }
      return { ok: true, change: { ...base, kind: "map_task", taskKey: change.target, progress: data.progress } };
    default:
      // draft、map_draft は、束 3 の下書きと地図の下書きの書き込み口が入ってから繋ぐ
      return { ok: false, note: "下書きの書き込み口はまだ繋がっていません。" };
  }
}

function verifier(env: Env, ctx: WriteContext) {
  return (originalId: string) => originalInProject(env.DB, ctx.wardId, ctx.projectId, originalId);
}

const bundle3: ProjectApi = {
  async listOpenProjects(env, wardId) {
    const list = await project.listOpenProjects(env.DB, wardId);
    return list.map((p) => ({ projectId: p.projectId, title: p.title, kind: p.kind, year: p.year }));
  },
  async getProjectState(env, wardId, projectId) {
    return (await project.getProjectState(env.DB, wardId, projectId)) ?? { note: "プロジェクトが見つかりません" };
  },
  async applyChange(env, ctx, change) {
    const mapped = toProjectChange(change, ctx);
    if (!mapped.ok) return { status: "rejected", note: mapped.note };
    return project.applyChange(env.DB, ctx.wardId, ctx.projectId, mapped.change, { verifyOriginal: verifier(env, ctx) });
  },
  async addQuestion(env, ctx, q: QuestionInput) {
    return project.addQuestion(
      env.DB,
      ctx.wardId,
      ctx.projectId,
      {
        kind: q.kind,
        text: q.text,
        ...(q.target ? { target: q.target } : {}),
        ...(q.options.length > 0 ? { options: q.options } : {}),
        ...(q.originalId ? { source: { kind: "original" as const, ref: q.originalId, locator: q.locator || "全体" } } : {}),
        packVersion: ctx.packVersion,
      },
      { verifyOriginal: verifier(env, ctx) },
    );
  },
};

let current: ProjectApi = bundle3;

export function projectApi(): ProjectApi {
  return current;
}

/** 試験で差し替える。null で束 3 の実装に戻す。 */
export function setProjectApi(api: ProjectApi | null): void {
  current = api ?? bundle3;
}
