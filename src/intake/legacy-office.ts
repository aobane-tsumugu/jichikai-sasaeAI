import type { ExtractedDocument } from "./direct-reading";
import { MAX_READING_JSON_BYTES } from "./direct-reading";
import { checked, CompoundOffice, slice, view } from "./legacy-office-cfb";
import { extractLegacyWord } from "./legacy-office-doc";
import { extractLegacyExcel } from "./legacy-office-xls";

/** PowerPoint Documentの記録を順に読む。画像の描画や埋め込み文書の展開はしない。 */
export function extractLegacyPowerPoint(file: CompoundOffice): ExtractedDocument {
  const bytes = file.stream("PowerPoint Document");
  checked(bytes);
  const data = view(bytes);
  const tables: ExtractedDocument["tables"] = [];
  let current: ExtractedDocument["tables"][number] | undefined;
  let slide = 0;
  let records = 0;
  let chars = 0;
  const startSlide = () => {
    current = { name: `スライド${++slide}`, rows: [] };
    tables.push(current);
  };
  const walk = (start: number, end: number, depth: number): void => {
    checked(depth <= 64);
    for (let p = start; p < end;) {
      checked(p + 8 <= end && ++records <= 400_000);
      const version = data.getUint16(p, true) & 15;
      const type = data.getUint16(p + 2, true);
      const size = data.getUint32(p + 4, true);
      const next = p + 8 + size;
      checked(next <= end);
      // SlideContainer、またはSlideListWithTextのSlidePersistAtomを区切りにする。
      if ((type === 1006 && version === 15) || type === 1011) startSlide();
      if (version === 15) walk(p + 8, next, depth + 1);
      else if (type === 4000 || type === 4008) {
        checked(type !== 4000 || size % 2 === 0);
        const raw = slice(bytes, p + 8, size);
        let text = "";
        if (type === 4000) text = new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true }).decode(raw);
        // TextBytesAtomはUTF-16の上位バイトが0の文字。Shift_JISやWindows-1252ではない。
        // https://learn.microsoft.com/en-us/openspecs/office_file_formats/ms-ppt/80aae34b-2699-43fa-9e6a-c560ae790cd7
        else for (const b of raw) text += String.fromCharCode(b);
        chars += text.length;
        checked(chars <= 400_000);
        const paragraphs = text.replace(/\r\n?|\u000b/g, "\n").replace(/\u0000/g, "").split("\n").filter((line) => line.trim());
        if (paragraphs.length) {
          if (!current) { current = { name: "本文", rows: [] }; tables.push(current); }
          current.rows.push(...paragraphs.map((line) => [line]));
        }
      }
      p = next;
    }
  };
  walk(0, bytes.length, 0);
  return { format: "ppt", paragraphs: [], tables };
}

/** 失敗の理由にファイルの中身を含めず、原本を残して既存の「読めなかったところ」へ渡す。 */
export function extractLegacyOffice(bytes: Uint8Array, format: "doc" | "xls" | "ppt"): { extracted?: ExtractedDocument; unreadable?: string } {
  try {
    const file = new CompoundOffice(bytes);
    const extracted = format === "doc" ? extractLegacyWord(file) : format === "xls" ? extractLegacyExcel(file) : extractLegacyPowerPoint(file);
    checked(new TextEncoder().encode(JSON.stringify(extracted)).length <= MAX_READING_JSON_BYTES / 2);
    if (format === "ppt") {
      const empty = extracted.tables.filter((table) => table.rows.length === 0);
      if (empty.length || !extracted.tables.length) return { extracted,
        unreadable: `${empty.length ? empty.map((table) => table.name).join("、") : "本文"}から文字を取り出せませんでした。元の資料は預かりました。古い形式のスライドの画像は読み取れません。` };
    }
    return { extracted };
  } catch {
    return { unreadable: "元の資料は預かりましたが、本文を読み取れませんでした。破損やパスワードによる保護、対応していない書き方の可能性があります。" };
  }
}
