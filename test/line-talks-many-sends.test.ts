import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { listTalks } from "../src/line/talks";
import { withEnv } from "./helpers";

it("役員の画面から送った物が多くても、トークを開くたびに判断を書き直さない", async () => {
  const { ward } = await seedAdmin(env.DB);
  const runtime = withEnv({});
  for (let index = 0; index < 20; index++) {
    await receive(runtime, { wardId: ward.wardId, via: "admin",
      parts: [{ kind: "text", filename: `note-${index}.txt`, mediaType: "text/plain", bytes: new TextEncoder().encode(`当番の連絡 ${index}`) }] });
  }
  const first = await listTalks(env.DB, ward.wardId);
  const admin = first.find((talk) => talk.name === "役員の画面から送ったもの");
  expect(admin?.posts).toHaveLength(20);
  const before = await env.DB.prepare("SELECT bundle_id, updated_at FROM line_bundle_decisions WHERE ward_id = ? ORDER BY bundle_id")
    .bind(ward.wardId).all<{ bundle_id: string; updated_at: string }>();
  expect(before.results).toHaveLength(20);
  // 二回目は保存済みの判断を読むだけで、書き直さない。一覧の形では文の中身を読まなくても同じトークになる。
  const second = await listTalks(env.DB, ward.wardId, { withText: false });
  expect(second.map((talk) => [talk.id, talk.posts.length])).toEqual(first.map((talk) => [talk.id, talk.posts.length]));
  const after = await env.DB.prepare("SELECT bundle_id, updated_at FROM line_bundle_decisions WHERE ward_id = ? ORDER BY bundle_id")
    .bind(ward.wardId).all<{ bundle_id: string; updated_at: string }>();
  expect(after.results).toEqual(before.results);
});
