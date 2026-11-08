import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { buildContent } from "../src/ai/read";
import { WardBucket } from "../src/core/storage";
import { seedWard } from "../src/core/testing";
import { SEND_SCRIPT } from "../src/intake/browser-script";
import { receive, type ReceiveOutcome, type ReceivePart } from "../src/intake/receive";
import { getReadings, listOriginals } from "../src/intake/store";
import { compound, joinBytes, u16, u32, utf16 } from "./fixtures/legacy-office";
import { fictionalStoredPhoto } from "./fixtures/phone-photo";
import { powerpointBinary, powerpointFiles, powerpointZip, pptRecord, PPT_TYPE, PPTX_TYPE, SLIDE_IMAGE } from "./fixtures/powerpoint";

function officeReader(): (bytes: Uint8Array) => Promise<unknown> {
  const scope: { __sendOffice?: { extractOffice: (bytes: Uint8Array) => Promise<unknown> } } = {};
  new Function("window", SEND_SCRIPT)(scope);
  if (!scope.__sendOffice) throw new Error("展開の関数がありません");
  return scope.__sendOffice.extractOffice;
}

it("pptxとpptを受け取り、原本と日付、スライドの場所を残す", async () => {
  const ward = await seedWard(env.DB), other = await seedWard(env.DB);
  const pptx = await powerpointZip(powerpointFiles());
  const ppt = powerpointBinary();
  const outcome = await receive(env, { wardId: ward.wardId, via: "admin", parts: [
    { kind: "file", filename: "準備の資料.pptx", mediaType: PPTX_TYPE, bytes: pptx, extracted: await officeReader()(pptx) },
    { kind: "file", filename: "前の資料.ppt", mediaType: PPT_TYPE, bytes: ppt,
      extracted: { format: "ppt", paragraphs: ["送信側の文字で置き換えない"], tables: [] } },
  ] });
  expect(outcome.needsModelRead).toBe(false);
  expect(outcome.received).toHaveLength(2);
  if (!outcome.jobId) throw new Error("PowerPointの資料を受け取れませんでした");
  const originals = await listOriginals(env.DB, ward.wardId, outcome.jobId);
  expect(originals.map(original => [original.media_type, original.document_date, original.document_date_source])).toEqual([
    [PPTX_TYPE, "2025-10-20T12:34:56Z", "office_modified"],
    [PPT_TYPE, "2025-10-20T12:34:56.000Z", "office_modified"],
  ]);
  for (const [i, original] of originals.entries()) {
    if (!original.r2_path) throw new Error("資料の保存先がありません");
    const stored = await new WardBucket(env.ORIGINALS, ward.wardId).get(original.r2_path);
    expect(stored && new Uint8Array(await stored.arrayBuffer())).toEqual(i === 0 ? pptx : ppt);
    expect(await new WardBucket(env.ORIGINALS, other.wardId).get(original.r2_path)).toBeNull();
  }
  const readings = await getReadings(env.DB, ward.wardId, outcome.jobId);
  expect(readings).toHaveLength(1);
  expect(readings[0]?.body).toMatchObject({ tables: [
    { name: "スライド1", rows: [{ cells: ["2025年の準備"] }, { cells: ["受付 & 案内"] }] },
    { name: "スライド1 表1", rows: [{ cells: ["担当", "人数"] }, { cells: ["受付\n入口", "2"] }] },
    { name: "スライド1 メモ", rows: [{ cells: ["メモの本文"] }] },
    { name: "スライド2", rows: [{ cells: ["当日は9時に集合"] }] },
    { name: "スライド1", rows: [{ cells: ["日本語の資料"] }, { cells: ["受付は9時"] }] },
    { name: "スライド2", rows: [{ cells: ["A\u0080é"] }] },
  ], unreadable: [] });
  expect(await getReadings(env.DB, other.wardId, outcome.jobId)).toEqual([]);
  await expect(receive(env, { wardId: ward.wardId, via: "admin", parts: [
    { kind: "file", filename: "形式が違う.pptx", mediaType: PPTX_TYPE, bytes: pptx, extracted: { format: "docx", paragraphs: ["別の形式"], tables: [] } },
  ] })).rejects.toMatchObject({ code: "needs_expansion" });
});

it.each(["画像だけ", "壊れた記録", "奇数のUTF-16"])("pptの%sも断らず、読めなかったことを残す", async (condition) => {
  const ward = await seedWard(env.DB);
  const bytes = condition === "画像だけ" ? powerpointBinary(true) : compound({ "PowerPoint Document":
    condition === "奇数のUTF-16" ? pptRecord(4000, new Uint8Array([0x42]))
      : joinBytes(u16(0, 4000), u32(100), utf16("途中")) });
  const result = await receive(env, { wardId: ward.wardId, via: "admin", parts: [
    { kind: "file", filename: "資料.ppt", mediaType: PPT_TYPE, bytes },
  ] });
  expect(result.received).toHaveLength(1);
  expect(result.needsModelRead).toBe(false);
  if (!result.jobId) throw new Error("読めない資料を預かれませんでした");
  const readings = await getReadings(env.DB, ward.wardId, result.jobId);
  expect(readings[0]?.body.unreadable).toEqual([{ original_id: result.received[0]?.originalId, locator: "本文", note: expect.stringContaining("元の資料は預かりました") }]);
  if (condition === "画像だけ") expect(readings[0]?.body.unreadable[0]?.note).toContain("画像は読み取れません");
  const original = (await listOriginals(env.DB, ward.wardId, result.jobId))[0];
  if (!original?.r2_path) throw new Error("原本が保存されていません");
  const stored = await new WardBucket(env.ORIGINALS, ward.wardId).get(original.r2_path);
  expect(stored && new Uint8Array(await stored.arrayBuffer())).toEqual(bytes);
});

