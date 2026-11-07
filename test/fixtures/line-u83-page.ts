import { env } from "cloudflare:workers";
import { expect } from "vitest";
import { get, realApp } from "../helpers";

/** 古い写真のURLが、本文を返さずトークの該当箇所へ送ることも確かめる。 */
export async function redirectedTalkPage(path: string, cookie: string, runtime: unknown = env): Promise<string> {
  const old = await get(realApp, path, cookie, runtime);
  expect(old.status).toBe(303);
  const target = old.headers.get("location");
  if (!target) throw new Error("元の会話への送り先がありません");
  expect(target).toContain("/inbox/talks/");
  expect(target).toContain("#topic-");
  const page = await get(realApp, target, cookie, runtime);
  expect(page.status).toBe(200);
  return page.text();
}
