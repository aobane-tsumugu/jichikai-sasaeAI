import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { WardBucket } from "../src/core/storage";

describe("WardBucket（R2を区ごとに分ける）", () => {
  it("キーを区のIDで始める", async () => {
    const a = new WardBucket(env.ORIGINALS, "ward-a");
    await a.put("originals/1.txt", "あ");
    expect(await env.ORIGINALS.get("ward-a/originals/1.txt")).not.toBeNull();
    expect(await (await a.get("originals/1.txt"))!.text()).toBe("あ");
  });

  it("他の区の物は読めず、一覧にも出ない", async () => {
    const a = new WardBucket(env.ORIGINALS, "ward-iso-a");
    const b = new WardBucket(env.ORIGINALS, "ward-iso-b");
    await a.put("x/secret.txt", "aの物");
    await b.put("x/other.txt", "bの物");
    expect(await b.get("x/secret.txt")).toBeNull();
    const listed = await b.list("x/");
    expect(listed.keys.map((k) => k.key)).toEqual(["x/other.txt"]);
  });

  it("区をまたぐキーを拒む", () => {
    const a = new WardBucket(env.ORIGINALS, "ward-a");
    expect(() => a.key("../ward-b/x")).toThrow();
    expect(() => a.key("/abs")).toThrow();
    expect(() => a.key("a//b")).toThrow();
    expect(() => new WardBucket(env.ORIGINALS, "a/b")).toThrow();
    expect(() => new WardBucket(env.ORIGINALS, "")).toThrow();
  });
});
