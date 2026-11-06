import { FieldBox, PrintQr } from "../print/a4";
import { paperDeadline, paperGive, publishedItem } from "../print/content";
import { helpTimeChoices } from "./help";

/** Webと同じ募集の内容から出す、世帯の出欠とは別の申込用紙。 */
export function HelpSlip({ title, body, contact, url }: { title: string; body: string; contact: string; url: string }) {
  const choices = helpTimeChoices(body);
  return <div class="answer-slip">
    <div class="slip"><div class="slip-fields">
      <h2>{title}の手伝いを申し込んでください</h2>
      <FieldBox label="お名前" heightMm={18} />
      {choices.length ? <div class="field-box"><span class="field-label">手伝える時間帯の一つに印を付けてください</span>{choices.map((time) => <p>□ {time}</p>)}</div>
        : <FieldBox label="手伝える時間帯" heightMm={22} />}
    </div><div class="qr"><PrintQr text={url} sizeMm={32} />
      <span>スマホで申し込む方は、カメラを向けてください。</span>
    </div></div>
    <div class="give">{paperGive(paperDeadline(publishedItem(body, "due")), "班長か役員").map((text) => <p>{text}</p>)}{contact ? <p>連絡先: {contact}</p> : null}</div>
    <p>紙とスマホのどちらかで申し込んでください。都合が悪くなったときは、班長か役員にお知らせください。</p>
  </div>;
}
