import type { ExtractedDocument } from "./direct-reading";
import { MAX_READING_JSON_BYTES } from "./direct-reading";
import { checked, CompoundOffice } from "./legacy-office-cfb";
import { extractLegacyWord } from "./legacy-office-doc";
import { extractLegacyExcel } from "./legacy-office-xls";

/** 失敗の理由にファイルの中身を含めず、原本を残して既存の「読めなかったところ」へ渡す。 */
export function extractLegacyOffice(bytes: Uint8Array, format: "doc" | "xls"): { extracted?: ExtractedDocument; unreadable?: string } {
  try {
    const file = new CompoundOffice(bytes);
    const extracted = format === "doc" ? extractLegacyWord(file) : extractLegacyExcel(file);
    checked(new TextEncoder().encode(JSON.stringify(extracted)).length <= MAX_READING_JSON_BYTES / 2);
    return { extracted };
  } catch {
    return { unreadable: "元の資料は預かりましたが、本文を読み取れませんでした。破損やパスワードによる保護、対応していない書き方の可能性があります。" };
  }
}
