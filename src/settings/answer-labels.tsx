import { getSetting, setSetting } from "./store";
import { SETTING_KEYS } from "./keys";

export type AnswerLabels = [string, string, string];
export const DEFAULT_ANSWER_LABELS: AnswerLabels = ["子ども（中学生まで）", "大人（69歳まで）", "高齢の方（70歳以上）"];

export function parseAnswerLabels(raw: unknown): AnswerLabels | null {
  if (!Array.isArray(raw) || raw.length !== 3 || raw.some((value) => typeof value !== "string" || !value.trim() || value.trim().length > 80)) return null;
  return [String(raw[0]).trim(), String(raw[1]).trim(), String(raw[2]).trim()];
}

export async function getAnswerLabels(db: D1Database, wardId: string): Promise<AnswerLabels> {
  const raw = await getSetting(db, wardId, SETTING_KEYS.answerLabels);
  try { return parseAnswerLabels(JSON.parse(raw ?? "null")) ?? [...DEFAULT_ANSWER_LABELS]; }
  catch { return [...DEFAULT_ANSWER_LABELS]; }
}

export function answerLabelsFromForm(form: Record<string, unknown>): AnswerLabels | null {
  return form.answer_labels_reset === "1" ? [...DEFAULT_ANSWER_LABELS] : parseAnswerLabels([form.answer_label_0, form.answer_label_1, form.answer_label_2]);
}

export async function saveAnswerLabels(db: D1Database, wardId: string, form: Record<string, unknown>, accountId: string | null): Promise<boolean> {
  const labels = answerLabelsFromForm(form);
  if (!labels) return false;
  await setSetting(db, wardId, SETTING_KEYS.answerLabels, JSON.stringify(labels), accountId);
  return true;
}

export function AnswerLabelFields({ labels, open = false }: { labels: AnswerLabels; open?: boolean }) {
  return <details class="hint" open={open}><summary>人数の聞き方を変える</summary>
    <p>区分を変えたいときだけ直してください。</p>
    {labels.map((label, index) => <div><label for={`answer-label-${index}`}>{["一つ目", "二つ目", "三つ目"][index]}</label><input id={`answer-label-${index}`} name={`answer_label_${index}`} value={label} maxlength={80} required /></div>)}
    <p>次に配る案内から、答える画面と紙の回答票はこの言い方になります。もう届いた答えの人数は変わりません。</p>
    <button type="submit" name="answer_labels_reset" value="1" class="secondary" formnovalidate>最初の言い方に戻す</button>
  </details>;
}
