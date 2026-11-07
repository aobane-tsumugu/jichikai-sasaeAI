const jst = new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo",
  month: "numeric",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

/** 月と日だけの短い日付。例 9月24日 */
export const shortDate = (date: string) => `${Number(date.slice(5, 7))}月${Number(date.slice(8, 10))}日`;

/** 仕事の時期。同じ月なら終わりの月を省く。例 9月9日から24日 */
export function periodText(start: string, end: string): string {
  return `${shortDate(start)}から${start.slice(0, 7) === end.slice(0, 7) ? `${Number(end.slice(8, 10))}日` : shortDate(end)}`;
}

/** 型から数えた目安。決まった日と取り違えないよう、旬で示す。 */
export function seasonText(date: string): string {
  const day = Number(date.slice(8, 10));
  return `${Number(date.slice(5, 7))}月${day <= 10 ? "上旬" : day <= 20 ? "中旬" : "下旬"}`;
}

/** 実施の日は一日でも期間でも、日と曜日で示す。 */
export function eventPeriodText(start: string, end = start): string {
  if (start === end) return formatJstDate(start);
  const last = start.slice(0, 7) === end.slice(0, 7)
    ? formatJstDate(end).replace(/^\d+月/, "") : formatJstDate(end);
  return `${formatJstDate(start)}から${last}`;
}

export function isCalendarDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day)) && new Date(day).toISOString().slice(0, 10) === day;
}

/** 画面に出す日時（日本時間）。例 11月5日 13:04 */
export function formatJst(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const part = (type: string) => jst.formatToParts(date).find((p) => p.type === type)?.value ?? "";
  return `${part("month")}月${part("day")}日${part("hour")}:${part("minute")}`;
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

/** 資料の日時から日を読む。年がなければ行事の年を使い、存在しない日は返さない。 */
function parseSingleEventDay(text: string, projectYear: number): string | null {
  const value = text.normalize("NFKC");
  const dated = value.match(/(?:^|[^\d])(?:(\d{4})\s*[年/\-]\s*|(令和|平成|昭和)\s*(元|\d{1,2})\s*年\s*)(\d{1,2})\s*[月/\-]\s*(\d{1,2})(?:\s*日)?(?!\d)/);
  let year = projectYear;
  let month: string;
  let day: string;
  if (dated) {
    const eraYear = dated[3] === "元" ? 1 : Number(dated[3]);
    year = dated[1] ? Number(dated[1]) : (dated[2] === "令和" ? 2018 : dated[2] === "平成" ? 1988 : 1925) + eraYear;
    if (!dated[1] && eraYear < 1) return null;
    month = dated[4]!;
    day = dated[5]!;
  } else {
    const undated = value.match(/(?:^|[^\d/年\-])(\d{1,2})\s*(?:月\s*(\d{1,2})\s*日|\/\s*(\d{1,2}))(?!\d)/);
    if (!undated) return null;
    month = undated[1]!;
    day = (undated[2] ?? undated[3])!;
  }
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  return isCalendarDay(iso) ? iso : null;
}

/** 終わりが書かれていないときは同じ日。時刻の「10:00〜12:00」は期間の日にしない。 */
export function parseEventDay(text: string, projectYear: number, edge: "start" | "end" = "start"): string | null {
  const value = text.normalize("NFKC");
  const range = value.match(/(?:〜|~|～|から)\s*(\d{4}\s*-\s*\d{1,2}\s*-\s*\d{1,2}(?!\d)|(?:(?:\d{4}\s*[年/\-]|(?:令和|平成|昭和)\s*(?:元|\d{1,2})\s*年)\s*)?\d{1,2}\s*(?:月\s*\d{1,2}\s*日|\/\s*\d{1,2})|\d{1,2}\s*日)/);
  const start = parseSingleEventDay(range ? value.slice(0, range.index) : value, projectYear);
  if (!start) return null;
  if (!range) return start;
  const tail = /^\d{1,2}\s*日$/.test(range[1]!) ? `${Number(start.slice(5, 7))}月${range[1]}` : range[1]!;
  let end = parseSingleEventDay(tail, Number(start.slice(0, 4)));
  // 年を省いた年越しの期間だけ、翌年と読む。
  if (end && end < start && !/(?:\d{4}\s*[年/\-]|令和|平成|昭和)/.test(tail) && Number(end.slice(5, 7)) < Number(start.slice(5, 7))) {
    end = parseSingleEventDay(tail, Number(start.slice(0, 4)) + 1);
  }
  if (!end || end < start) return null;
  return edge === "end" ? end : start;
}
