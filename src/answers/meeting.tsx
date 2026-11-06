import type { AnswerSheetRow } from "../ai/schema";
import { getTemplates } from "../settings/store";
import type { MeetingTotals } from "./meeting-store";

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

export function meetingTotalsText(totals: MeetingTotals): string {
  return `答えた世帯${totals.answered}世帯 / 出席${totals.attend}世帯 / 委任${totals.proxy}世帯 / 欠席${totals.absent}世帯`;
}

export function MeetingCounts({ totals, className = "counts" }: { totals: MeetingTotals; className?: string }) {
  return <div class={className}><div class="count"><b>{totals.answered}<small>世帯</small></b><span>答えた世帯</span></div>
    {Object.entries(MEETING_LABELS).map(([status, label]) => <div class="count"><b>{totals[status as MeetingStatus]}<small>世帯</small></b><span>{label}</span></div>)}
  </div>;
}

/** はっきり書かれた答えだけを読む。名前には文字幅の変換をかけない。 */
export function meetingAnswerFromLine(text: string) {
  const end = "(?=[、。！!\\s]|$)";
  const statusText = text.replace(/(出席|欠席|委任)[\t 　]+(?=し|いた|する|です|でき)/g, "$1");
  const attend = new RegExp(`出席(?:します|いたします|する|です)?${end}`).test(statusText);
  const absent = new RegExp(`(?:欠席(?:します|いたします|する|です)?|出席(?:しません|できません|できない|しない))${end}`).test(statusText);
  const proxy = new RegExp(`委任(?:します|いたします|する|です)?${end}`).test(statusText);
  // 欠席して委任する答えは委任。出席との食い違いや、問い・未定の文は数えない。
  if ((attend && (absent || proxy)) || /[?？]|(?:出席|欠席|委任).*(?:未定|検討中|確認中|かもしれ|予定|ますか|ですか)|(?:出席|委任|欠席)\s*[・/／]\s*(?:出席|委任|欠席)/.test(text)) return null;
  const meetingStatus = proxy ? "proxy" : absent ? "absent" : attend ? "attend" : null;
  if (!meetingStatus) return null;
  const proxyName = proxy ? (
    /(?:委任先|委任する相手|代理人)(?:のお名前|の名前|お名前|名前)?\s*[:：]\s*([^。\r\n]+)/.exec(text)?.[1] ??
    /(?:^|[。、\r\n])\s*([^。、\r\n]+?)に委任(?:します|いたします|する)/.exec(text)?.[1] ?? ""
  ).trim() : "";
  return parseMeetingAnswer({ meeting_status: meetingStatus, proxy_name: proxyName });
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
