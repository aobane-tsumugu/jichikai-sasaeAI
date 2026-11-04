import { Hono } from "hono";
import type { Bundle } from "../core/bundle";
import { CRON } from "../core/cron";
import type { AppEnv } from "../env";
import { sweepConnections } from "./complete";
import { mcpPub } from "./mcp";
import { anthropicHooks } from "./webhook";

// 束 2: 読む（Messages API）、Managed Agents の agent と session、MCP の五つの手（pub の /mcp）、webhook（hooks の /anthropic）、
// 繋げるの見回り（scheduled）。経路の取り決めは src/core/bundle.ts。
const hooks = new Hono<AppEnv>();
hooks.route("/", anthropicHooks);

export const ai: Bundle = {
  pub: mcpPub,
  hooks,
  async scheduled(event, env) {
    if (event.cron === CRON.EVERY_5_MIN) await sweepConnections(env);
  },
};
