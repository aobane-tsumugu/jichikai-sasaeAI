import { env } from "cloudflare:workers";
import { createApp } from "../src/core/app";
import type { Bundle } from "../src/core/bundle";
import { bundles } from "../src/index";

export const realApp = createApp(Object.values(bundles));

/** Hono のアプリのうち、試験が使う request だけ。 */
export interface Requester {
  request(input: string, init?: RequestInit, env?: unknown): Response | Promise<Response>;
}

export function get(app: Requester, path: string, cookie?: string) {
  return app.request(path, { headers: cookie ? { cookie } : {} }, env);
}

/** フォームの POST。csrf の検査を通すため origin を付ける。 */
export function postForm(app: Requester, path: string, form: Record<string, string>, cookie?: string) {
  return app.request(
    path,
    {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: "http://localhost",
        ...(cookie ? { cookie } : {}),
      },
      body: new URLSearchParams(form).toString(),
    },
    env,
  );
}

/** Set-Cookie から name=value を取り出す。 */
export function cookieFrom(res: Response, name: string): string | null {
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(";")[0] ?? "";
    if (pair.startsWith(`${name}=`) && pair.length > name.length + 1) return pair;
  }
  return null;
}

export function appWith(bundle: Bundle) {
  return createApp([...Object.values(bundles), bundle]);
}
