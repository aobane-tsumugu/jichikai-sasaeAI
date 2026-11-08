import { describe, expect, it } from "vitest";
import { buildDirectReading, parseExtracted } from "../src/intake/direct-reading";
import { CompoundOffice } from "../src/intake/legacy-office-cfb";
import { extractLegacyOffice } from "../src/intake/legacy-office";
import { classifyUpload } from "../src/intake/media";
import { originalDate } from "../src/intake/original-date";
import { biff, biffText, compound, f64, joinBytes, summaryInformation, u16, u32, utf16, wordStreams, workbookStream } from "./fixtures/legacy-office";

describe("古いWordとExcelの見分け", () => {
  const signature = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  it.each([
    ["通知.DOC", "", "word", "application/msword"],
    ["表.xls", "application/octet-stream", "excel", "application/vnd.ms-excel"],
    ["資料", "application/msword", "word", "application/msword"],
    ["資料", "application/vnd.ms-excel", "excel", "application/vnd.ms-excel"],
    ["表.xls", "application/msword", "excel", "application/vnd.ms-excel"],
  ])("複合文書を拡張子か宣言された型で受ける: %s", (filename, type, mediaClass, mediaType) => {
    expect(classifyUpload(signature, type, filename)).toEqual({ mediaClass, mediaType });
  });
  it("ほかの複合文書や、名前だけがdocのバイナリは受けない", () => {
    expect(classifyUpload(signature, "application/vnd.ms-powerpoint", "資料.ppt")).toBeNull();
    for (const filename of ["資料.doc", "資料.xls"]) {
      for (let length = 1; length < signature.length; length++) {
        expect(classifyUpload(signature.subarray(0, length), "application/msword", filename)).toBeNull();
      }
      const wrongSignature = signature.slice();
      wrongSignature[7] = 0;
      expect(classifyUpload(wrongSignature, "application/msword", filename)).toBeNull();
    }
    expect(classifyUpload(new Uint8Array([1, 0, 2, 3]), "application/msword", "資料.doc")).toBeNull();
    expect(classifyUpload(new TextEncoder().encode("%PDF-1.7"), "application/msword", "資料.doc")?.mediaClass).toBe("pdf");
    expect(classifyUpload(joinBytes(signature, new TextEncoder().encode("%PDF-1.7")), "application/msword", "資料.doc")?.mediaClass).toBe("word");
  });
});

describe("複合文書の流れ", () => {
  it.each([512, 4096])("小さい流れと大きい流れをFATの大きさ%dで読む", (size) => {
    const small = utf16("日本語の小さい流れ");
    const large = new Uint8Array(5000).map((_, i) => i % 251);
    const file = new CompoundOffice(compound({ Small: small, Large: large }, size));
    expect(file.stream("Small")).toEqual(small);
    expect(file.stream("Large")).toEqual(large);
    expect(file.stream("無い流れ")).toBeNull();
  });
  it("ヘッダーの外のDIFATからもFATを読む", () => {
    const expected = utf16("外のDIFAT");
    expect(new CompoundOffice(compound({ Text: expected }, 512, true)).stream("Text")).toEqual(expected);
  });
  it("FATの循環を止める", () => {
    const bytes = compound({ Large: new Uint8Array(5000).fill(1) });
    const data = new DataView(bytes.buffer);
    const fatStart = data.getUint32(76, true);
    data.setUint32((fatStart + 1) * 512, 0, true);
    expect(() => new CompoundOffice(bytes).stream("Large")).toThrow();
  });
});

