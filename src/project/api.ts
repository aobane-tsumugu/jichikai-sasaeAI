// 他の束が呼ぶ口。束 2 の MCP の五つの手のうち、「開いているプロジェクトを引く」「プロジェクトの状態を引く」
// 「差分を書く」「問いを書く」は、ここの関数を呼ぶ。束 4、5、7 も、プロジェクトの状態の読み書きはここを通す。
//
// 約束。
// - 関数は Hono に依存しない。D1 と区の ID を受ける。区の ID は必ず where に入る。URL や本文に来た区の ID は信じない。
// - プロジェクトの ID は引数で受けるが、MCP の手は札から割り出した ID を渡す（引数の ID を信じない。設計書 5.6）。
// - 差分と問いは重複を弾く印で冪等。出どころの検査に通らない差分は捨て、捨てたことが問いの一覧に出る。
export { applyChange } from "./apply";
export { addQuestion } from "./questions";
export { createProject, getProjectState, getProjectSummary, listOpenProjects, listProjects, ProjectInputError } from "./state";
export type * from "./types";
export * from "./model";
export type { VerifyOriginal } from "./source";
