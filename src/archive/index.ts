import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import type { AdminEnv } from "../env";

// 束 7: 記録の一覧、来年の種、原本へ戻る。経路の取り決めは src/core/bundle.ts。
export const archive: Bundle = {
  admin: new Hono<AdminEnv>(),
};
