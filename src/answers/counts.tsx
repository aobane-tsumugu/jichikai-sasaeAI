import type { AnswerInput } from "./api";
import { DEFAULT_ANSWER_LABELS, parseAnswerLabels, type AnswerLabels } from "../settings/answer-labels";

export const COUNT_FIELDS = ["children_count", "adults_count", "seniors_count"] as const;
type Counts = Pick<AnswerInput, "peopleCount" | "childrenCount" | "adultsCount" | "seniorsCount">;

/** 古い答えは合計だけを保つ。新しい欄の空欄は0人。 */
export function parseAnswerCounts(form: Record<string, unknown>): Counts | null {
  // 既に開いている古い画面からの人数だけの送信も受ける。新しい画面では出欠の選択が必須。
  if (form.attend === "no") return { peopleCount: 0, childrenCount: 0, adultsCount: 0, seniorsCount: 0 };
  if (form.attend !== undefined && form.attend !== "yes") return null;
  const hasFields = COUNT_FIELDS.some((key) => typeof form[key] === "string");
  const hasBreakdown = hasFields && (COUNT_FIELDS.some((key) => String(form[key] ?? "").trim() !== "") || !String(form.people_count ?? "").trim());
  const values = (hasBreakdown ? COUNT_FIELDS.map((key) => form[key] ?? "") : [form.people_count ?? ""]);
  if (values.some((value) => typeof value !== "string" || (value.trim() !== "" && !/^\d+$/.test(value.trim())))) return null;
  const counts = values.map(Number);
  if (counts.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 1000)) return null;
  const peopleCount = counts.reduce((sum, value) => sum + value, 0);
  // 「参加する」の選択を、人数の入力漏れで「参加しない」に変えない。
  if (peopleCount > 1000 || (form.attend === "yes" && peopleCount === 0)) return null;
  if (!hasBreakdown && !String(form.people_count ?? "").trim()) return null;
  return hasBreakdown ? { peopleCount, childrenCount: counts[0]!, adultsCount: counts[1]!, seniorsCount: counts[2]! } : { peopleCount };
}

/** 新しく答えるときは何も選ばず、直すときだけ保存済みの出欠を出す。 */
export function AttendanceFields({ title, selected, disabled = false }: { title: string; selected?: string; disabled?: boolean }) {
  return <fieldset><legend>{title}に</legend><div class="choice half">
    <label><input type="radio" name="attend" value="yes" checked={selected === "yes"} required disabled={disabled} /> 参加する</label>
    <label><input type="radio" name="attend" value="no" checked={selected === "no"} required disabled={disabled} /> 参加しない</label>
  </div></fieldset>;
}

export function CountFields({ labels, answer, prefix = "count", disabled = false, rawValues }: { labels: AnswerLabels; answer?: Counts; prefix?: string; disabled?: boolean; rawValues?: Record<string, unknown> }) {
  const values = [answer?.childrenCount, answer?.adultsCount, answer?.seniorsCount];
  const legacy = answer && values.every((value) => value == null);
  return <fieldset class="answer-count-fields"><legend>参加する人数（参加しないときは空けたままで）</legend>
    {COUNT_FIELDS.map((name, index) => <div><label for={`${prefix}-${name}`}>{labels[index]}</label>
      <input id={`${prefix}-${name}`} name={name} type="number" min="0" max="1000" inputmode="numeric" value={typeof rawValues?.[name] === "string" ? String(rawValues[name]) : values[index] ?? ""} disabled={disabled} />人</div>)}
    <p class="muted">いない欄は空けたままでかまいません。</p>
    {legacy ? <><label for={`${prefix}-total`}>合計だけ分かるときの人数</label><input id={`${prefix}-total`} name="people_count" type="number" min="0" max="1000" value={typeof rawValues?.people_count === "string" ? rawValues.people_count : answer.peopleCount} disabled={disabled} /></> : null}
  </fieldset>;
}

/** 回答票の人数が読めなかった答え。参加しないの 0 人と分ける。 */
export function countUnread(answer: Counts): boolean {
  return answer.peopleCount === 0 && answer.childrenCount == null && answer.adultsCount == null && answer.seniorsCount == null;
}

export function countText(answer: Counts, labels: AnswerLabels): string {
  if (countUnread(answer)) return "人数が読めませんでした";
  if (answer.peopleCount === 0) return "参加しない";
  const values = [answer.childrenCount, answer.adultsCount, answer.seniorsCount];
  if (values.every((value) => value == null)) return `${answer.peopleCount}人`;
  return values.flatMap((value, index) => value ? [`${labels[index]!.replace(/（.*）/, "")}${value}人`] : []).join("、");
}

export function labelsFromBody(body: string): AnswerLabels {
  try { return parseAnswerLabels((JSON.parse(body) as { answerLabels?: unknown }).answerLabels) ?? [...DEFAULT_ANSWER_LABELS]; }
  catch { return [...DEFAULT_ANSWER_LABELS]; }
}
