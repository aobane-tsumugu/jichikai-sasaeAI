import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import type { AdminEnv } from "../env";

// 束 3: プロジェクトの地図（型、当て、描画）。経路の取り決めは src/core/bundle.ts。
export const map: Bundle = {
  admin: new Hono<AdminEnv>(),
};
