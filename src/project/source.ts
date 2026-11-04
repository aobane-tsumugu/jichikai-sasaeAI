// 出どころの検査と、今年の中身か参考の中身かの分け方（設計書 5.2、5.4）。呼ぶ側には選ばせない。
import { SOURCE_KINDS, type Source } from "./model";

/** 原本が区の中に実在するかを確かめる口。束 2 の MCP の手が、原本の表を引いて渡す。 */
export type VerifyOriginal = (originalId: string) => Promise<boolean>;

export type SourceCheck = { ok: true } | { ok: false; reason: string };

const MAX_REF = 200;
const MAX_LOCATOR = 200;

function isYear(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1900 && value <= 2200;
}

/**
 * 出どころの形を検査する。実在の確認（原本、アカウント）は apply.ts が口を通して行う。
 * 出どころの無い中身は存在しないので、形が合わなければ理由を返し、呼ぶ側は差分を捨てる。
 */
export function checkSourceShape(source: unknown): SourceCheck {
  if (typeof source !== "object" || source === null) return { ok: false, reason: "出どころがありません" };
  const s = source as Partial<Source>;
  if (typeof s.kind !== "string" || !(SOURCE_KINDS as readonly string[]).includes(s.kind)) {
    return { ok: false, reason: "出どころの種類が合いません" };
  }
  if (s.ref !== undefined && (typeof s.ref !== "string" || s.ref.length === 0 || s.ref.length > MAX_REF)) {
    return { ok: false, reason: "出どころの ID が合いません" };
  }
  if (s.locator !== undefined && (typeof s.locator !== "string" || s.locator.length > MAX_LOCATOR)) {
    return { ok: false, reason: "出どころの箇所が合いません" };
  }
  if (s.year !== undefined && !isYear(s.year)) return { ok: false, reason: "出どころの年が合いません" };
  if (s.qr !== undefined && typeof s.qr !== "boolean") return { ok: false, reason: "出どころの印が合いません" };
  if (s.accountId !== undefined && typeof s.accountId !== "string") return { ok: false, reason: "出どころの入力者が合いません" };

  switch (s.kind) {
    case "original":
      if (!s.ref) return { ok: false, reason: "出どころの原本がありません" };
      return { ok: true };
    case "person":
      if (!s.accountId) return { ok: false, reason: "入力した人が分かりません" };
      return { ok: true };
    case "web_answer":
      if (!s.ref) return { ok: false, reason: "出どころの答えがありません" };
      return { ok: true };
    case "ai_proposal":
      // AI の案は、参考にした年が出どころになる（設計書 5.4）
      if (!isYear(s.year)) return { ok: false, reason: "案の参考にした年がありません" };
      return { ok: true };
    default:
      return { ok: false, reason: "出どころの種類が合いません" };
  }
}

/** 保存する出どころの形（余計な属性を落とし、箇所の既定を入れる）。 */
export function normalizeSource(source: Source): Source {
  const out: Source = { kind: source.kind };
  if (source.ref !== undefined) out.ref = source.ref;
  if (source.kind === "original") out.locator = source.locator?.trim() || "全体";
  else if (source.locator?.trim()) out.locator = source.locator.trim();
  if (source.year !== undefined) out.year = source.year;
  if (source.qr) out.qr = true;
  if (source.accountId !== undefined) out.accountId = source.accountId;
  return out;
}

export type Placement = { scope: "current" } | { scope: "reference"; refYear: number | null };

/**
 * 中身が今年に入るか、年ごとの参考に入るかを、出どころから決める。
 *
 * 今年の中身に入るのは、QR の紙から読んだ物、人の入力、Web の回答、今年の日付のある資料の物、AI の案。
 * 過去の資料の中身は年ごとの参考に入り、年不明の物は参考（年不明）に留まる。
 * AI の案は今年の中身に入るが、出どころの年は参考にした年で、人が直すか決めるまで「案」のまま。
 */
export function placeSource(source: Source, projectYear: number): Placement {
  switch (source.kind) {
    case "person":
    case "web_answer":
    case "ai_proposal":
      return { scope: "current" };
    case "original":
      if (source.qr) return { scope: "current" };
      if (source.year === undefined) return { scope: "reference", refYear: null };
      if (source.year === projectYear) return { scope: "current" };
      return { scope: "reference", refYear: source.year };
  }
}
