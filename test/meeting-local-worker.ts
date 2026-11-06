// ローカルのworkerd専用の入口。配備用のsrc/index.tsからは読み込まない。
import { createApp } from "../src/core/app";
import { bundles } from "../src/index";
import type { Env } from "../src/env";
import { prepareMeetingRuntime } from "./meeting-fixture-runtime";

const app = createApp(Object.values(bundles));
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/__meeting_setup" && request.method === "POST") {
      const setup = await prepareMeetingRuntime(env);
      return Response.json({ ward: setup.ward.slug, name: setup.account.name, password: setup.account.password });
    }
    return app.fetch(request, env, ctx);
  },
};
