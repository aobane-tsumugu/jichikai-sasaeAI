const jst = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** 画面に出す日時（日本時間）。例 11月5日 13:04 */
export function formatJst(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const part = (type: string) => jst.formatToParts(date).find((p) => p.type === type)?.value ?? "";
  return `${part("month")}月${part("day")}日 ${part("hour")}:${part("minute")}`;
}

const jstDate = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short",
});

/** 日付だけを出す（日本時間）。例 10月24日（土）。日付の入力欄と比較用の値は元の形式を保つ。 */
export function formatJstDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const parts = jstDate.formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${part("month")}月${part("day")}日（${part("weekday")}）`;
}

/** 以前に記録した仕事の時期にも対応する。手で書いた言葉は保つ。 */
export function formatDateText(text: string): string {
  return text.replace(/\b\d{4}-\d{2}-\d{2}\b/g, (date) => formatJstDate(date) || date);
}
