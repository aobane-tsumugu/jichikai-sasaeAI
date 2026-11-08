// プログラムだけで小さな資料を組み立てる。外部の資料や人の写真は使わない。
import { compound, joinBytes, summaryInformation, u16, u32, utf16 } from "./legacy-office";

export const PPTX_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
export const PPT_TYPE = "application/vnd.ms-powerpoint";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export async function powerpointZip(files: Record<string, string | Uint8Array>, deflate = false): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [], central: Uint8Array[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const label = new TextEncoder().encode(name);
    const raw = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const bytes = deflate ? new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream("deflate-raw"))).arrayBuffer()) : raw;
    const header = new DataView(new ArrayBuffer(30));
    header.setUint32(0, 0x04034b50, true);
    header.setUint16(4, 20, true);
    header.setUint16(8, deflate ? 8 : 0, true);
    header.setUint32(14, crc32(raw), true);
    header.setUint32(18, bytes.length, true);
    header.setUint32(22, raw.length, true);
    header.setUint16(26, label.length, true);
    chunks.push(new Uint8Array(header.buffer), label, bytes);
    const entry = new DataView(new ArrayBuffer(46));
    entry.setUint32(0, 0x02014b50, true);
    entry.setUint16(4, 20, true);
    entry.setUint16(6, 20, true);
    entry.setUint16(10, deflate ? 8 : 0, true);
    entry.setUint32(16, crc32(raw), true);
    entry.setUint32(20, bytes.length, true);
    entry.setUint32(24, raw.length, true);
    entry.setUint16(28, label.length, true);
    entry.setUint32(42, offset, true);
    central.push(new Uint8Array(entry.buffer), label);
    offset += 30 + label.length + bytes.length;
  }
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, Object.keys(files).length, true);
  end.setUint16(10, Object.keys(files).length, true);
  end.setUint32(12, central.reduce((sum, part) => sum + part.length, 0), true);
  end.setUint32(16, offset, true);
  return joinBytes(...chunks, ...central, new Uint8Array(end.buffer));
}

const p = (text: string) => `<a:p><a:r><a:t>${text}</a:t></a:r></a:p>`;
const slide = (body: string) => `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree>${body}</p:spTree></p:cSld></p:sld>`;
const rels = (entries: string) => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${entries}</Relationships>`;
const relation = (id: string, type: string, target: string, mode = "") => `<Relationship Id="${id}" Type="${REL}${type}" Target="${target}"${mode ? ` TargetMode="${mode}"` : ""}/>`;
const picture = `<p:pic><p:blipFill><a:blip r:embed="photo"/></p:blipFill></p:pic>`;

export function powerpointFiles(photo?: Uint8Array): Record<string, string | Uint8Array> {
  // ファイル名の番号と逆の順を指定し、関係に従うことを確かめる。
  const files: Record<string, string | Uint8Array> = {
    "ppt/presentation.xml": `<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="second"/><p:sldId id="257" r:id="first"/></p:sldIdLst></p:presentation>`,
    "ppt/_rels/presentation.xml.rels": rels(relation("first", "slide", "slides/slide1.xml") + relation("second", "slide", "/ppt/slides/slide2.xml")),
    "ppt/slides/slide2.xml": slide(`<p:sp><p:txBody>${p("2025年の準備")}${p("受付 &amp; 案内")}</p:txBody></p:sp><p:graphicFrame><a:graphic><a:graphicData><a:tbl><a:tblPr/><a:tr><a:tc><a:txBody>${p("担当")}</a:txBody></a:tc><a:tc><a:txBody>${p("人数")}</a:txBody></a:tc></a:tr><a:tr><a:tc><a:txBody>${p("受付")}${p("入口")}</a:txBody></a:tc><a:tc><a:txBody>${p("2")}</a:txBody></a:tc></a:tr></a:tbl></a:graphicData></a:graphic></p:graphicFrame>${photo ? picture : ""}`),
    "ppt/slides/slide1.xml": slide(photo ? picture : `<p:sp><p:txBody>${p("当日は9時に集合")}</p:txBody></p:sp>`),
    "ppt/slides/_rels/slide2.xml.rels": rels(relation("note", "notesSlide", "../notesSlides/notesSlide5.xml") + (photo ? relation("photo", "image", "../media/image1.png") : "")),
    "ppt/notesSlides/notesSlide5.xml": `<p:notes><p:cSld><p:spTree><p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody>${p("メモの本文")}</p:txBody></p:sp><p:sp><p:nvSpPr><p:nvPr><p:ph type="sldNum"/></p:nvPr></p:nvSpPr><p:txBody>${p("99")}</p:txBody></p:sp></p:spTree></p:cSld></p:notes>`,
    "docProps/core.xml": `<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dcterms="http://purl.org/dc/terms/"><dcterms:modified>2025-10-20T12:34:56Z</dcterms:modified></cp:coreProperties>`,
  };
  if (photo) {
    files["ppt/slides/_rels/slide1.xml.rels"] = rels(relation("photo", "image", "../media/image1.png") + relation("remote", "image", "https://example.invalid/image.png", "External"));
    files["ppt/media/image1.png"] = photo;
  }
  return files;
}

export function pptRecord(type: number, body: Uint8Array, container = false): Uint8Array {
  return joinBytes(u16(container ? 15 : 0, type), u32(body.length), body);
}

export function powerpointBinary(noText = false): Uint8Array {
  const text = noText ? pptRecord(1007, new Uint8Array(24)) : pptRecord(4000, utf16("日本語の資料\r受付は9時\r"));
  return compound({
    "PowerPoint Document": joinBytes(pptRecord(1006, text, true),
      pptRecord(1006, noText ? pptRecord(1007, new Uint8Array(24)) : pptRecord(4008, new Uint8Array([0x41, 0x80, 0xe9])), true)),
    "\u0005SummaryInformation": summaryInformation("2025-10-20T12:34:56.000Z"),
  });
}

// 1pxのPNG。人物や文字を含まない。
export const SLIDE_IMAGE = Uint8Array.from(atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aLp8AAAAASUVORK5CYII="), c => c.charCodeAt(0));
