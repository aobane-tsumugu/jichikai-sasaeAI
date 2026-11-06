// ブラウザで動かす Word と Excel の展開（src/intake/browser-script.ts）を、Workers の中で動かして確かめる。
import { beforeAll, describe, expect, it } from "vitest";
import { SEND_SCRIPT } from "../src/intake/browser-script";
import { buildDirectReading, parseExtracted } from "../src/intake/direct-reading";
import { classifyUpload, decodeText } from "../src/intake/media";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 試験用の zip を作る。method 0（そのまま）と 8（deflate）の両方を試せる。 */
async function makeZip(files: Record<string, string>, deflate: boolean): Promise<Uint8Array> {
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = enc.encode(name);
    const raw = enc.encode(text);
    const data = deflate ? await deflateRaw(raw) : raw;
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(8, deflate ? 8 : 0, true);
    header.setUint32(14, crc32(raw), true);
    header.setUint32(18, data.length, true);
    header.setUint32(22, raw.length, true);
    header.setUint16(26, nameBytes.length, true);
    chunks.push(new Uint8Array(header.buffer), nameBytes, data);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(10, deflate ? 8 : 0, true);
    entry.setUint32(16, crc32(raw), true);
    entry.setUint32(20, data.length, true);
    entry.setUint32(24, raw.length, true);
    entry.setUint16(28, nameBytes.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const centralSize = central.reduce((n, c) => n + c.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  const all = [...chunks, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, c) => n + c.length, 0));
  let pos = 0;
  for (const c of all) {
    out.set(c, pos);
    pos += c.length;
  }
  return out;
}

const DOCX = {
  "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="x"><w:body>
<w:p><w:pPr><w:pStyle w:val="a"/></w:pPr><w:r><w:t>お知らせ</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">10月25日 </w:t></w:r><w:r><w:tab/><w:t>11時 &amp; 雨は&#x516C;民館</w:t></w:r></w:p>
<w:tbl><w:tblPr/><w:tr><w:tc><w:p><w:r><w:t>相手</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>額</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>商店A</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>6000</w:t></w:r></w:p><w:p><w:r><w:t>円</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p/><w:p><w:r><w:t>末尾</w:t></w:r></w:p><w:sectPr/></w:body></w:document>`,
};

const XLSX = {
  "xl/workbook.xml": `<workbook><sheets><sheet name="協賛先" sheetId="1" r:id="rId1"/><sheet name="メモ" sheetId="2" r:id="rId2"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Target="/xl/worksheets/sheet2.xml"/></Relationships>`,
  "xl/sharedStrings.xml": `<sst><si><t>相手</t></si><si><t>額</t></si><si><r><t>商店</t></r><r><t>A</t></r><rPh><t>ショウテン</t></rPh></si><si><t>日付</t></si></sst>`,
  "xl/styles.xml": `<styleSheet><numFmts><numFmt numFmtId="164" formatCode="yyyy/m/d"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="164"/><xf numFmtId="14"/></cellXfs></styleSheet>`,
  "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="s"><v>3</v></c></row>
<row r="2"><c r="A2" t="s"><v>2</v></c><c r="B2"><v>6000</v></c><c r="C2" s="2"/><c r="D2" s="1"><v>46319</v></c></row>
<row r="4"><c r="A4" t="inlineStr"><is><t>手入力 &lt;x&gt;</t></is></c><c r="B4" t="b"><v>1</v></c></row>
</sheetData></worksheet>`,
  "xl/worksheets/sheet2.xml": `<worksheet><sheetData><row r="1"><c r="A1" t="str"><f>1+1</f><v>結果</v></c></row></sheetData></worksheet>`,
};

let extractOffice: (buffer: ArrayBuffer | Uint8Array) => Promise<unknown>;

beforeAll(() => {
  // 画面の外（document が無い所）で読み込むと、展開の関数だけが globalThis に付く
  new Function(SEND_SCRIPT)();
  extractOffice = (globalThis as unknown as { __sendOffice: { extractOffice: typeof extractOffice } }).__sendOffice.extractOffice;
});

