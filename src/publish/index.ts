import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import type { AdminEnv } from "../env";

// 束 4: 配る（版、範囲ごとの出し物、確認の一回）、差し替えと下げる。経路の取り決めは src/core/bundle.ts。
export const publish: Bundle = {
  admin: new Hono<AdminEnv>(),
};
