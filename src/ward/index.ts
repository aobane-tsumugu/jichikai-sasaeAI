import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import type { WardEnv } from "../env";

// 束 4: 区のページ（公開）。経路の取り決めは src/core/bundle.ts。
export const wardPages: Bundle = {
  pub: new Hono<WardEnv>(),
};
