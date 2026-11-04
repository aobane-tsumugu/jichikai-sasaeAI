import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import type { AdminEnv } from "../env";

// 束 3: プロジェクトの状態（項目、表、文書、原本の一覧）、今年の中身と参考の中身。
// 経路の取り決めは src/core/bundle.ts。
export const project: Bundle = {
  admin: new Hono<AdminEnv>(),
};
