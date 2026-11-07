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

export function digestSettingsFromForm(form: Record<string, unknown>): DigestSettings | null {
  const cutoff = form.digest_cutoff; const send = form.digest_send;
  const eventDays = Number(form.digest_event_days); const dueDays = Number(form.digest_due_days);
  if (!validTime(cutoff) || !validTime(send) || !Number.isInteger(eventDays) || eventDays < 0 || eventDays > 365 || !Number.isInteger(dueDays) || dueDays < 0 || dueDays > 365) return null;
  return { cutoff, send, eventDays, dueDays };
}

export async function saveDigestSettings(db: D1Database, wardId: string, form: Record<string, unknown>, accountId: string | null): Promise<boolean> {
  if (form.digest_cutoff === undefined && form.digest_send === undefined) return true;
  const value = digestSettingsFromForm(form);
  if (!value) return false;
  await setSetting(db, wardId, KEY, JSON.stringify(value), accountId);
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
  ? `問い合わせは毎日${timeLabel(value.cutoff)}に締め、${value.send > value.cutoff ? "その日" : "翌日"}の${timeLabel(value.send)}に、前回の締めからの分を役員のLINEグループへ通知します。来ない日は送りません。`
  : "役員のLINEグループへの通知は、まだ使えません。問い合わせはこの画面で見られます。"}当日の${value.eventDays}日前や締切の${value.dueDays}日前からは、通知を待たずに、ときどき見てください。`;

export function DigestFields({ value, rawValues, open = false }: { value: DigestSettings; rawValues?: Record<string, unknown>; open?: boolean }) {
  const field = (name: string, saved: string | number) => typeof rawValues?.[name] === "string" ? String(rawValues[name]) : saved;
  return <details class="fold" open={open}><summary>通知の時刻を変える</summary><div>
    <p>時刻は日本時間です。送る時刻から5分ほど遅れることがあります。</p>
    <label for="digest-cutoff">この時刻までに届いた問い合わせを、次の通知にまとめる</label><input id="digest-cutoff" name="digest_cutoff" type="time" value={field("digest_cutoff", value.cutoff)} required />
    <label for="digest-send">通知を送る時刻</label><input id="digest-send" name="digest_send" type="time" value={field("digest_send", value.send)} required />
    <label for="digest-event-days">当日の何日前から、ときどき見る案内を出すか</label><input id="digest-event-days" name="digest_event_days" type="number" min="0" max="365" value={field("digest_event_days", value.eventDays)} required />
    <label for="digest-due-days">締切の何日前から、ときどき見る案内を出すか</label><input id="digest-due-days" name="digest_due_days" type="number" min="0" max="365" value={field("digest_due_days", value.dueDays)} required />
  </div></details>;
}
