// 束 3 のプロジェクトへの繋ぎ。束 3 が入るまでの仮の実装で、状態は空、書いた物は受けたとだけ返す。
// 入ったら、中身を src/project/api.ts の関数への呼び出しに替えてこの仮の実装を消す。
import type { ProjectApi } from "./project-contract";

const placeholder: ProjectApi = {
  async listOpenProjects() {
    return [];
  },
  async getProjectState(_env, _wardId, projectId) {
    return { projectId, note: "プロジェクトの状態はまだありません（束 3 の取り込み前の仮の実装）" };
  },
  async applyChange() {
    return { status: "accepted", note: "仮の実装です。まだ状態には入っていません" };
  },
  async addQuestion() {
    return { status: "accepted", note: "仮の実装です。まだ問いには入っていません" };
  },
};

let current: ProjectApi = placeholder;

export function projectApi(): ProjectApi {
  return current;
}

/** 試験で差し替える。null で仮の実装に戻す。 */
export function setProjectApi(api: ProjectApi | null): void {
  current = api ?? placeholder;
}
