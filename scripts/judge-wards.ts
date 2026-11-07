// 審査員が触る自治会。通しの確かめや架空の LINE の送信を、ここでは走らせない。
export const JUDGE_WARDS = ["demoku", "sasaedai"] as const;

export function isJudgeWard(slug: string | undefined | null): boolean {
  const value = (slug ?? "").trim().toLowerCase();
  return (JUDGE_WARDS as readonly string[]).includes(value);
}
