import { taskKeyOf } from "./template";
import type { MapTaskView } from "../project/types";
import { eventPeriodText, formatJstDate, seasonText, shortDate } from "../core/time";

/** 型の目安と、役員が入れた日を区別して示す。内部の比較には元の日付を使う。 */
export function taskPeriodText(task: MapTaskView, endOnly = false): string {
  const start = task.periodStart;
  const end = task.periodEnd;
  const estimated = task.taskKey !== "day" && "periodEstimated" in task && task.periodEstimated === true;
  const show = estimated ? seasonText : shortDate;
  if (endOnly && end) return `${show(end)}まで`;
  if (start && end) {
    if (!estimated) return eventPeriodText(start, end);
    return show(start) === show(end) ? show(start) : `${show(start)}から${show(end)}`;
  }
  if (start) return `${estimated ? show(start) : formatJstDate(start)}から`;
  if (end) return `${estimated ? show(end) : formatJstDate(end)}まで`;
  return "時期はまだ決まっていません";
}

/** 日付と進み具合だけで案を一つ出す。日付のない仕事も開ける。 */
export function nextMapTask(tasks: readonly MapTaskView[], today: string): MapTaskView | undefined {
  const unfinished = tasks.filter((task) => task.progress !== "done");
  const current = unfinished.filter((task) => (!task.periodStart || task.periodStart <= today) && (!task.periodEnd || task.periodEnd >= today));
  current.sort((a, b) => (a.periodEnd ?? "9999").localeCompare(b.periodEnd ?? "9999") || a.sortOrder - b.sortOrder);
  if (current[0]) return current[0];
  const future = unfinished.filter((task) => task.periodStart && task.periodStart > today);
  future.sort((a, b) => (a.periodStart ?? "9999").localeCompare(b.periodStart ?? "9999") || a.sortOrder - b.sortOrder);
  // 時期を過ぎても仕事を消さず、終わりの日が近いものを開ける。
  return future[0] ?? unfinished.sort((a, b) => (a.periodEnd ?? "9999").localeCompare(b.periodEnd ?? "9999") || a.sortOrder - b.sortOrder)[0];
}

/** 仕事を押した時に開く画面。段取りと最初の画面で同じにする。 */
export function mapTaskPath(projectId: string, _kind: string, task: Pick<MapTaskView, "taskId" | "taskKey"> & { name?: string }): string {
  const key = taskKeyOf(task.taskKey, task.name);
  if (key === "answers" || key === "delegation") return `/answers/${projectId}`;
  if (key === "report") return `/close/${projectId}`;
  return `/projects/${projectId}/map/${task.taskId}`;
}

/** 月の境目で区切る。帯と今日の線も同じ期間を使う。 */
export function mapCalendar(tasks: readonly MapTaskView[], year: number) {
  const dates = tasks.flatMap((task) => [task.periodStart, task.periodEnd]).filter((date): date is string => !!date).sort();
  const first = dates[0] ?? `${year}-01-01`;
  const last = dates.at(-1) ?? `${year}-12-31`;
  const start = Date.UTC(Number(first.slice(0, 4)), Number(first.slice(5, 7)) - 1, 1);
  const end = Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)), 1);
  const span = end - start;
  const months: { label: string; days: number }[] = [];
  for (let at = start; at < end;) {
    const date = new Date(at);
    const next = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
    months.push({ label: `${date.getUTCMonth() + 1}月`, days: (next - at) / 86400000 });
    at = next;
  }
  return { dated: dates.length > 0, months, position: (date: string) => Math.max(0, Math.min(1, (Date.parse(`${date}T00:00:00Z`) - start) / span)), first, last };
}
