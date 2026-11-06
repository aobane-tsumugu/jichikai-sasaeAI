// wrangler.toml の [triggers] crons と同じ式。式を足す時は wrangler.toml と一緒に直すので、束 1 に言う。
export const CRON = {
  /** 五分ごと。列の見回り（完了しない札の引き直し）など。 */
  EVERY_5_MIN: "*/5 * * * *",
  /** 毎日 18:00 UTC（日本時間の午前 3 時）。日次の写し、消し損ねの掃除など。 */
  DAILY: "0 18 * * *",
} as const;

/** 既存の五分ごとの処理のうち、日本時間18時の回だけを使う。 */
export function isOfficerDigestTime(now: Date): boolean {
  return now.getUTCHours() === 9 && now.getUTCMinutes() === 0;
}
