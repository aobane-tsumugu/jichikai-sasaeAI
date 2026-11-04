import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import type { AdminEnv } from "../env";

// 束 3: 下書き（案内、募集、当番表、進め方、報告）。経路の取り決めは src/core/bundle.ts。
export const draft: Bundle = {
  admin: new Hono<AdminEnv>(),
};
