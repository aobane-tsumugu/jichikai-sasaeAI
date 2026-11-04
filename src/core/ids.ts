/** 意味を持たない ID。区の ID、アカウントの ID など。 */
export function newId(): string {
  return crypto.randomUUID();
}

/** D1 に入れる時刻（ISO 8601 UTC。migrations の既定値と同じ形）。 */
export function nowIso(): string {
  return new Date().toISOString();
}
