import { FieldBox } from "../print/a4";
import { TEXT_ANSWER_LIMIT, type AnswerField, type FieldSuggestion, type FieldValues, fieldValueText } from "./fields";

/** Web の返事と、電話の返事を入れる画面と、返事を直す画面に、足した欄を出す。 */
export function FieldInputs({ fields, values = {}, prefix = "field", currentFields }: { fields: readonly AnswerField[]; values?: FieldValues; prefix?: string;
  /** 返事を直す画面で、今の候補。ここに無い日は「今の候補にはありません」と添えて出す。 */
  currentFields?: readonly AnswerField[] }) {
  const isCurrent = (field: AnswerField, option: string) => !currentFields || (currentFields.find((entry) => entry.fieldId === field.fieldId)?.options.includes(option) ?? true);
  return <>{fields.map((field) => {
    const value = values[field.fieldId];
    const chosen = Array.isArray(value) ? value : value ? [value] : [];
    if (field.kind === "days") return <fieldset><legend>{field.label}{field.multiple ? "（いくつでも選べます）" : "（一つ選んでください）"}</legend>
      {field.options.length ? <div class="choice">{field.options.map((option) => <label><input type={field.multiple ? "checkbox" : "radio"} name={`field_${field.fieldId}`} value={option} checked={chosen.includes(option)} /> {option}{isCurrent(field, option) ? "" : "（今の候補にはありません）"}</label>)}</div>
        : <p class="muted">選ぶ日がまだ決まっていません。</p>}
      <p class="muted">分からないときは、選ばずに送ってかまいません。</p></fieldset>;
    return <div class="field"><label for={`${prefix}-${field.fieldId}`}>{field.label}（書かなくてかまいません）</label>
      <input id={`${prefix}-${field.fieldId}`} name={`field_${field.fieldId}`} type="text" maxlength={TEXT_ANSWER_LIMIT} value={fieldValueText(value)} /></div>;
  })}</>;
}

/** 紙の回答票に、足した欄を出す。Web の返事と同じ定義から作る。 */
export function PaperAnswerFields({ fields }: { fields: readonly AnswerField[] }) {
  return <>{fields.map((field) => field.kind === "days"
    ? <div class="field-box"><strong>{field.label}{field.multiple ? "（いくつでも）" : "（一つに印）"}</strong><p>{field.options.length ? field.options.map((option) => `□ ${option}`).join("　") : "（日を書いてください）"}</p></div>
    : <FieldBox label={`${field.label}（書かなくてかまいません）`} heightMm={18} />)}</>;
}

/** 紙が一枚に収まるかの見積もりに足す文字。 */
export function paperFieldsText(fields: readonly AnswerField[]): string {
  return fields.map((field) => `${field.label}${field.options.join("　□")}`).join("");
}

/** 下書きや答えの画面に書く、返事で聞くことの一文。 */
export function askedText(fields: readonly AnswerField[], districtAsked: boolean): string {
  return ["代表者のお名前", "参加するかどうか", "人数", ...(districtAsked ? ["班"] : []), ...fields.map((field) => field.label)].join("、");
}

/** 届いた資料から思い当たった欄の候補。押すまで足さない。 */
export function SuggestionNotice({ suggestions, action, offAction }: { suggestions: readonly FieldSuggestion[]; action: string; offAction: string }) {
  if (!suggestions.length) return null;
  return <div class="notice"><strong>返事で聞く欄の候補があります</strong>
    {suggestions.map((suggestion) => <form method="post" action={action}>
      <p>{suggestion.text}{suggestion.kinds.map((kind) => kind === "days" ? "日を選ぶ欄" : "班を聞く欄").join("と")}を、今年の返事にも足しますか。押すまで足しません。</p>
      {suggestion.kinds.map((kind) => <input type="hidden" name="kind" value={kind} />)}
      <button class="secondary" type="submit">{suggestion.kinds.map((kind) => kind === "days" ? "日を選ぶ欄" : "班を聞く欄").join("と")}を足す</button>
    </form>)}
    {/* 足さないと決めた役員に、同じ候補を出し続けない。押すとこの準備では候補を出さない。欄の画面から元に戻せる。 */}
    <form method="post" action={offAction}><button class="quiet" type="submit">足さない（この準備では候補を出さない）</button></form>
  </div>;
}