describe("古いWordの本文", () => {
  it.each(["0Table", "1Table"] as const)("%sのpiece tableを通し、日本語と英字を順に読む", (name) => {
    const bytes = compound(wordStreams("日本語の本文\r会場は集会所\r", name, "Notice\r"));
    const result = extractLegacyOffice(bytes, "doc");
    expect(result.unreadable).toBeUndefined();
    expect(result.extracted?.format).toBe("doc");
    expect(result.extracted?.paragraphs).toEqual(["Notice", "日本語の本文", "会場は集会所", ""]);
    expect(parseExtracted(result.extracted)).toEqual(result.extracted);
    expect(buildDirectReading([{ originalId: "word", extracted: result.extracted }]).text_blocks.map((p) => p.text))
      .toEqual(["Notice", "日本語の本文", "会場は集会所"]);
  });
  it("本文の文字数を越えて、ヘッダーや脚注の文字を混ぜない", () => {
    const streams = wordStreams("本文\r脚注の文字\r");
    new DataView(streams.WordDocument!.buffer).setUint32(76, 3, true);
    expect(extractLegacyOffice(compound(streams), "doc").extracted?.paragraphs).toEqual(["本文", ""]);
  });
  it("圧縮したWordの例外の文字を仕様の文字として読む", () => {
    const streams = wordStreams("本文\r", "1Table", "abc");
    streams.WordDocument!.set([0x80, 0x82, 0x93], 1024);
    expect(extractLegacyOffice(compound(streams), "doc").extracted?.paragraphs[0])
      .toBe(String.fromCharCode(0x80, 0x201a, 0x201c) + "本文");
  });
  it("フィールド命令を本文に混ぜず、保存済みの表示を読む", () => {
    const bytes = compound(wordStreams("日付\u0013DATE\u00142026年11月8日\u0015\r"));
    expect(extractLegacyOffice(bytes, "doc").extracted?.paragraphs).toEqual(["日付2026年11月8日", ""]);
  });
  it("壊れたpiece tableとパスワード付きは、読めなかった理由を返す", () => {
    const broken = wordStreams();
    new DataView(broken.WordDocument!.buffer).setUint32(418, 0x7fffffff, true);
    const protectedWord = wordStreams();
    new DataView(protectedWord.WordDocument!.buffer).setUint16(10, 0x0300, true);
    for (const bytes of [compound(broken), compound(protectedWord)]) {
      expect(extractLegacyOffice(bytes, "doc").extracted).toBeUndefined();
      expect(extractLegacyOffice(bytes, "doc").unreadable).toContain("元の資料は預かりました");
    }
  });
});

