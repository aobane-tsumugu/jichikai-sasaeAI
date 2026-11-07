import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin, seedWard } from "../src/core/testing";
import { setClientFactory } from "../src/ai/deps";
import { originalDate } from "../src/intake/original-date";
import { SEND_SCRIPT } from "../src/intake/browser-script";
import { receive } from "../src/intake/receive";
import { fictionalDatedWord, makeOriginalDateZip } from "./fixtures/original-dates";
import { fictionalPhonePhoto, fictionalStoredPhoto } from "./fixtures/phone-photo";
import { realApp } from "./helpers";

function officeExtractor() {
  const root: { __sendOffice?: { extractOffice: (bytes: Uint8Array) => Promise<unknown> } } = {};
  new Function("window", SEND_SCRIPT)(root);
  if (!root.__sendOffice) throw new Error("WordとExcelの読み取りがありません");
  return root.__sendOffice.extractOffice;
}

it("WordとExcelのcore.xmlの保存日を優先し、無ければ作成日、両方無ければ端末の日を使う", async () => {
  const extract = officeExtractor();
  const word = await fictionalDatedWord("10月3日", undefined, "2025-09-10T09:00:00Z");
  const excel = await makeOriginalDateZip({
    "xl/workbook.xml": '<workbook><sheets><sheet name="架空の案内" r:id="rId1"/></sheets></workbook>',
    "xl/_rels/workbook.xml.rels": '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    "xl/worksheets/sheet1.xml": '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>2025年の架空の案内</t></is></c></row></sheetData></worksheet>',
    "docProps/core.xml": '<cp:coreProperties><dcterms:modified xsi:type="dcterms:W3CDTF">2025-09-20T10:00:00+09:00</dcterms:modified><dcterms:created>2025-09-10T09:00:00Z</dcterms:created></cp:coreProperties>',
  }, true);
  const fallback = Date.parse("2025-09-01T00:00:00Z");
  expect(await originalDate("word", word, await extract(word), fallback)).toEqual({ date: "2025-09-10T09:00:00Z", source: "office_created" });
  expect(await originalDate("excel", excel, await extract(excel), fallback)).toEqual({ date: "2025-09-20T10:00:00+09:00", source: "office_modified" });
  const noDate = await fictionalDatedWord("10月5日");
  expect(await originalDate("word", noDate, await extract(noDate), fallback)).toEqual({ date: "2025-09-01T00:00:00.000Z", source: "file_last_modified" });
  expect(await originalDate("word", noDate, await extract(noDate))).toBeNull();
});

