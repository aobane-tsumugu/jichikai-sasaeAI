import { beforeAll, describe, expect, it } from "vitest";
import { SEND_SCRIPT } from "../src/intake/browser-script";
import { buildDirectReading, parseExtracted } from "../src/intake/direct-reading";
import { CompoundOffice } from "../src/intake/legacy-office-cfb";
import { extractLegacyPowerPoint } from "../src/intake/legacy-office";
import { classifyUpload } from "../src/intake/media";
import { originalDate } from "../src/intake/original-date";
import { compound, joinBytes, u32, utf16 } from "./fixtures/legacy-office";
import { powerpointBinary, powerpointFiles, powerpointZip, pptRecord, PPT_TYPE, PPTX_TYPE, SLIDE_IMAGE } from "./fixtures/powerpoint";

interface PptxResult {
  format: string;
  paragraphs: string[];
  tables: { name: string; rows: string[][] }[];
  images: { name: string; type: string; bytes: Uint8Array }[];
  documentDate?: string;
}
let extractOffice: (bytes: Uint8Array) => Promise<PptxResult>;
beforeAll(() => {
  const scope: { __sendOffice?: { extractOffice: typeof extractOffice } } = {};
  new Function("window", SEND_SCRIPT)(scope);
  if (!scope.__sendOffice) throw new Error("展開の関数がありません");
  extractOffice = scope.__sendOffice.extractOffice;
});

describe("PowerPointの読み取り", () => {
  it.each([false, true])("pptxのスライドの順、段落、表、メモと日付を残す（圧縮:%s）", async (compressed) => {
    const bytes = await powerpointZip(powerpointFiles(), compressed);
    const extracted = await extractOffice(bytes);
    expect(extracted).toMatchObject({ format: "pptx", paragraphs: [], images: [], documentDate: "2025-10-20T12:34:56Z" });
    expect(extracted.tables).toEqual([
      { name: "スライド1", rows: [["2025年の準備"], ["受付 & 案内"]] },
      { name: "スライド1 表1", rows: [["担当", "人数"], ["受付\n入口", "2"]] },
      { name: "スライド1 メモ", rows: [["メモの本文"]] },
      { name: "スライド2", rows: [["当日は9時に集合"]] },
    ]);
    const parsed = parseExtracted(extracted);
    expect(parsed?.format).toBe("pptx");
    if (!parsed) throw new Error("pptxの展開の結果を受け取れませんでした");
    const reading = buildDirectReading([{ originalId: "slides", extracted: parsed }]);
    expect(reading.tables.map(table => table.locator)).toEqual(["スライド1", "スライド1 表1", "スライド1 メモ", "スライド2"]);
    expect(reading.tables[1]?.rows[1]?.cells).toEqual(["受付\n入口", "2"]);
    expect(await originalDate("powerpoint", bytes, extracted)).toEqual({ date: "2025-10-20T12:34:56Z", source: "office_modified" });
  });

  it.each([false, true])("画像だけのスライドの埋め込み画像だけを取り出す（圧縮:%s）", async (compressed) => {
    const extracted = await extractOffice(await powerpointZip(powerpointFiles(SLIDE_IMAGE), compressed));
    expect(extracted.images).toEqual([{ name: "スライド2の画像.png", type: "image/png", bytes: SLIDE_IMAGE }]);
    expect(extracted.tables[0]?.rows).toEqual([["2025年の準備"], ["受付 & 案内"]]);
  });

  it("表にだけ文字のあるスライドの画像も取り出さない", async () => {
    const files = powerpointFiles(SLIDE_IMAGE);
    const slide = String(files["ppt/slides/slide2.xml"]);
    files["ppt/slides/slide2.xml"] = slide.replace(/<p:sp>[\s\S]*?<\/p:sp>/, "");
    const result = await extractOffice(await powerpointZip(files));
    expect(result.images.map(image => image.name)).toEqual(["スライド2の画像.png"]);
    expect(result.tables.find(table => table.name === "スライド1 表1")?.rows).toHaveLength(2);
  });

  it("関係の欠けたスライドを黙って省かない", async () => {
    const files = powerpointFiles();
    delete files["ppt/slides/slide2.xml"];
    await expect(extractOffice(await powerpointZip(files))).rejects.toThrow();
  });

  it("pptのUTF-16の日本語と1バイトの文字を別々に読み、スライドで区切る", async () => {
    const bytes = powerpointBinary();
    const result = extractLegacyPowerPoint(new CompoundOffice(bytes));
    expect(result).toEqual({ format: "ppt", paragraphs: [], tables: [
      { name: "スライド1", rows: [["日本語の資料"], ["受付は9時"]] },
      { name: "スライド2", rows: [["A\u0080é"]] },
    ] });
    expect(parseExtracted(result)?.format).toBe("ppt");
    expect(await originalDate("powerpoint", bytes, null)).toEqual({ date: "2025-10-20T12:34:56.000Z", source: "office_modified" });
  });

  it("pptのスライド一覧と図形の入れ子にある文字の記録も順に読む", () => {
    const list = pptRecord(4080, joinBytes(pptRecord(1011, u32(1, 0, 0, 256)),
      pptRecord(4000, utf16("スライド一覧の日本語"))), true);
    const shape = pptRecord(0xf00d, pptRecord(4000, utf16("図形の中の文字")), true);
    const bytes = compound({ "PowerPoint Document": joinBytes(pptRecord(1000, list, true), pptRecord(1006, shape, true)) });
    expect(extractLegacyPowerPoint(new CompoundOffice(bytes)).tables).toEqual([
      { name: "スライド1", rows: [["スライド一覧の日本語"]] },
      { name: "スライド2", rows: [["図形の中の文字"]] },
    ]);
  });

  it("実際の印と拡張子または種類の組み合わせだけを受ける", async () => {
    const pptx = await powerpointZip(powerpointFiles());
    const ppt = powerpointBinary();
    for (const [bytes, ext, type] of [[pptx, "pptx", PPTX_TYPE], [ppt, "ppt", PPT_TYPE]] as const) {
      expect(classifyUpload(bytes, "", `資料.${ext}`)).toEqual({ mediaClass: "powerpoint", mediaType: type });
      expect(classifyUpload(bytes, type, "資料")).toEqual({ mediaClass: "powerpoint", mediaType: type });
      expect(classifyUpload(bytes, "", "資料.bin")).toBeNull();
      expect(classifyUpload(new Uint8Array([0, 1, 0, 2]), type, `資料.${ext}`)).toBeNull();
    }
  });
});
