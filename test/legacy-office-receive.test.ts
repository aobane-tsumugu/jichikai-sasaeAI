import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedWard } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { receive } from "../src/intake/receive";
import { getReadings, listOriginals } from "../src/intake/store";
import { compound, summaryInformation, wordStreams, workbookStream } from "./fixtures/legacy-office";

it("docとxlsを展開なしで受け取り、原本と資料の日付を残し、本文と行列をAIが引く読み取りへ渡す", async () => {
  const ward = await seedWard(env.DB);
  const other = await seedWard(env.DB);
  const word = compound({ ...wordStreams("2025年の知らせ\r日本語の本文\r"),
    "\u0005SummaryInformation": summaryInformation("2025-10-20T12:34:56.000Z") });
  const excel = compound({ Workbook: workbookStream() });
  const outcome = await receive(env, { wardId: ward.wardId, via: "admin", parts: [
    { kind: "file", filename: "去年の知らせ.doc", mediaType: "application/msword", bytes: word,
      extracted: { format: "doc", paragraphs: ["ブラウザの値では上書きしない"], tables: [] } },
    { kind: "file", filename: "協賛先.xls", mediaType: "application/vnd.ms-excel", bytes: excel, lastModified: 1700000000000 },
  ] });
  expect(outcome.needsModelRead).toBe(false);
  expect(outcome.received).toHaveLength(2);
  if (!outcome.jobId) throw new Error("資料を受け取れませんでした");
  const originals = await listOriginals(env.DB, ward.wardId, outcome.jobId);
  expect(originals.map((o) => [o.media_type, o.document_date, o.document_date_source])).toEqual([
    ["application/msword", "2025-10-20T12:34:56.000Z", "office_modified"],
    ["application/vnd.ms-excel", "2023-11-14T22:13:20.000Z", "file_last_modified"],
  ]);
  const bucket = new WardBucket(env.ORIGINALS, ward.wardId);
  for (const [i, original] of originals.entries()) {
    if (!original.r2_path) throw new Error("原本の保存先がありません");
    const stored = await bucket.get(original.r2_path);
    expect(stored?.httpMetadata?.contentType).toBe(original.media_type);
    expect(stored && new Uint8Array(await stored.arrayBuffer())).toEqual(i === 0 ? word : excel);
    expect(await new WardBucket(env.ORIGINALS, other.wardId).get(original.r2_path)).toBeNull();
  }
  const readings = await getReadings(env.DB, ward.wardId, outcome.jobId);
  expect(readings).toHaveLength(1);
  expect(readings[0]?.body).toMatchObject({
    text_blocks: [{ text: "2025年の知らせ" }, { text: "日本語の本文" }],
    original_years: [{ year: 2025 }, { year: 2026 }],
    tables: [{ name: "協賛先", rows: [
      { locator: "1行目", cells: ["相手", "額"] },
      { locator: "2行目", cells: ["商店A", "6000"] },
      { locator: "4行目", cells: ["", "", "", "2026-10-24"] },
    ] }],
    unreadable: [],
  });
  expect(await getReadings(env.DB, other.wardId, outcome.jobId)).toEqual([]);
  const duplicate = await receive(env, { wardId: ward.wardId, via: "admin", parts: [
    { kind: "file", filename: "別名.doc", mediaType: "", bytes: word },
  ] });
  expect(duplicate.jobId).toBeNull();
  expect(duplicate.duplicates[0]?.originalId).toBe(originals[0]?.original_id);
});

it.each(["doc", "xls"])("壊れた%sも原本を預かり、読めなかったところを残す", async (format) => {
  const ward = await seedWard(env.DB);
  const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 1]);
  const outcome = await receive(env, { wardId: ward.wardId, via: "admin", parts: [
    { kind: "file", filename: `資料.${format}`, mediaType: "", bytes, lastModified: 1700000000000 },
    { kind: "text", filename: "", mediaType: "", bytes: new TextEncoder().encode("ほかの資料は読める") },
  ] });
  if (!outcome.jobId) throw new Error("壊れた資料を預かれませんでした");
  expect(outcome.received).toHaveLength(2);
  const readings = await getReadings(env.DB, ward.wardId, outcome.jobId);
  expect(readings[0]?.body).toMatchObject({
    text_blocks: [{ text: "ほかの資料は読める" }],
    unreadable: [{ original_id: outcome.received[0]?.originalId, locator: "本文", note: expect.stringContaining("元の資料は預かりました") }],
  });
  const originals = await listOriginals(env.DB, ward.wardId, outcome.jobId);
  const path = originals[0]?.r2_path;
  if (!path) throw new Error("壊れた資料の保存先がありません");
  const stored = await new WardBucket(env.ORIGINALS, ward.wardId).get(path);
  expect(stored && new Uint8Array(await stored.arrayBuffer())).toEqual(bytes);
});

it("名前だけがdocのバイナリはこれまでどおり断る", async () => {
  const ward = await seedWard(env.DB);
  await expect(receive(env, { wardId: ward.wardId, via: "admin", parts: [
    { kind: "file", filename: "資料.doc", mediaType: "application/msword", bytes: new Uint8Array([1, 0, 2, 3]) },
  ] })).rejects.toMatchObject({ code: "unsupported" });
});
