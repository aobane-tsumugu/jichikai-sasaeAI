import { formatDateText } from "../core/time";
import { PENDING } from "../project/document-body";

/** 現在の下書きではなく、印刷する内容から項目を読む。 */
export function publishedItem(body: string, key: string): string | null {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || !("items" in parsed) || !Array.isArray(parsed.items)) return null;
  for (const item of parsed.items) {
    if (item && typeof item === "object" && item.key === key && typeof item.content === "string" && item.content.trim() && item.content.trim() !== PENDING) return item.content.trim();
  }
  return null;
}

export function paperDate(iso: string | null): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric" }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("year")}年${part("month")}月${part("day")}日に配りました`;
}

export function paperDeadline(due: string | null): string {
  return due ? formatDateText(due) : "";
}

/** 書かれている持ち場を時間帯の後ろに添える。持ち場が無ければ補わない。 */
export function paperHelperSlots(raw: string): string {
  const role = "(準備と設営|設営|受付と模擬店|受付|模擬店|片付け)";
  return raw.split(/[、\n]/).map((part) => {
    const value = part.trim();
    const first = new RegExp(`^${role}[：:\\s]+(.+)$`).exec(value);
    const last = new RegExp(`^(.+?)[\\s]+${role}$`).exec(value);
    const task = first?.[1] ?? last?.[2];
    const time = first?.[2] ?? last?.[1];
    return task && time ? `${time}（${task === "準備と設営" ? "設営" : task}）` : value;
  }).filter(Boolean).join("、");
}

/** 締切が日付でなく文の時（「10/9まで（班長の紙で）」）は、文を分けて言い回しを崩さない。 */
export function paperGive(due: string, whom: string): string[] {
  if (!due) return [`${whom}に渡してください。`];
  if (due.endsWith("まで")) return [`${due}に、${whom}に渡してください。`];
  return due.includes("まで") ? [`締切: ${due}`, `${whom}に渡してください。`] : [`${due}までに、${whom}に渡してください。`];
}

/** 配った時に残した部数だけを出す。個人の名前は印刷の帯に出さない。 */
export function paperCopies(raw: string | null): string {
  if (!raw) return "";
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return ""; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  const counts = new Map<string, number>();
  if ("targets" in value && Array.isArray(value.targets)) {
    for (const target of value.targets) {
      if (target && typeof target === "object" && typeof target.district === "string" && typeof target.copies === "number" && target.copies > 0) {
        counts.set(target.district, (counts.get(target.district) ?? 0) + target.copies);
      }
    }
  } else {
    for (const [district, count] of Object.entries(value)) if (typeof count === "number" && count > 0) counts.set(district, count);
  }
  return [...counts].map(([district, count]) => `${district || "班の指定なし"}：${count}部`).join("、");
}
