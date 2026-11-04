/**
 * 公開前の確認口。束 3 の検査が入ったらこの関数の中身だけを差し替える。
 * 現在は検査の束が未実装のため、ここでは本文の形だけ確認する。
 */
export async function checkPublicDraft(body: unknown): Promise<string[]> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return ["案内の形を読み取れません"];
  return [];
}
