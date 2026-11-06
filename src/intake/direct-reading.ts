// モデルを通さない読み取り。Word と Excel は役員のブラウザで段落とセルに展開して送られ（L-123）、
// 文字のファイルと一行の文は文字のまま、同じ形の読み取り（src/ai/schema.ts の Reading）にする。
import { DOCUMENT_KINDS, type Reading, type ReadRow, type ReadTable, type TextBlock } from "../ai/schema";

/** ブラウザが展開して送る形。 */
export interface ExtractedDocument {
  format: "docx" | "xlsx";
  /** Word の本文の段落（表の外）。Excel は空 */
  paragraphs: string[];
  /** Word の表、Excel のシート。rows は行ごとのセルの文字 */
  tables: Array<{ name: string; rows: string[][] }>;
}

/** 一つの読み取りに入れる文字の上限。D1 の 1 行は 2 MB までなので、余裕を見て読み取りの JSON を 1.5 MB に抑える。 */
export const MAX_READING_JSON_BYTES = 1_500_000;
const MAX_CELLS = 200_000;

/** 送られた展開の結果を検査して取り出す。形が違えば null。 */
export function parseExtracted(value: unknown): ExtractedDocument | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v.format !== "docx" && v.format !== "xlsx") return null;
  if (!Array.isArray(v.paragraphs) || !Array.isArray(v.tables)) return null;
  if (!v.paragraphs.every((p) => typeof p === "string")) return null;
  let cells = 0;
  const tables: ExtractedDocument["tables"] = [];
  for (const t of v.tables) {
    if (typeof t !== "object" || t === null) return null;
    const table = t as Record<string, unknown>;
    if (typeof table.name !== "string" || !Array.isArray(table.rows)) return null;
    const rows: string[][] = [];
    for (const r of table.rows) {
      if (!Array.isArray(r) || !r.every((c) => typeof c === "string")) return null;
      cells += r.length;
      if (cells > MAX_CELLS) return null;
      rows.push(r as string[]);
    }
    tables.push({ name: table.name, rows });
  }
  return { format: v.format, paragraphs: v.paragraphs as string[], tables };
}

export interface DirectPart {
  originalId: string;
  filename?: string;
  /** 文字（一行の文、文字のファイル）か、展開した Word と Excel */
  text?: string;
  extracted?: ExtractedDocument;
}

/** 書かれた年だけを読む。複数の年があって一つに決まらなければ年不明に留める。 */
function writtenYear(part: DirectPart): number | null {
  // ファイル名に付いたUUIDの区切り（例: -2030-）は、資料に書かれた年ではない。
  const filename = (part.filename ?? "").replace(/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi, "");
  const text = [filename, part.text ?? "", ...(part.extracted?.paragraphs ?? []),
    ...(part.extracted?.tables.flatMap((table) => [table.name, ...table.rows.map((row) => row.join("\t"))]) ?? [])]
    .join("\n").normalize("NFKC");
  const years = new Set<number>();
  for (const match of text.matchAll(/(?<!\d)([12]\d{3})\s*(?:年|[/.\-]\s*\d{1,2}\s*[/.\-]\s*\d{1,2})/g)) {
    years.add(Number(match[1]));
  }
  for (const match of filename.normalize("NFKC").matchAll(/(?:^|[_.\s-])([12]\d{3})(?=$|[_.\s-])/g)) {
    years.add(Number(match[1]));
  }
  for (const match of text.matchAll(/(令和|平成|昭和)\s*(元|\d{1,2})\s*年/g)) {
    const base = match[1] === "令和" ? 2018 : match[1] === "平成" ? 1988 : 1925;
    years.add(base + (match[2] === "元" ? 1 : Number(match[2])));
  }
  return years.size === 1 ? [...years][0]! : null;
}

function rowsOf(table: { name: string; rows: string[][] }, originalId: string): ReadTable {
  // 見出しの行は推測しない（表の上に題の行があることが多い）。空の行は飛ばし、行の番号は元の並び（Excel の行番号）のままにする
  const rows: ReadRow[] = [];
  table.rows.forEach((cells, i) => {
    if (cells.every((c) => c.trim() === "")) return;
    rows.push({ cells, locator: `${i + 1}行目`, confidence: "high" });
  });
  return { name: table.name, original_id: originalId, locator: table.name, columns: [], rows };
}

/** 直接読む原本を、一つの読み取りにまとめる。 */
export function buildDirectReading(parts: DirectPart[]): Reading {
  const textBlocks: TextBlock[] = [];
  const tables: ReadTable[] = [];
  for (const part of parts) {
    if (part.text !== undefined) {
      let n = 0;
      for (const line of part.text.split(/\r?\n/)) {
        n += 1;
        if (line.trim() === "") continue;
        textBlocks.push({ original_id: part.originalId, locator: `${n}行目`, text: line });
      }
    }
    if (part.extracted) {
      part.extracted.paragraphs.forEach((p, i) => {
        if (p.trim() !== "") textBlocks.push({ original_id: part.originalId, locator: `段落${i + 1}`, text: p });
      });
      for (const t of part.extracted.tables) tables.push(rowsOf(t, part.originalId));
    }
  }
  return {
    document_kind: "other" as (typeof DOCUMENT_KINDS)[number],
    original_years: parts.map((part) => ({ original_id: part.originalId, year: writtenYear(part) })),
    summary: "",
    text_blocks: textBlocks,
    fields: [],
    tables,
    decisions: [],
    unreadable: [],
  };
}