describe("古いExcelの表", () => {
  it("共有文字列、数、空白の行と列を保って読みに渡す", () => {
    const result = extractLegacyOffice(compound({ Workbook: workbookStream() }), "xls");
    expect(result.unreadable).toBeUndefined();
    expect(result.extracted?.format).toBe("xls");
    expect(result.extracted?.tables).toEqual([{ name: "協賛先", rows: [
      ["相手", "額"], ["商店A", "6000"], [], ["", "", "", "2026-10-24"],
    ] }]);
    expect(parseExtracted(result.extracted)).toEqual(result.extracted);
    const table = buildDirectReading([{ originalId: "excel", extracted: result.extracted }]).tables[0];
    expect(table?.rows.map((row) => [row.locator, row.cells])).toEqual([
      ["1行目", ["相手", "額"]], ["2行目", ["商店A", "6000"]], ["4行目", ["", "", "", "2026-10-24"]],
    ]);
  });
  it("LABEL、RKとMULRK、数式の保存結果、真偽のセルを読む", () => {
    const floatRk = new DataView(f64(1.5).buffer).getUint32(4, true);
    const records = [
      biff(0x0204, u16(0, 0, 0), biffText("当番")),
      biff(0x027e, u16(0, 1, 0), u32((-12 << 2) | 2)),
      biff(0x027e, u16(0, 2, 0), u32(floatRk)),
      biff(0x00bd, u16(1, 1, 0), u32((1234 << 2) | 3), u16(0), u32((42 << 2) | 2), u16(2)),
      biff(0x0205, u16(2, 0, 0), new Uint8Array([1, 0])),
      biff(0x0006, u16(2, 1, 0), f64(7), new Uint8Array(8)),
      biff(0x0006, u16(3, 0, 0), new Uint8Array([0, 0, 0, 0, 0, 0, 0xff, 0xff]), new Uint8Array(8)),
      biff(0x0207, biffText("保存された結果")),
    ];
    const result = extractLegacyOffice(compound({ Book: workbookStream(records) }), "xls");
    expect(result.extracted?.tables[0]?.rows).toEqual([
      ["当番", "-12", "1.5"], ["", "12.34", "42"], ["TRUE", "7"], ["保存された結果"],
    ]);
  });
  it("SSTの文字がCONTINUEをまたぎ、文字幅も変わる場合を読む", () => {
    const sst = [
      biff(0x00fc, u32(2, 2), u16(4), new Uint8Array([1]), utf16("日本")),
      biff(0x003c, new Uint8Array([0, 65, 66]), u16(2), new Uint8Array([1 | 8 | 4]), u16(1), u32(3), utf16("本文"), new Uint8Array([1, 2])),
      biff(0x003c, new Uint8Array([3, 4, 5, 6, 7])),
    ];
    const result = extractLegacyOffice(compound({ Workbook: workbookStream([
      biff(0x00fd, u16(0, 0, 0), u32(0)), biff(0x00fd, u16(0, 1, 0), u32(1)),
    ], { sst }) }), "xls");
    expect(result.extracted?.tables[0]?.rows).toEqual([["日本AB", "本文"]]);
  });
  it("1904年の日付、独自の日付書式と時刻を読み、数の通常書式はそのまま残す", () => {
    const workbook = workbookStream([
      biff(0x0203, u16(0, 0, 1), f64(44857)),
      biff(0x0203, u16(0, 1, 2), f64(0.5)),
      biff(0x0203, u16(0, 2, 3), f64(44857.5)),
      biff(0x0203, u16(0, 3, 0), f64(44857)),
    ], { date1904: true });
    expect(extractLegacyOffice(compound({ Workbook: workbook }), "xls").extracted?.tables[0]?.rows)
      .toEqual([["2026-10-24", "12:00", "2026-10-24 12:00", "44857"]]);
  });
  it("欠けた共有文字列と暗号化ブックは、成功の空の表にしない", () => {
    const missing = workbookStream([biff(0x00fd, u16(0, 0, 0), u32(999))]);
    const raw = workbookStream();
    const encrypted = joinBytes(raw.subarray(0, 20), biff(0x002f, u16(0)), raw.subarray(20));
    for (const workbook of [missing, encrypted]) {
      expect(extractLegacyOffice(compound({ Workbook: workbook }), "xls").extracted).toBeUndefined();
      expect(extractLegacyOffice(compound({ Workbook: workbook }), "xls").unreadable).toBeTruthy();
    }
  });
  it("埋め込みのグラフの前後にあるセルも読み、グラフの数字は混ぜない", () => {
    const result = extractLegacyOffice(compound({ Workbook: workbookStream([
      biff(0x0203, u16(0, 0, 0), f64(1)),
      biff(0x0809, u16(0x0600, 0x0020)),
      biff(0x0203, u16(0, 0, 0), f64(999)),
      biff(0x000a),
      biff(0x0203, u16(1, 0, 0), f64(2)),
    ]) }), "xls");
    expect(result.extracted?.tables[0]?.rows).toEqual([["1"], ["2"]]);
  });
});

describe("複合文書の資料の日付", () => {
  it("SummaryInformationの保存日を優先し、無ければ作成日を読む", async () => {
    const modified = "2025-10-20T12:34:56.000Z";
    const created = "2024-10-20T00:00:00.000Z";
    for (const media of ["word", "excel"] as const) {
      const bytes = compound({ "\u0005SummaryInformation": summaryInformation(modified, created) });
      expect(await originalDate(media, bytes, undefined, Date.now())).toEqual({ date: modified, source: "office_modified" });
      const fallback = compound({ "\u0005SummaryInformation": summaryInformation(undefined, created) });
      expect(await originalDate(media, fallback, undefined)).toEqual({ date: created, source: "office_created" });
    }
  });
  it("文書情報が壊れているときはファイルの日付だけで補う", async () => {
    const bytes = compound({ "\u0005SummaryInformation": new Uint8Array([1, 2, 3]) });
    expect(await originalDate("word", bytes, undefined, 1700000000000)).toEqual({ date: "2023-11-14T22:13:20.000Z", source: "file_last_modified" });
    expect(await originalDate("word", bytes, undefined)).toBeNull();
  });
});