it("pptxをブラウザで送ると、画像だけのスライドの画像が写真の処理を通り、画像として読みに渡る", async () => {
  const ward = await seedWard(env.DB);
  const bytes = await powerpointZip(powerpointFiles(SLIDE_IMAGE));
  const file = new File([bytes], "準備の資料.pptx", { type: PPTX_TYPE });
  const storedPhoto = fictionalStoredPhoto();
  let submit: ((event: { preventDefault(): void }) => Promise<void>) | undefined;
  const form = { action: "/send", elements: { text: { value: "" } }, reset: vi.fn(),
    addEventListener: (_name: string, handler: typeof submit) => { submit = handler; } };
  const status = { textContent: "", className: "" }, button = { disabled: false };
  const elements = new Map<string, unknown>([["send-form", form], ["send-status", status], ["send-button", button], ["files", { files: [file] }]]);
  const document = { getElementById: (id: string) => elements.get(id) ?? null, querySelectorAll: () => [form].filter(item => "photoForm" in item) };
  const scope: { __sendPhoto?: { preparePhoto: (file: File) => Promise<{ file: Blob; sourceHash: string; lastModified: number }> } } = {};
  let outcome: ReceiveOutcome | undefined;
  const send = async (_path: string, init: RequestInit) => {
    if (!(init.body instanceof FormData)) throw new Error("送信の本文がありません");
    const parts = init.body.getAll("part"), extracted = init.body.getAll("part_extracted");
    expect(parts).toHaveLength(2);
    expect(init.body.getAll("part_kind")).toEqual(["file", "photo"]);
    const input: ReceivePart[] = [];
    for (const [i, part] of parts.entries()) {
      if (typeof part === "string") throw new Error("資料のファイルがありません");
      input.push({ kind: i === 0 ? "file" : "photo", filename: part.name, mediaType: part.type,
        bytes: new Uint8Array(await part.arrayBuffer()), extracted: extracted[i] ? JSON.parse(String(extracted[i])) as unknown : undefined });
    }
    expect(input[1]?.filename).toBe("準備の資料 スライド2の画像.jpg");
    outcome = await receive(env, { wardId: ward.wardId, via: "admin", parts: input });
    return Response.json({ ok: true, message: "受け取りました" });
  };
  new Function("window", "document", "fetch", "location", SEND_SCRIPT)(scope, document, send, { reload: vi.fn() });
  if (!scope.__sendPhoto || !submit) throw new Error("送信の処理がありません");
  const prepare = vi.fn(async (selected: File) => {
    // 写真変換の呼び出しだけを差し替える。画像から文字を認識した証拠にはしない。
    if (selected.name.endsWith(".pptx")) return { file: selected, sourceHash: "", lastModified: selected.lastModified };
    expect(selected.name).toBe("準備の資料 スライド2の画像.png");
    expect(new Uint8Array(await selected.arrayBuffer())).toEqual(SLIDE_IMAGE);
    return { file: new Blob([storedPhoto], { type: "image/jpeg" }), sourceHash: "1".repeat(64), lastModified: selected.lastModified };
  });
  scope.__sendPhoto.preparePhoto = prepare;
  await submit({ preventDefault: vi.fn() });
  expect(status.textContent).toBe("受け取りました");
  expect(prepare).toHaveBeenCalledTimes(2);
  if (!outcome?.jobId) throw new Error("送った資料を受け取れませんでした");
  expect(outcome.needsModelRead).toBe(true);
  const originals = await listOriginals(env.DB, ward.wardId, outcome.jobId);
  expect(originals.map(original => original.media_type)).toEqual([PPTX_TYPE, "image/jpeg"]);
  const image = originals[1];
  if (!image?.r2_path) throw new Error("スライドの画像がありません");
  const saved = await new WardBucket(env.ORIGINALS, ward.wardId).get(image.r2_path);
  if (!saved) throw new Error("保管した画像を取得できません");
  const content = buildContent([{ originalId: image.original_id, filename: image.filename, mediaType: image.media_type,
    position: image.position, bytes: new Uint8Array(await saved.arrayBuffer()) }]);
  expect(content).toMatchObject([
    { type: "text", text: expect.stringContaining("準備の資料 スライド2の画像.jpg") },
    { type: "image", source: { type: "base64", media_type: "image/jpeg" } },
    { type: "text", text: "上の原本を読んで、指定の形の JSON で返してください。" },
  ]);
  const block = content[1];
  if (block?.type !== "image" || block.source.type !== "base64") throw new Error("画像として読みに渡っていません");
  expect(Uint8Array.from(atob(block.source.data), c => c.charCodeAt(0))).toEqual(storedPhoto);
});
