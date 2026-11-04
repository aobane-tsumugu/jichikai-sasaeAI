// プロジェクトへの口。束 3 の src/project/api.ts（開いているプロジェクト、プロジェクトの有無と閉じているか）を呼ぶ。
// 「送る」の画面のプロジェクト選び、receiveOriginal の送る先の検査、繋げる前の検査に使う。
// 存在しないプロジェクトに入った物を繋げると、agent の書き込みが全部捨てられるので、必ずここで確かめる。
import { getProjectSummary, listOpenProjects } from "../project/api";

export interface OpenProjectChoice {
  projectId: string;
  title: string;
}

export interface ProjectDirectory {
  /** 開いているプロジェクト（新しい順） */
  listOpen(db: D1Database, wardId: string): Promise<OpenProjectChoice[]>;
  /** 送る先として有効か（この区に実在し、閉じていないプロジェクトか） */
  isOpen(db: D1Database, wardId: string, projectId: string): Promise<boolean>;
}

const real: ProjectDirectory = {
  async listOpen(db, wardId) {
    return (await listOpenProjects(db, wardId)).map((p) => ({ projectId: p.projectId, title: p.title }));
  },
  async isOpen(db, wardId, projectId) {
    if (projectId.length === 0 || projectId.length > 100) return false;
    const summary = await getProjectSummary(db, wardId, projectId);
    return !!summary && !summary.closedAt;
  },
};

let current: ProjectDirectory = real;

export function projectDirectory(): ProjectDirectory {
  return current;
}

/** 試験で差し替える。null で束 3 の実装に戻す。 */
export function setProjectDirectory(directory: ProjectDirectory | null): void {
  current = directory ?? real;
}
