import type { AnswerSheetRow } from "../ai/schema";
import { getTemplates } from "../settings/store";

export const MEETING_LABELS = { attend: "出席", proxy: "委任", absent: "欠席" } as const;
export type MeetingStatus = keyof typeof MEETING_LABELS;
export const MEETING_NOTE_NAME = "総会の回答票の追記";

export function isMeetingStatus(value: unknown): value is MeetingStatus {
  return value === "attend" || value === "proxy" || value === "absent";
}

export function parseMeetingAnswer(form: Record<string, unknown>) {
  const proxyName = form.proxy_name ?? "";
  if (!isMeetingStatus(form.meeting_status) || typeof proxyName !== "string" || proxyName.trim().length > 120) return null;
  return { meetingStatus: form.meeting_status, proxyName: form.meeting_status === "proxy" ? proxyName.trim() : "" };
}

/** 空欄と判読不能を分ける。読めない答えを欠席や議長への委任に変えない。 */
export function meetingAnswerFromSheet(row: AnswerSheetRow) {
  if (!isMeetingStatus(row.meeting_status) || row.confidence === "low" ||
    (row.meeting_status === "proxy" && typeof row.proxy_name !== "string")) return null;
  return parseMeetingAnswer({ meeting_status: row.meeting_status, proxy_name: row.proxy_name ?? "" });
}

export function meetingText(answer: { meetingStatus?: MeetingStatus | null; proxyName?: string | null }) {
  if (!isMeetingStatus(answer.meetingStatus)) return "出席・委任・欠席を確かめてください";
  return MEETING_LABELS[answer.meetingStatus] + (answer.meetingStatus === "proxy" ? `（委任する相手：${answer.proxyName || "空欄"}）` : "");
}

/** 既存の区の「決まった知らせの文」から、紙とWebの共通の追記を読む。 */
export async function meetingNote(db: D1Database, wardId: string): Promise<string> {
  return (await getTemplates(db, wardId)).find((entry) => entry.name === MEETING_NOTE_NAME)?.body ?? "";
}

export function MeetingFields({ selected, proxyName = "", prefix = "meeting", disabled = false }: {
  selected?: string | null; proxyName?: string | null; prefix?: string; disabled?: boolean;
}) {
  return <>
    <fieldset><legend>総会の出席について</legend><div class="choice">
      {Object.entries(MEETING_LABELS).map(([value, label]) => <label><input type="radio" name="meeting_status" value={value} checked={selected === value} required disabled={disabled} /> {label}する</label>)}
    </div></fieldset>
    <label for={`${prefix}-proxy`}>委任する相手のお名前（委任するとき。書かなくてかまいません）</label>
    <input id={`${prefix}-proxy`} name="proxy_name" type="text" maxlength={120} value={proxyName ?? ""} disabled={disabled} />
    <p class="muted">委任する相手を書かなかったときは、空欄のまま受け付けます。</p>
  </>;
}
