import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import type { AdminEnv } from "../env";

// 束 2: 入れると列。役員画面の送る（カメラ、ファイル、一行の文）、受付、札、列の記録。
// 経路の取り決めは src/core/bundle.ts。この置き場の中だけを埋め、src/index.ts と src/env.ts は触らない。
export const intake: Bundle = {
  admin: new Hono<AdminEnv>(),
};
