import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import type { AdminEnv, WardEnv } from "../env";

// 束 5: 回答の入口（Web）、回答票の読み、代理入力、答えを数える、未回答。経路の取り決めは src/core/bundle.ts。
export const answers: Bundle = {
  admin: new Hono<AdminEnv>(),
  pub: new Hono<WardEnv>(),
};
