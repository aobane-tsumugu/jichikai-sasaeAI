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

export const inquiryNotice = (value: DigestSettings) => `問い合わせは毎日${value.cutoff}に締め、${value.send}に前の日の分を役員グループへ知らせます。来ない日は送りません。行事や締切が近いときは、知らせを待たずに、ときどき見てください。`;

export function DigestFields({ value }: { value: DigestSettings }) {
  return <details class="fold"><summary>問い合わせの知らせの時刻と、近い日の案内</summary><div>
    <p>役員グループへ知らせます。時刻は日本時間です。送る時刻から5分ほど遅れることがあります。</p>
    <label for="digest-cutoff">問い合わせを締める時刻</label><input id="digest-cutoff" name="digest_cutoff" type="time" value={value.cutoff} required />
    <label for="digest-send">知らせを送る時刻</label><input id="digest-send" name="digest_send" type="time" value={value.send} required />
    <label for="digest-event-days">行事の何日前から、ときどき見る案内を出すか</label><input id="digest-event-days" name="digest_event_days" type="number" min="0" max="365" value={value.eventDays} required />
    <label for="digest-due-days">締切の何日前から、ときどき見る案内を出すか</label><input id="digest-due-days" name="digest_due_days" type="number" min="0" max="365" value={value.dueDays} required />
  </div></details>;
}
