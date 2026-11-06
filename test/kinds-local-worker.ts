// ローカルのworkerd専用。本物の配備用の入口には接続しない。
import { createApp } from "../src/core/app";
import { bundles } from "../src/index";
import type { Env } from "../src/env";
import { prepareKindsRuntime } from "./kinds-fixture-runtime";

const app = createApp(Object.values(bundles));
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    if (new URL(request.url).pathname === "/__kinds_setup" && request.method === "POST") {
      const setup = await prepareKindsRuntime(env);
      return Response.json({ ward: setup.ward.slug, name: setup.account.name, password: setup.account.password });
    }
    return app.fetch(request, env, ctx);
  },
};
