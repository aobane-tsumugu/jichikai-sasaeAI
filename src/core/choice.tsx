import type { Child } from "hono/jsx";

/** 選ぶ物の一つ。名前だけで選ばせず、何のための物かと、選ぶと何が起きるかを一文で添える。 */
export interface ChoiceItem {
  value: string;
  title: string;
  note: string;
  checked?: boolean;
  /** 選んだ時に続けて入れる欄（準備の名前など）。 */
  extra?: Child;
}

/** 選ぶ欄の共通の形。名前の下に、何のための物かと、選ぶと何が起きるかを並べる。 */
export function Choices({ name, legend, items, required = true, form }: { name: string; legend: string; items: ChoiceItem[]; required?: boolean; form?: string }) {
  return <fieldset><legend>{legend}</legend><div class="choice">{items.map((item) => <>
    <label><input type="radio" name={name} value={item.value} checked={item.checked} required={required} form={form} /><span>{item.title}<small class="muted">{item.note}</small></span></label>
    {item.extra ?? null}
  </>)}</div></fieldset>;
}
