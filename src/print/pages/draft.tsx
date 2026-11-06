import { CutLine, FieldBox, PrintDocument, Sheet } from "../a4";
import { collectsAttendance, paperHeading } from "../../project/heading";
import { paperDeadline, paperGive, paperHelperSlots, publishedItem } from "../content";
import { fitsAboveAnswer, PaperBody, RowsTable } from "./index";
import { MeetingSlipFields } from "./meeting";
import type { PublishedTableRow } from "../../space/publication-tables";

/** 下書きは紙でも区別し、受け付け用のQRや配った日を作らない。 */
export function DraftPaper({ title, projectTitle, projectKind, body, kind, back, wardName, squads, labels, tables, answerOnly = false, generalMeeting = false, meetingNote = "" }: {
  title: string; projectTitle: string; projectKind: string; body: string; kind: string; back: string; wardName: string;
  squads: string[]; labels: readonly string[]; answerOnly?: boolean; generalMeeting?: boolean; meetingNote?: string;
  tables?: PublishedTableRow[] | null;
}) {
  const withAnswer = collectsAttendance(projectKind, kind);
  const due = paperDeadline(publishedItem(body, "due"));
  const slots = paperHelperSlots(publishedItem(body, "helper_slots") || "");
  const answer = (squad: string) => <div class="answer-slip">
    <h2>{projectTitle} 回答票{generalMeeting ? "・委任状" : ""}{squad ? `　${squad}` : ""}</h2>
    {generalMeeting ? <MeetingSlipFields note={meetingNote} squad={squad} /> : <><p>参加しないときも、答えてください。答えがないときは、欠席として数えます。</p>
    <FieldBox label="代表者のお名前" heightMm={19} />
    {!squad ? <FieldBox label="班（分からないときは空けてかまいません）" heightMm={10} /> : null}
    <div class="field-box"><p>□ 参加する　　□ 参加しない</p><strong>参加する人数</strong><div class="paper-counts">{labels.map((label) => <div class="paper-count"><div>{label}</div><span>人</span></div>)}</div><p>いない欄は、空けたままでかまいません。</p></div>
    <FieldBox label="手伝える方のお名前と時間帯（書かなくてかまいません）" heightMm={22} />
    {slots ? <p>{slots}</p> : null}
    </>}
    <p>配るときにQRコードが入ります。</p>
    {paperGive(due, `${squad ? `${squad}の` : ""}班長か役員`).map((line) => <p>{line}</p>)}
  </div>;
  const onOneSheet = withAnswer && fitsAboveAnswer(body, generalMeeting
    ? meetingNote + due + "□出席□委任□欠席。委任する相手のお名前。代表者のお名前。委任を選んだときは、この回答票を委任状として受け付けます。委任する相手を書かなかったときは、空欄のまま受け付けます。"
    : labels.join("") + slots + due + "下書きです。まだ配っていません。参加しないときも、答えてください。答えがないときは、欠席として数えます。いない欄は、空けたままでかまいません");
  const footer = (squad = "") => <><span>{wardName}{squad ? ` ${squad}` : ""}</span><strong>下書きです</strong></>;
  return <PrintDocument title={`下書き: ${paperHeading(projectTitle, title)}`} back={back}>
    {!answerOnly && withAnswer && !onOneSheet ? <Sheet footer={footer()}><p><strong>下書きです。まだ配っていません。</strong></p><h1>{paperHeading(projectTitle, title)}</h1><PaperBody body={body} project={projectTitle} title={title} kind={kind} /></Sheet> : null}
    {(withAnswer ? squads.length ? squads : [""] : [""]).map((squad) => <Sheet footer={footer(squad)}>
      <p><strong>下書きです。まだ配っていません。</strong></p>
      {!answerOnly && (!withAnswer || onOneSheet) ? <><h1>{paperHeading(projectTitle, title)}</h1><PaperBody body={body} project={projectTitle} title={title} kind={kind} /></> : null}
      {!answerOnly && tables !== undefined ? tables === null ? <p>配ったときの表の記録がありません。</p> : <>
        <RowsTable table="duties" rows={tables.filter((entry) => entry.kind === "duties")} />
        <RowsTable table="layout" rows={tables.filter((entry) => entry.kind === "layout")} />
        <RowsTable table="committee" rows={tables.filter((entry) => entry.kind === "committee")} />
      </> : null}
      {withAnswer ? <>{generalMeeting || (!answerOnly && onOneSheet) ? <CutLine /> : null}{answer(squad)}</> : null}
    </Sheet>)}
  </PrintDocument>;
}
