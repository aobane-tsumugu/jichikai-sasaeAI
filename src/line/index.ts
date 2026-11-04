import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import type { AdminEnv, AppEnv } from "../env";

// 束 6: 公式 LINE の webhook（hooks の /line）と受け箱（admin の /inbox）、一斉送信。経路の取り決めは src/core/bundle.ts。
export const line: Bundle = {
  admin: new Hono<AdminEnv>(),
  hooks: new Hono<AppEnv>(),
};
