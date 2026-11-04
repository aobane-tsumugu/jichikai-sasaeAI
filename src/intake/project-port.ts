// 束 3 のプロジェクト（src/project/api.ts の listOpenProjects）への仮の口。
// 束 3 の最初の commit が main に入るまでの置き物で、入ったら import を本物に替えてこのファイルを消す。
// 「送る」の画面のプロジェクト選びと、送る先の検査にだけ使う。

export interface OpenProjectChoice {
  projectId: string;
  title: string;
}

export interface ProjectDirectory {
  /** 開いているプロジェクト（新しい順） */
  listOpen(db: D1Database, wardId: string): Promise<OpenProjectChoice[]>;
  /** 送る先として有効か（この区の、開いているプロジェクトか） */
  isOpen(db: D1Database, wardId: string, projectId: string): Promise<boolean>;
}

/** 束 3 が入るまでの既定。選べるプロジェクトは無く、指定されたら通す（検査は束 3 の取り込みで有効にする）。 */
const placeholder: ProjectDirectory = {
  async listOpen() {
    return [];
  },
  async isOpen(_db, _wardId, projectId) {
    return projectId.length > 0 && projectId.length <= 100;
  },
};

let current: ProjectDirectory = placeholder;

export function projectDirectory(): ProjectDirectory {
  return current;
}

/** 試験で差し替える。 */
export function setProjectDirectory(directory: ProjectDirectory | null): void {
  current = directory ?? placeholder;
}
