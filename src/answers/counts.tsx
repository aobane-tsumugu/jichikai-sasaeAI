import type { AnswerInput } from "./api";
import { DEFAULT_ANSWER_LABELS, parseAnswerLabels, type AnswerLabels } from "../settings/answer-labels";

export const COUNT_FIELDS = ["children_count", "adults_count", "seniors_count"] as const;
type Counts = Pick<AnswerInput, "peopleCount" | "childrenCount" | "adultsCount" | "seniorsCount">;

/** 古い答えは合計だけを保つ。新しい欄の空欄は0人。 */
export function parseAnswerCounts(form: Record<string, unknown>): Counts | null {
  const hasFields = COUNT_FIELDS.some((key) => typeof form[key] === "string");
  const hasBreakdown = hasFields && (COUNT_FIELDS.some((key) => String(form[key] ?? "").trim() !== "") || !String(form.people_count ?? "").trim());
  const values = (hasBreakdown ? COUNT_FIELDS.map((key) => form[key] ?? "") : [form.people_count ?? ""]);
  if (values.some((value) => typeof value !== "string" || (value.trim() !== "" && !/^\d+$/.test(value.trim())))) return null;
  const counts = values.map(Number);
  if (counts.some((value) => !Number.isSafeInteger(value) || value < 0 || value > 1000)) return null;
  const peopleCount = counts.reduce((sum, value) => sum + value, 0);
  if (peopleCount > 1000) return null;
  if (!hasBreakdown && !String(form.people_count ?? "").trim()) return null;
  return hasBreakdown ? { peopleCount, childrenCount: counts[0]!, adultsCount: counts[1]!, seniorsCount: counts[2]! } : { peopleCount };
}

export function CountFields({ labels, answer, prefix = "count", disabled = false, rawValues }: { labels: AnswerLabels; answer?: Counts; prefix?: string; disabled?: boolean; rawValues?: Record<string, unknown> }) {
  const values = [answer?.childrenCount, answer?.adultsCount, answer?.seniorsCount];
  const legacy = answer && values.every((value) => value == null);
  return <fieldset><legend>参加する人数</legend>
    {COUNT_FIELDS.map((name, index) => <div><label for={`${prefix}-${name}`}>{labels[index]}</label>
      <input id={`${prefix}-${name}`} name={name} type="number" min="0" max="1000" inputmode="numeric" value={typeof rawValues?.[name] === "string" ? String(rawValues[name]) : values[index] ?? ""} disabled={disabled} />人</div>)}
    <p class="muted">いない欄は空けたままでかまいません。</p>
    {legacy ? <><label for={`${prefix}-total`}>合計だけ分かるときの人数</label><input id={`${prefix}-total`} name="people_count" type="number" min="0" max="1000" value={answer.peopleCount} disabled={disabled} /></> : null}
  </fieldset>;
}

export function countText(answer: Counts, labels: AnswerLabels): string {
  const values = [answer.childrenCount, answer.adultsCount, answer.seniorsCount];
  if (values.every((value) => value == null)) return `${answer.peopleCount}人`;
  return `${answer.peopleCount}人（${values.map((value, index) => `${labels[index]}${value ?? 0}人`).join("、")}）`;
}

export function labelsFromBody(body: string): AnswerLabels {
  try { return parseAnswerLabels((JSON.parse(body) as { answerLabels?: unknown }).answerLabels) ?? [...DEFAULT_ANSWER_LABELS]; }
  catch { return [...DEFAULT_ANSWER_LABELS]; }
}
