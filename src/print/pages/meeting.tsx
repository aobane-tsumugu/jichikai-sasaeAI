import { FieldBox } from "../a4";
import { MEETING_LABELS } from "../../answers/meeting";

/** 紙とWebで聞く内容をそろえる。署名・押印は区が用意した文で足せる。 */
export function MeetingSlipFields({ note = "", squad = "" }: { note?: string; squad?: string }) {
  return <>
    <p>出席・委任・欠席のどれか一つに印を付けてください。</p>
    <div class="field-box"><p>{Object.values(MEETING_LABELS).map((label) => `□${label}`).join("　　")}</p></div>
    <FieldBox label="委任する相手のお名前（書かなくてかまいません）" heightMm={12} />
    <p>委任を選んだときは、この回答票を委任状として受け付けます。委任する相手を書かなかったときは、空欄のまま受け付けます。</p>
    <FieldBox label="代表者のお名前" heightMm={19} />
    {squad ? <p>班：{squad}</p> : <FieldBox label="班（分からないときは空けてかまいません）" heightMm={10} />}
    {note ? <div class="field-box" style="white-space:pre-wrap;min-height:15mm">{note}</div> : null}
  </>;
}
