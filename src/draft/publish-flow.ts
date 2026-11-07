import { Hono, type Context } from "hono";
import type { AdminEnv } from "../env";
import { publish } from "../publish";

/** ログイン済みの文脈で、既存の配布処理を使う。保存と配布の処理を二重に持たない。 */
export async function openPublish(c: Context<AdminEnv>, path: string, fields: URLSearchParams): Promise<Response> {
  if (!publish.admin) throw new Error("知らせる処理が見つかりません");
  const app = new Hono<AdminEnv>();
  app.use("*", async (inner, next) => {
    inner.set("ward", c.var.ward);
    inner.set("account", c.var.account);
    inner.set("deviceId", c.var.deviceId);
    await next();
  });
  app.route("/", publish.admin);
  return app.fetch(new Request(new URL(path, c.req.url), {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: fields,
  }), c.env);
}
