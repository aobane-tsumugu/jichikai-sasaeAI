import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { get, realApp } from "./helpers";

describe("Workersの入口", () => {
  it("入口の案内を返す", async () => {
    const res = await get(realApp, "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(await res.text()).toContain("SasaeAI");
  });

  it("動作の確認はD1まで見る", async () => {
    const res = await get(realApp, "/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("実際の入口（default export）でも応答する", async () => {
    const res = await exports.default.fetch("http://localhost/healthz");
    expect(res.status).toBe(200);
  });

  it("ない区は404", async () => {
    const res = await get(realApp, "/no-such-ward/");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("見つかりません");
  });

  it("ない経路は404", async () => {
    const res = await get(realApp, "/hooks/nothing");
    expect(res.status).toBe(404);
  });

  it("検索に載せない範囲をrobots.txtに書く", async () => {
    const text = await (await get(realApp, "/robots.txt")).text();
    expect(text).toContain("Disallow: /ops/");
    expect(text).toContain("Disallow: /*/admin/");
  });

  it("D1とR2と鍵の束縛が宣言されている", () => {
    expect(env.DB).toBeDefined();
    expect(env.ORIGINALS).toBeDefined();
  });
});
