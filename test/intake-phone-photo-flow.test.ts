import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { prepareReadOriginals, readOriginals, type ReadableOriginal } from "../src/ai/read";
import { setClientFactory } from "../src/ai/deps";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { setPipelineDeps } from "../src/intake/pipeline";
import { getJob, getReadings, listOriginals } from "../src/intake/store";
import { realApp } from "./helpers";
import { fictionalPhonePhoto } from "./fixtures/phone-photo";

it("スマホの8MBの架空写真を原本のまま預かり、写しで読める。写しが無いときはサーバーで試す", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  // 写しの作成とモデルの通信だけを代える。受付、R2、読み取り要求と結果の保存は実物。
  const original = fictionalPhonePhoto();
  const copy = new Uint8Array(1024 * 1024);
  copy.set([0xff, 0xd8, 0xff, 0xe0, ...new TextEncoder().encode("架空の読み取り用の写し")]);
  const tasks: Promise<unknown>[] = [];
  const context = { waitUntil: (task: Promise<unknown>) => { tasks.push(task); } } as ExecutionContext;
  let modelCalls = 0;
  const client = new Anthropic({ apiKey: "fixture-not-a-real-key", maxRetries: 0, fetch: async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as {
      messages: { content: ({ type: "text"; text: string } | { type: "image"; source: { media_type: string; data: string } })[] }[];
    };
    const image = request.messages[0]!.content.find((block) => block.type === "image");
    if (!image || image.type !== "image") throw new Error("写真の読み取り要求がありません");
    expect(image.source.media_type).toBe("image/jpeg");
    expect(atob(image.source.data).length).toBe(copy.length);
    expect(atob(image.source.data).slice(0, 12)).toBe(String.fromCharCode(...copy.slice(0, 12)));
    modelCalls++;
    return Response.json({ id: "fixture-phone-photo", type: "message", role: "assistant", model: "claude-sonnet-5-5",
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 },
      content: [{ type: "text", text: JSON.stringify({ summary: "架空の紙を読みました", rows: [{
        original_id: "fixture-original", locator: "1行目", household_name: "架空の世帯", ward_group: "架空の班",
        adults: 2, children: 1, seniors: 0, helper_names: ["架空の手伝う人"], helper_slots: ["受付"], note: "架空の答え", confidence: "high",
      }], unreadable: [] }) }],
    });
  } });
  setPipelineDeps({ createClient: () => client });
  setClientFactory(() => { throw new Error("試験から本物のAIは呼びません"); });
  try {
    const form = new FormData();
    form.append("part", new File([original], "架空のスマホ写真.jpg", { type: "image/jpeg" }));
    form.append("part_kind", "photo");
    form.append("part_reading", new File([copy], "reading.jpg", { type: "image/jpeg" }));
    const response = await realApp.fetch(new Request(`http://localhost/${ward.slug}/admin/intake`, {
      method: "POST", headers: { cookie, origin: "http://localhost", accept: "application/json" }, body: form,
    }), env, context);
    expect(response.status).toBe(200);
    const result = await response.json() as { ok: boolean; jobId: string; message: string };
    expect(result.ok).toBe(true);
    expect(result.message).toContain("受け取りました");
    await Promise.all(tasks);
    expect(modelCalls).toBe(1);
    expect(await getJob(env.DB, ward.wardId, result.jobId)).toMatchObject({ status: "read", failure: "" });
    const stored = await listOriginals(env.DB, ward.wardId, result.jobId);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.byte_size).toBe(original.length);
    const object = await new WardBucket(env.ORIGINALS, ward.wardId).get(stored[0]!.r2_path!);
    if (!object) throw new Error("原本が保管されていません");
    const storedBytes = new Uint8Array(await object.arrayBuffer());
    // 8MBを汎用の深い比較に展開せず、長さと全バイトを照合する。違えば最初の位置が分かる。
    expect(storedBytes.length).toBe(original.length);
    expect(storedBytes.findIndex((byte, index) => byte !== original[index])).toBe(-1);
    const readings = await getReadings(env.DB, ward.wardId, result.jobId);
    expect(readings).toHaveLength(1);
    expect(readings[0]!.body).toMatchObject({ rows: [{ original_id: stored[0]!.original_id, household_name: "架空の世帯", adults: 2 }] });

    const readable: ReadableOriginal = { originalId: stored[0]!.original_id, filename: stored[0]!.filename,
      position: 1, mediaType: "image/jpeg", bytes: original };
    let conversions = 0;
    const transformer: ImageTransformer = {
      transform(options) { expect(options).toMatchObject({ width: 2000, height: 2000, fit: "scale-down" }); return transformer; },
      draw() { throw new Error("重ねる処理は使いません"); },
      async output(options) {
        expect(options).toMatchObject({ format: "image/jpeg", quality: 85 }); conversions++;
        return { response: () => new Response(copy), contentType: () => "image/jpeg", image: () => new Blob([copy]).stream() };
      },
    };
    const images: Pick<ImagesBinding, "input"> = { input: () => transformer };
    // 元の合計24MBでは拒まない。サーバーの写し3MBで数える。
    const prepared = await prepareReadOriginals([readable, { ...readable, originalId: "fixture-2" }, { ...readable, originalId: "fixture-3" }], images);
    expect(prepared.map((item) => item.bytes.length)).toEqual([copy.length, copy.length, copy.length]);
    expect(conversions).toBe(3);
    await expect(prepareReadOriginals([readable])).rejects.toMatchObject({ failure: "unreadable", retryable: false });
    await expect(prepareReadOriginals([readable], { input: () => { throw new Error("架空の変換失敗"); } })).rejects.toMatchObject({ failure: "unreadable" });
    const unread = await readOriginals(client, { kind: "answer_sheet", originals: [readable] });
    expect(unread.body.unreadable).toEqual([{ original_id: readable.originalId, locator: "全体",
      note: "写真や紙を読み取れませんでした。明るい場所で、紙の全体が入るように撮れますか。" }]);
    expect(unread.model).toBe("");
    expect(modelCalls).toBe(1);
  } finally {
    await Promise.allSettled(tasks);
    setPipelineDeps(null);
    setClientFactory(null);
  }
});