describe("Wordの展開", () => {
  for (const deflate of [false, true]) {
    it(`段落と表を取り出す（${deflate ? "deflate" : "そのまま"}のzip）`, async () => {
      const zip = await makeZip(DOCX, deflate);
      expect(await extractOffice(zip)).toEqual({
        format: "docx",
        paragraphs: ["お知らせ", "10月25日 \t11時 & 雨は公民館", "末尾"],
        tables: [
          {
            name: "表1",
            rows: [
              ["相手", "額"],
              ["商店A", "6000\n円"],
            ],
          },
        ],
      });
    });
  }
});

describe("Excelの展開", () => {
  for (const deflate of [false, true]) {
    it(`シートごとの表にする（${deflate ? "deflate" : "そのまま"}のzip）`, async () => {
      const zip = await makeZip(XLSX, deflate);
      expect(await extractOffice(zip)).toEqual({
        format: "xlsx",
        paragraphs: [],
        tables: [
          {
            name: "協賛先",
            rows: [
              ["相手", "額", "", "日付"],
              // 3 列目の空のセルは飛ぶ。日付の書式のセルは日付の文字になる。ルビは入らない
              ["商店A", "6000", "", "2026-10-24"],
              [],
              ["手入力 <x>", "TRUE"],
            ],
          },
          { name: "メモ", rows: [["結果"]] },
        ],
      });
    });
  }

  it("要素に接頭辞が付いたExcelも同じに読む", async () => {
    const prefixed = Object.fromEntries(Object.entries(XLSX).map(([name, xml]) => [name, name.endsWith(".rels") ? xml : xml.replace(/<(\/?)(?=[a-zA-Z])/g, "<$1x:")]));
    const plain = await extractOffice((await makeZip(XLSX, false)).buffer as ArrayBuffer);
    expect(await extractOffice((await makeZip(prefixed, false)).buffer as ArrayBuffer)).toEqual(plain);
  });

  it("1904年日付システムのExcelも、同じ日付を書いた通常のExcelと同じに読む", async () => {
    // 架空の表の2026年10月24日を、1904年からの日数で保存したブックにする。
    const date1904 = {
      ...XLSX,
      "xl/workbook.xml": XLSX["xl/workbook.xml"].replace("<workbook>", '<workbook><workbookPr date1904="1"/>'),
      "xl/worksheets/sheet1.xml": XLSX["xl/worksheets/sheet1.xml"].replace("<v>46319</v>", "<v>44857</v>"),
    };
    expect(await extractOffice(await makeZip(date1904, false)))
      .toEqual(await extractOffice(await makeZip(XLSX, false)));
  });

  it("日付の型のセルを年月日で読む", async () => {
    const sheet = XLSX["xl/worksheets/sheet1.xml"].replace("</sheetData>", '<row r="9"><c r="A9" t="d"><v>2026-10-22T00:00:00.000Z</v></c></row></sheetData>');
    const result = await extractOffice(await makeZip({ ...XLSX, "xl/worksheets/sheet1.xml": sheet }, false)) as { tables: { rows: string[][] }[] };
    expect(JSON.stringify(result.tables)).toContain("2026-10-22");
  });

  it("当番表の時刻には架空の日付を付けず、年月日と日ときはそのまま読む", async () => {
    const workbook = {
      ...XLSX,
      "xl/styles.xml": `<styleSheet><numFmts>
        <numFmt numFmtId="164" formatCode="hh:mm"/>
        <numFmt numFmtId="165" formatCode="yyyy/m/d h:mm"/>
        </numFmts><cellXfs><xf numFmtId="20"/><xf numFmtId="21"/>
        <xf numFmtId="164"/><xf numFmtId="14"/><xf numFmtId="165"/>
        </cellXfs></styleSheet>`,
      "xl/worksheets/sheet1.xml": `<worksheet><sheetData>
        <row r="1"><c r="A1" t="inlineStr"><is><t>開始時刻</t></is></c>
          <c r="B1" s="0"><v>0</v></c><c r="C1" s="0"><v>0.5</v></c></row>
        <row r="2"><c r="A2" t="inlineStr"><is><t>秒のある時刻</t></is></c>
          <c r="B2" s="1"><v>${(12 * 3600 + 34 * 60 + 56) / 86400}</v></c></row>
        <row r="3"><c r="A3" t="inlineStr"><is><t>独自の時刻書式</t></is></c>
          <c r="B3" s="2"><v>0.25</v></c></row>
        <row r="4"><c r="A4" s="3"><v>46319</v></c><c r="B4" s="4"><v>46319.5</v></c></row>
        </sheetData></worksheet>`,
    };
    const result = await extractOffice(await makeZip(workbook, false)) as { tables: { rows: string[][] }[] };
    expect(result.tables[0]!.rows).toEqual([
      ["開始時刻", "00:00", "12:00"],
      ["秒のある時刻", "12:34:56"],
      ["独自の時刻書式", "06:00"],
      ["2026-10-24", "2026-10-24 12:00"],
    ]);
  });

  it("zipでない物は開けない", async () => {
    await expect(extractOffice(new Uint8Array([1, 2, 3, 4]))).rejects.toThrow();
  });
});

