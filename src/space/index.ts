import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import type { AdminEnv, WardEnv } from "../env";

// 束 5: プロジェクトの空間（合言葉、招待、班長の専用 URL、見る、撮って送る、閉じる）。経路の取り決めは src/core/bundle.ts。
export const space: Bundle = {
  admin: new Hono<AdminEnv>(),
  pub: new Hono<WardEnv>(),
};