it("圧縮したPDFの文書情報からも保存日を取り出す", async () => {
  const encoder = new TextEncoder();
  const content = encoder.encode("5 0 << /ModDate (D:20250920103000Z) >>");
  const compressed = new Uint8Array(await new Response(new Blob([content]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer());
  const head = encoder.encode(`%PDF-1.7\n3 0 obj << /Type /ObjStm /N 1 /First 4 /Length ${compressed.length} /Filter /FlateDecode >>\nstream\n`);
  const tail = encoder.encode("\nendstream\nendobj\ntrailer << /Info 5 0 R >>\n%%EOF");
  const pdf = new Uint8Array(head.length + compressed.length + tail.length);
  pdf.set(head); pdf.set(compressed, head.length); pdf.set(tail, head.length + compressed.length);
  expect(await originalDate("pdf", pdf, null)).toEqual({ date: "2025-09-20T10:30:00Z", source: "pdf_modified" });
});

it("PDFは文書情報の保存日、作成日、端末の日の順に取り、本文の日付を保存日と取り違えない", async () => {
  const pdf = (info: string) => new TextEncoder().encode(`%PDF-1.7\n1 0 obj <<${info}>> endobj\n2 0 obj <</Length 40>> stream\n/ModDate (D:20990101000000Z)\nendstream endobj\ntrailer << /Info 1 0 R >>\n%%EOF`);
  expect(await originalDate("pdf", pdf("/ModDate (D:20250920153000+09'00') /CreationDate (D:20250912090000Z)"), null))
    .toEqual({ date: "2025-09-20T15:30:00+09:00", source: "pdf_modified" });
  expect(await originalDate("pdf", pdf("/CreationDate <443A32303235303931323039303030305A>"), null))
    .toEqual({ date: "2025-09-12T09:00:00Z", source: "pdf_created" });
  expect(await originalDate("pdf", pdf("/Title (架空の案内)"), null, Date.parse("2025-09-01T00:00:00Z")))
    .toEqual({ date: "2025-09-01T00:00:00.000Z", source: "file_last_modified" });
  expect(await originalDate("pdf", pdf("/Title (架空の案内)"), null)).toBeNull();
});

function fictionalExifPhoto(): Uint8Array {
  const tiff = new Uint8Array(64);
  const view = new DataView(tiff.buffer);
  tiff.set([0x49, 0x49]);
  view.setUint16(2, 42, true); view.setUint32(4, 8, true);
  view.setUint16(8, 1, true); view.setUint16(10, 0x8769, true); view.setUint16(12, 4, true);
  view.setUint32(14, 1, true); view.setUint32(18, 26, true);
  view.setUint16(26, 1, true); view.setUint16(28, 0x9003, true); view.setUint16(30, 2, true);
  view.setUint32(32, 20, true); view.setUint32(36, 44, true);
  tiff.set(new TextEncoder().encode("2025:09:20 15:30:00\0"), 44);
  const jpeg = new Uint8Array(2 + 4 + 6 + tiff.length + 2);
  jpeg.set([0xff, 0xd8, 0xff, 0xe1]);
  new DataView(jpeg.buffer).setUint16(4, 2 + 6 + tiff.length);
  jpeg.set([0x45, 0x78, 0x69, 0x66, 0, 0], 6);
  jpeg.set(tiff, 12); jpeg.set([0xff, 0xd9], jpeg.length - 2);
  return jpeg;
}

it("写真のEXIF撮影日を取り、LINEの写真に日付が無ければ受付時刻も渡された端末日時も使わない", async () => {
  const bytes = fictionalExifPhoto();
  expect(await originalDate("image", bytes, null, Date.parse("2025-10-01T00:00:00Z")))
    .toEqual({ date: "2025-09-20T15:30:00", source: "exif_original" });
  expect(await originalDate("image", bytes.subarray(0, 14), null)).toBeNull();
  const ward = await seedWard(env.DB);
  const result = await receive(env, { wardId: ward.wardId, via: "line_group", parts: [
    { kind: "photo", filename: "架空の写真.jpg", mediaType: "image/jpeg", bytes: fictionalStoredPhoto(), lastModified: Date.now() },
    { kind: "text", filename: "", mediaType: "text/plain", bytes: new TextEncoder().encode("架空の言葉") },
  ] });
  expect(result.received).toHaveLength(2);
  const dates = await env.DB.prepare("SELECT document_date, document_date_source FROM originals WHERE ward_id = ? AND job_id = ?")
    .bind(ward.wardId, result.jobId).all();
  expect(dates.results).toEqual([{ document_date: null, document_date_source: null }, { document_date: null, document_date_source: null }]);
});

it("写真をJPEGに直す前のFile.lastModifiedが、ブラウザの送信と役員の受付を通って残る", async () => {
  const { ward, cookie } = await seedAdmin(env.DB);
  setClientFactory(() => { throw new Error("架空の試験から実際のAIへは接続しません"); });
  const lastModified = Date.parse("2025-09-20T10:15:00Z");
  const file = new File([fictionalPhonePhoto()], "架空の写真.png", { type: "image/png", lastModified });
  const stored = fictionalStoredPhoto();
  const status = { textContent: "", className: "" };
  const button = { disabled: false };
  let submit: ((event: { preventDefault: () => void }) => Promise<void>) | undefined;
  const form = { action: `http://localhost/${ward.slug}/admin/intake`, elements: { text: { value: "" }, project_id: { value: "" } },
    reset: () => undefined, addEventListener: (_name: string, handler: typeof submit) => { submit = handler; } };
  const inputs = { files: { files: [file], addEventListener: () => undefined }, cam: { files: [], addEventListener: () => undefined } };
  const elements: Record<string, object> = { "send-form": form, "send-status": status, "send-button": button, ...inputs };
  const document = { querySelectorAll: () => [], getElementById: (id: string) => elements[id], createElement: () => ({
    width: 0, height: 0, getContext: () => ({ fillRect: () => undefined, drawImage: () => undefined, fillStyle: "" }),
    toBlob: (callback: (blob: Blob) => void) => callback(new Blob([stored], { type: "image/jpeg" })),
  }) };
  let posted = false;
  const fetch = async (url: string, init: RequestInit) => {
    const data = init.body;
    if (!(data instanceof FormData)) throw new Error("送信がフォームではありません");
    expect(data.get("part_last_modified")).toBe(String(lastModified));
    const sent = data.get("part");
    if (!sent || typeof sent === "string") throw new Error("写真がありません");
    expect(sent.type).toBe("image/jpeg");
    const response = await realApp.fetch(new Request(url, { method: "POST", body: data,
      headers: { cookie, origin: "http://localhost", accept: "application/json" } }), env, { waitUntil: () => undefined, passThroughOnException: () => undefined, props: {} });
    expect(response.status).toBe(200);
    posted = true;
    return response;
  };
  try {
    new Function("window", "document", "createImageBitmap", "fetch", "location", SEND_SCRIPT)({}, document,
      async () => ({ width: 3000, height: 4000, close: () => undefined }), fetch, { assign: () => undefined, reload: () => undefined });
    if (!submit) throw new Error("送信の処理がありません");
    await submit({ preventDefault: () => undefined });
    expect(posted).toBe(true);
    const row = await env.DB.prepare("SELECT document_date, document_date_source FROM originals WHERE ward_id = ?")
      .bind(ward.wardId).first();
    expect(row).toMatchObject({ document_date: "2025-09-20T10:15:00.000Z", document_date_source: "file_last_modified" });
  } finally { setClientFactory(null); }
});
