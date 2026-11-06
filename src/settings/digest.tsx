import { getSetting, setSetting } from "./store";

export interface DigestSettings { cutoff: string; send: string; eventDays: number; dueDays: number }
export const DEFAULT_DIGEST: DigestSettings = { cutoff: "00:00", send: "08:00", eventDays: 7, dueDays: 3 };
const KEY = "line.digest";
const validTime = (text: unknown): text is string => typeof text === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(text);

export async function getDigestSettings(db: D1Database, wardId: string): Promise<DigestSettings> {
  const value = await getSetting(db, wardId, KEY);
  if (!value) return { ...DEFAULT_DIGEST };
  try {
    const parsed = JSON.parse(value) as DigestSettings;
    return validTime(parsed.cutoff) && validTime(parsed.send) && Number.isInteger(parsed.eventDays) && parsed.eventDays >= 0 && Number.isInteger(parsed.dueDays) && parsed.dueDays >= 0 ? parsed : { ...DEFAULT_DIGEST };
  } catch { return { ...DEFAULT_DIGEST }; }
}

export async function saveDigestSettings(db: D1Database, wardId: string, form: Record<string, unknown>, accountId: string | null): Promise<boolean> {
  if (form.digest_cutoff === undefined && form.digest_send === undefined) return true;
  const cutoff = form.digest_cutoff; const send = form.digest_send;
  const eventDays = Number(form.digest_event_days); const dueDays = Number(form.digest_due_days);
  if (!validTime(cutoff) || !validTime(send) || !Number.isInteger(eventDays) || eventDays < 0 || eventDays > 365 || !Number.isInteger(dueDays) || dueDays < 0 || dueDays > 365) return false;
  await setSetting(db, wardId, KEY, JSON.stringify({ cutoff, send, eventDays, dueDays }), accountId);
  return true;
}

export const timeLabel = (time: string) => { const [hour, minute] = time.split(":").map(Number); return `${hour}時${minute ? `${minute}分` : ""}`; };

/** 送りと締めが同時刻なら、前日に締めた分を送る。 */
export function digestCutoff(value: DigestSettings, now: Date): Date {
  const day = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  const cutoff = new Date(`${day}T${value.cutoff}:00+09:00`);
  if (value.cutoff >= value.send) cutoff.setTime(cutoff.getTime() - 86400_000);
  return cutoff;
}

export function digestPeriodLabel(value: DigestSettings, cutoff: Date): string {
  const local = new Date(cutoff.getTime() + 9 * 3600_000 - (value.cutoff === "00:00" ? 86400_000 : 0));
  const date = `${local.getUTCMonth() + 1}月${local.getUTCDate()}日`;
  return value.cutoff === "00:00" ? `昨日（${date}）` : `${date} ${timeLabel(value.cutoff)}まで`;
}

export const inquiryNotice = (value: DigestSettings, hasGroup = true) => `${hasGroup
  ? `問い合わせは毎日${timeLabel(value.cutoff)}に締め、${value.send > value.cutoff ? "その日" : "翌日"}の${timeLabel(value.send)}に、前回の締めからの分を役員グループへ知らせます。来ない日は送りません。`
  : "役員グループへの知らせは、まだ使えません。問い合わせはこの画面で見られます。"}行事の${value.eventDays}日前や締切の${value.dueDays}日前からは、知らせを待たずに、ときどき見てください。`;

export function DigestFields({ value }: { value: DigestSettings }) {
  return <details class="fold"><summary>問い合わせの知らせの時刻と、近い日の案内</summary><div>
    <p>役員グループへ知らせます。時刻は日本時間です。送る時刻から5分ほど遅れることがあります。</p>
    <label for="digest-cutoff">問い合わせを締める時刻</label><input id="digest-cutoff" name="digest_cutoff" type="time" value={value.cutoff} required />
    <label for="digest-send">知らせを送る時刻</label><input id="digest-send" name="digest_send" type="time" value={value.send} required />
    <label for="digest-event-days">行事の何日前から、ときどき見る案内を出すか</label><input id="digest-event-days" name="digest_event_days" type="number" min="0" max="365" value={value.eventDays} required />
    <label for="digest-due-days">締切の何日前から、ときどき見る案内を出すか</label><input id="digest-due-days" name="digest_due_days" type="number" min="0" max="365" value={value.dueDays} required />
  </div></details>;
}