describe("展開した結果の検査と読み取りへの変換", () => {
  it("形が違う物を弾く", () => {
    expect(parseExtracted(null)).toBeNull();
    expect(parseExtracted({ format: "pdf", paragraphs: [], tables: [] })).toBeNull();
    expect(parseExtracted({ format: "docx", paragraphs: [1], tables: [] })).toBeNull();
    expect(parseExtracted({ format: "xlsx", paragraphs: [], tables: [{ name: "a", rows: [[1]] }] })).toBeNull();
    expect(parseExtracted({ format: "xlsx", paragraphs: [], tables: [{ name: "a", rows: [["x"]] }] })).not.toBeNull();
  });

  it("表は見出しの行を推測せず、空の行を飛ばし、行の番号は元のまま", () => {
    const reading = buildDirectReading([
      {
        originalId: "o1",
        extracted: {
          format: "xlsx",
          paragraphs: [],
          tables: [{ name: "協賛先", rows: [["相手", "額"], ["商店A", "6000"], [], ["農園B", "3000"]] }],
        },
      },
      { originalId: "o2", text: "公民館25日で押さえた\n\n雨は屋内" },
    ]);
    expect(reading.tables).toEqual([
      {
        name: "協賛先",
        original_id: "o1",
        locator: "協賛先",
        columns: [],
        rows: [
          { cells: ["相手", "額"], locator: "1行目", confidence: "high" },
          { cells: ["商店A", "6000"], locator: "2行目", confidence: "high" },
          { cells: ["農園B", "3000"], locator: "4行目", confidence: "high" },
        ],
      },
    ]);
    expect(reading.text_blocks).toEqual([
      { original_id: "o2", locator: "1行目", text: "公民館25日で押さえた" },
      { original_id: "o2", locator: "3行目", text: "雨は屋内" },
    ]);
  });
});

describe("種類の見分け", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  it("先頭のバイトで見て、ブラウザの言う種類は信じない", () => {
    expect(classifyUpload(jpeg, "application/pdf", "a.pdf")?.mediaType).toBe("image/jpeg");
    expect(classifyUpload(new TextEncoder().encode("%PDF-1.7 xx"), "", "x")?.mediaClass).toBe("pdf");
    expect(classifyUpload(new Uint8Array([0x50, 0x4b, 3, 4, 0]), "", "a.docx")?.mediaClass).toBe("word");
    expect(classifyUpload(new Uint8Array([0x50, 0x4b, 3, 4, 0]), "", "a.xlsx")?.mediaClass).toBe("excel");
    expect(classifyUpload(new Uint8Array([0x50, 0x4b, 3, 4, 0]), "", "a.zip")).toBeNull();
    expect(classifyUpload(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0]), "", "a.doc")).toBeNull();
    expect(classifyUpload(new TextEncoder().encode("こんにちは"), "text/plain", "a.txt")?.mediaClass).toBe("text");
    expect(classifyUpload(new Uint8Array([0, 1, 2, 3]), "text/plain", "a.txt")).toBeNull();
    expect(classifyUpload(new Uint8Array(), "image/jpeg", "a.jpg")).toBeNull();
  });

  it("文字のファイルはUTF-8（BOM付きも）とShift_JISを読める", () => {
    expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, 0xe3, 0x81, 0x82]))).toBe("あ");
    expect(decodeText(new Uint8Array([0x82, 0xa0]))).toBe("あ");
  });
});
