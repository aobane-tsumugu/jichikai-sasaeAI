import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import type { AdminEnv } from "../env";

// 束 3: 混入の検査（決定論）。経路の取り決めは src/core/bundle.ts。
export const check: Bundle = {
  admin: new Hono<AdminEnv>(),
};
