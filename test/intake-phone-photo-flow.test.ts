import Anthropic from "@anthropic-ai/sdk";
import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { setClientFactory } from "../src/ai/deps";
import { seedAdmin, seedWard } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { setPipelineDeps, runRead } from "../src/intake/pipeline";
import { receive } from "../src/intake/receive";
import { imageDimensions, type PhotoImages } from "../src/intake/photo";
import { sha256Hex } from "../src/intake/media";
import { getJob, getReadings, listOriginals } from "../src/intake/store";
import { realApp } from "./helpers";
import { fictionalPhonePhoto, fictionalStoredPhoto } from "./fixtures/phone-photo";

it("6.7MBの写真は2400pxのJPEG一つを保管して読み、縮小前後の再送を重ねず、変換失敗も質問へ渡す", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  const original = fictionalPhonePhoto();
  const stored = fictionalStoredPhoto();
  expect(original.length).toBe(6_700_000);
  expect(imageDimensions(original)).toEqual({ width: 3394, height: 4800 });
  expect(imageDimensions(stored)).toEqual({ width: 1697, height: 2400 });
  const sourceHash = await sha256Hex(original);
  let conversions = 0;
  // Imagesの通信だけを代え、出力には実際に縮小・JPEG圧縮した試しの回答票を使う。
  const transformer: ImageTransformer = {
    transform(options) { expect(options).toEqual({ width: 2400, height: 2400, fit: "scale-down" }); return transformer; },
    draw() { throw new Error("重ねる処理は使いません"); },
    async output(options) {
      expect(options).toEqual({ format: "image/jpeg", quality: 85 }); conversions++;
      return { response: () => new Response(stored), contentType: () => "image/jpeg", image: () => new Blob([stored]).stream() };
    },
  };
  const images: PhotoImages = { input: () => transformer };
  const runtime = Object.create(env, { IMAGES: { value: images } }) as typeof env & { IMAGES: PhotoImages };
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
    expect(await sha256Hex(Uint8Array.from(atob(image.source.data), c => c.charCodeAt(0)))).toBe(await sha256Hex(stored));
    modelCalls++;
    // AI通信の代用。実際の手書き認識の精度を証明する試験にはしない。
    return Response.json({ id: "fixture-phone-photo", type: "message", role: "assistant", model: "claude-sonnet-5-5",
      stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 100, output_tokens: 50 },
      content: [{ type: "text", text: JSON.stringify({ summary: "試しの回答票", rows: [{
        original_id: "fixture-original", locator: "人数欄", household_name: "試しの世帯", ward_group: "試しの班",
        adults: 2, children: 1, seniors: 0, not_attending: false, meeting_status: null, proxy_name: "",
        helper_names: [], helper_slots: ["受付"], note: "試しの答え", confidence: "high",
      }], unreadable: [] }) }],
    });
  } });
  setPipelineDeps({ createClient: () => client });
  setClientFactory(() => { throw new Error("試験から本物のAIは呼びません"); });
  const send = async (bytes: Uint8Array, hash?: string) => {
    const form = new FormData();
    form.append("part", new File([bytes], "試しの回答票.jpg", { type: "image/jpeg" }));
    form.append("part_kind", "photo");
    if (hash) form.append("part_source_hash", hash);
    const response = await realApp.fetch(new Request(`http://localhost/${ward.slug}/admin/intake`, {
      method: "POST", headers: { cookie, origin: "http://localhost", accept: "application/json" }, body: form,
    }), runtime, context);
    expect(response.status).toBe(200);
    const result = await response.json() as { ok: boolean; jobId?: string; message: string };
    expect(result.ok).toBe(true);
    return result;
  };
  try {
    const result = await send(original);
    expect(result.message).toContain("受け取りました");
    if (!result.jobId) throw new Error("写真を受け付けられませんでした");
    await Promise.all(tasks);
    expect(modelCalls).toBe(1);
    expect(conversions).toBe(1);
    expect(await getJob(env.DB, ward.wardId, result.jobId)).toMatchObject({ status: "read", failure: "" });
    const originals = await listOriginals(env.DB, ward.wardId, result.jobId);
    expect(originals).toHaveLength(1);
    const row = originals[0]!;
    expect(row).toMatchObject({ media_type: "image/jpeg", byte_size: stored.length, content_hash: sourceHash });
    const bucket = new WardBucket(env.ORIGINALS, ward.wardId);
    const object = await bucket.get(row.r2_path!);
    if (!object) throw new Error("保管した写真がありません");
    const saved = new Uint8Array(await object.arrayBuffer());
    expect(await sha256Hex(saved)).toBe(await sha256Hex(stored));
    expect(imageDimensions(saved)).toEqual({ width: 1697, height: 2400 });
    expect((await bucket.list("originals/")).keys.map(item => item.key)).toEqual([row.r2_path]);
    const readings = await getReadings(env.DB, ward.wardId, result.jobId);
    expect(readings).toHaveLength(1);
    expect(readings[0]!.body).toMatchObject({ rows: [{ original_id: row.original_id, household_name: "試しの世帯", adults: 2, children: 1, seniors: 0 }] });
    const beforeResend = conversions;
    expect((await send(stored, sourceHash)).message).toContain("同じ");
    // ブラウザで整えられなかった再送と、LINEの入口からの同じ写真も同じ物になる。
    expect((await send(original)).message).toContain("同じ");
    const line = await receive(runtime, { wardId: ward.wardId, via: "line_direct", parts: [{ kind: "photo", filename: "LINEの写真", mediaType: "image/jpeg", bytes: original }] });
    expect(line.jobId).toBeNull();
    expect(line.duplicates.map(item => item.originalId)).toEqual([row.original_id]);
    expect(conversions).toBe(beforeResend + 2);
    expect((await bucket.list("originals/")).keys).toHaveLength(1);
    expect(modelCalls).toBe(1);

    // 変換失敗でも大きい写真を保管し、通常の読み取りが既存の質問を残す。
    const other = await seedWard(env.DB);
    const failedImages: PhotoImages = { input: () => { throw new Error("試しの変換失敗"); } };
    const failureEnv = Object.create(env, { IMAGES: { value: failedImages } }) as typeof runtime;
    const failed = await receive(failureEnv, { wardId: other.wardId, via: "line_direct", parts: [{ kind: "photo", filename: "試しの回答票.jpg", mediaType: "image/jpeg", bytes: original }] });
    if (!failed.jobId) throw new Error("変換失敗の写真を受け付けられませんでした");
    const kept = (await listOriginals(env.DB, other.wardId, failed.jobId))[0]!;
    expect(kept.byte_size).toBe(original.length);
    const keptObject = await new WardBucket(env.ORIGINALS, other.wardId).get(kept.r2_path!);
    expect(keptObject?.customMetadata?.photoResizeFailed).toBe("1");
    expect(await runRead(failureEnv, other.wardId, failed.jobId, { deps: { createClient: () => client } })).toBe("read");
    const unread = await getReadings(env.DB, other.wardId, failed.jobId);
    expect(unread[0]!.body.unreadable).toEqual([{ original_id: kept.original_id, locator: "全体", note: "写真や紙を読み取れませんでした。明るい場所で、紙の全体が入るように撮れますか。" }]);
    expect(modelCalls).toBe(1);
  } finally {
    await Promise.allSettled(tasks);
    setPipelineDeps(null);
    setClientFactory(null);
  }
});
