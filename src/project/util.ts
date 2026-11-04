// 束 3 の中の小さな部品。
import { sha256Hex } from "../core/password";

/** キーの順に依らない JSON（同じ中身から同じ文字列を作る）。undefined の属性は落とす。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export async function hashOf(value: unknown): Promise<string> {
  return sha256Hex(stableStringify(value));
}

/** 重複を弾く印。原本の ID、包みの版、手の種類、書く対象から作る（設計書 5.4）。 */
export async function dedupeKeyOf(parts: { ref: string; packVersion: string; hand: string; target: string }): Promise<string> {
  return sha256Hex([parts.ref, parts.packVersion, parts.hand, parts.target].join("\n"));
}

export function sameText(a: string, b: string): boolean {
  return a.normalize("NFKC").replace(/\s+/g, "") === b.normalize("NFKC").replace(/\s+/g, "");
}

/** 画面や問いの文に入れる短い引用（長い中身は切る。切った印を付ける）。 */
export function quote(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
