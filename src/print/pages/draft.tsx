import { CutLine, FieldBox, PrintDocument, Sheet } from "../a4";
import { paperHeading } from "../../project/heading";
import { paperDeadline, paperGive, paperHelperSlots, publishedItem } from "../content";
import { fitsAboveAnswer, PaperBody } from "./index";

/** 下書きは紙でも区別し、受け付け用のQRや配った日を作らない。 */
export function DraftPaper({ title, projectTitle, body, kind, back, wardName, squads, labels, answerOnly = false }: {
  title: string; projectTitle: string; body: string; kind: string; back: string; wardName: string;
  squads: string[]; labels: readonly string[]; answerOnly?: boolean;
}) {
  const due = paperDeadline(publishedItem(body, "due"));
  const slots = paperHelperSlots(publishedItem(body, "helper_slots") || "");
  const answer = (squad: string) => <div class="answer-slip">
    <h2>{projectTitle} 回答票{squad ? `　${squad}` : ""}</h2>
    <p>参加しないときも、答えてください。答えがないときは、欠席として数えます。</p>
    <FieldBox label="代表者のお名前" heightMm={19} />
    {!squad ? <FieldBox label="班（分からないときは空けてかまいません）" heightMm={10} /> : null}
    <div class="field-box"><p>□ 参加する　　□ 参加しない</p><strong>参加する人数</strong><div class="paper-counts">{labels.map((label) => <div class="paper-count"><div>{label}</div><span>人</span></div>)}</div></div>
    <FieldBox label="手伝える方のお名前と時間帯（書かなくてかまいません）" heightMm={22} />
    {slots ? <p>{slots}</p> : null}
    <p>配るときにQRコードが入ります。</p>
    {paperGive(due, `${squad ? `${squad}の` : ""}班長か役員`).map((line) => <p>{line}</p>)}
  </div>;
  const onOneSheet = fitsAboveAnswer(body, labels.join("") + slots + due + "下書きです。まだ配っていません。参加しないときも、答えてください。答えがないときは、欠席として数えます。");
  const footer = (squad = "") => <><span>{wardName}{squad ? ` ${squad}` : ""}</span><strong>下書きです</strong></>;
  return <PrintDocument title={`下書き: ${paperHeading(projectTitle, title)}`} back={back}>
    {!answerOnly && kind === "announcement" && !onOneSheet ? <Sheet footer={footer()}><p><strong>下書きです。まだ配っていません。</strong></p><h1>{paperHeading(projectTitle, title)}</h1><PaperBody body={body} /></Sheet> : null}
    {(kind === "announcement" ? squads.length ? squads : [""] : [""]).map((squad) => <Sheet footer={footer(squad)}>
      <p><strong>下書きです。まだ配っていません。</strong></p>
      {!answerOnly && (kind !== "announcement" || onOneSheet) ? <><h1>{paperHeading(projectTitle, title)}</h1><PaperBody body={body} /></> : null}
      {kind === "announcement" ? <>{!answerOnly && onOneSheet ? <CutLine /> : null}{answer(squad)}</> : null}
    </Sheet>)}
  </PrintDocument>;
}
