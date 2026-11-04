import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import type { AdminEnv } from "../env";

// 束 7: 閉じる（報告と地図の下書き、凍結）。経路の取り決めは src/core/bundle.ts。
export const close: Bundle = {
  admin: new Hono<AdminEnv>(),
};
