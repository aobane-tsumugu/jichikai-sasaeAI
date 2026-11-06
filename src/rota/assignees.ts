/** 姓名の間の空白は保ち、担当の区切りだけで分ける。 */
export function splitAssignees(value: string): string[] {
  return value.split(/[、,，/／\n]+/).map((name) => name.trim()).filter(Boolean);
}

/** 班、団体、人数や未定の記述を、一人の名前として扱わない。 */
export function isPersonalAssignee(value: string): boolean {
  const name = value.normalize("NFKC").replace(/\([^()]*\)$/u, "").replace(/\s+/g, "");
  return !!name && /^[\p{L}\p{M}々・ー]+$/u.test(name) &&
    !/(?:班|組|係|委員|役員|担当|全員|全世帯|一同|有志|各|未定|未割当|調整中|分からない|不明|なし|無し|ほか|など)/u.test(name) &&
    !/^.{2,}(?:部|課|会|センター|チーム)$/u.test(name);
}
