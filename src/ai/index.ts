import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import type { AppEnv, WardEnv } from "../env";

// 束 2: 読む（Messages API）、Managed Agents の agent と session、MCP の五つの手（pub の /mcp）、webhook（hooks の /anthropic）、
// 列の見回り（scheduled）。経路の取り決めは src/core/bundle.ts。
export const ai: Bundle = {
  pub: new Hono<WardEnv>(),
  hooks: new Hono<AppEnv>(),
};
