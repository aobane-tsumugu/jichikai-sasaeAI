// 届いたものを送った人の書き方。画面ごとに書き方が割れないように、一か所で決める。

/** LINE の送り方の札（line_inbox_items.sender_label）を、画面の言葉にする。 */
const WAYS: Record<string, string> = {
  "LINE個別": "自治会のLINEに個別に送った人",
  "LINEグループ": "LINEグループ",
  "LINE複数人トーク": "LINEの複数人のトーク",
};

/**
 * 「〇〇さん」と書く。名前が分からないときは、送り方の札や LINE の番号に「さん」を付けず、
 * 「名前の分からない人（自治会のLINEに個別に送った人）」のように書く。
 */
export function senderText(name: string | null | undefined, way?: string | null): string {
  const value = (name ?? "").trim();
  if (value && !WAYS[value] && !/^[UCR][0-9a-f]{32}$/.test(value)) return `${value}さん`;
  const kind = WAYS[way ?? ""] ?? WAYS[value];
  return kind ? `名前の分からない人（${kind}）` : "名前の分からない人";
}
