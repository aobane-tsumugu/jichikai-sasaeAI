// wrangler.toml の [triggers] crons と同じ式。式を足す時は wrangler.toml と一緒に直すので、束 1 に言う。
export const CRON = {
  /** 五分ごと。列の見回り（完了しない札の引き直し）など。 */
  EVERY_5_MIN: "*/5 * * * *",
  /** 毎日 18:00 UTC（日本時間の午前 3 時）。日次の写し、消し損ねの掃除など。 */
  DAILY: "0 18 * * *",
} as const;

/** 今日の送る時刻を過ぎた区を、五分ごとの見回りで拾う。 */
export function isOfficerDigestTime(now: Date, send = "08:00"): boolean {
  const local = new Date(now.getTime() + 9 * 3600_000);
  const [hour, minute] = send.split(":").map(Number);
  return local.getUTCHours() * 60 + local.getUTCMinutes() >= hour! * 60 + minute!;
}
