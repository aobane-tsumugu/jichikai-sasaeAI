import { env } from "cloudflare:workers";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { runScheduled } from "../src/core/app";
import type { Bundle } from "../src/core/bundle";
import { CRON } from "../src/core/cron";
import { seedAdmin } from "../src/core/testing";
import type { AdminEnv, AppEnv, WardEnv } from "../src/env";
import { bundles } from "../src/index";
import { appWith, get, opsEnv, postForm } from "./helpers";

function routeKeys(app: Hono<AdminEnv> | Hono<WardEnv> | Hono<AppEnv>): string[] {
  return app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`);
}

describe("各置き場の差し込み口", () => {
  it("束の表の置き場が全部そろっている", () => {
    expect(Object.keys(bundles).sort()).toEqual(
      [
        "ai", "answers", "archive", "check", "close", "draft", "intake", "line", "map", "printPages",
        "photos", "project", "publish", "settings", "space", "wardPages",
      ].sort(),
    );
  });

  it("同じ口の中で、置き場をまたいで同じ（メソッド, パス）を持たない", () => {
    for (const surface of ["admin", "pub", "hooks"] as const) {
      const seen = new Map<string, string>();
      for (const [name, bundle] of Object.entries(bundles)) {
        const router = bundle[surface];
        if (!router) continue;
        for (const key of routeKeys(router)) {
          const owner = seen.get(key);
          expect(owner, `${surface}の${key}が${owner}と${name}で重なっています`).toBeUndefined();
          seen.set(key, name);
        }
      }
    }
  });

  it("pubの経路は /adminの下に置けない（役員画面は入るの検査の内側）", () => {
    for (const [name, bundle] of Object.entries(bundles)) {
      if (!bundle.pub) continue;
      for (const key of routeKeys(bundle.pub)) {
        const path = key.split(" ")[1] ?? "";
        expect(path.startsWith("/admin"), `${name}の${key}`).toBe(false);
      }
    }
  });

  it("adminの経路は入るが要り、pubとhooksは要らない", async () => {
    const probe: Bundle = {
      admin: new Hono<AdminEnv>().get("/probe", (c) => c.text(`admin:${c.var.account.name}`)),
      pub: new Hono<WardEnv>().get("/probe-pub", (c) => c.text(`pub:${c.var.ward.slug}`)),
      hooks: new Hono<AppEnv>().get("/probe-hook", (c) => c.text("hook")),
    };
    const app = appWith(probe);
    const { ward, account, cookie } = await seedAdmin(env.DB);

    expect((await get(app, `/${ward.slug}/admin/probe`)).status).toBe(303);
    const authed = await get(app, `/${ward.slug}/admin/probe`, cookie);
    expect(await authed.text()).toBe(`admin:${account.name}`);

    const pub = await get(app, `/${ward.slug}/probe-pub`);
    expect(await pub.text()).toBe(`pub:${ward.slug}`);

    const hook = await get(app, "/hooks/probe-hook");
    expect(await hook.text()).toBe("hook");
  });

  it("adminのPOSTも入るが要る", async () => {
    const probe: Bundle = { admin: new Hono<AdminEnv>().post("/probe", (c) => c.text("ok")) };
    const app = appWith(probe);
    const { ward, cookie } = await seedAdmin(env.DB);
    expect((await postForm(app, `/${ward.slug}/admin/probe`, {})).status).toBe(303);
    expect((await postForm(app, `/${ward.slug}/admin/probe`, {}, cookie)).status).toBe(200);
  });

  it("写真の設定のGETとPOSTは提供側の入口に戻し、ほかのhooksへ認証を広げない", async () => {
    const app = appWith({ hooks: new Hono<AppEnv>().post("/probe-photo-hook", (c) => c.text("hook")) });
    for (const response of [
      await get(app, "/ops/photo-settings/fictional-ward", undefined, opsEnv),
      await postForm(app, "/ops/photo-settings/fictional-ward", {}, undefined, opsEnv),
    ]) {
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/ops/login");
    }
    expect((await get(app, "/hooks/nothing")).status).toBe(404);
    expect(await (await postForm(app, "/hooks/probe-photo-hook", {})).text()).toBe("hook");
  });
});

describe("Cron", () => {
  const event = { cron: CRON.EVERY_5_MIN, scheduledTime: Date.now(), noRetry() {} } as ScheduledController;
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;

  it("置き場ごとに実行し、一つが失敗しても他は実行する", async () => {
    const ran: string[] = [];
    const set: Record<string, Bundle> = {
      broken: {
        scheduled: async () => {
          throw new Error("故意の失敗");
        },
      },
      healthy: {
        scheduled: async (e) => {
          ran.push(e.cron);
        },
      },
      none: {},
    };
    await runScheduled(set, event, env, ctx);
    expect(ran).toEqual([CRON.EVERY_5_MIN]);
  });

  it("CRONの定数は二つの式", async () => {
    expect(Object.values(CRON)).toEqual(["*/5 * * * *", "0 18 * * *"]);
  });
});
