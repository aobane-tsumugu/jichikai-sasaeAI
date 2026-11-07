// 届いたものを送った人の書き方と、自治会の中での番号を一か所で決める。

/** LINE の送り方の札（line_inbox_items.sender_label）を、画面の言葉にする。 */
const WAYS: Record<string, string> = {
  "LINE個別": "自治会のLINEに個別に送った人",
  "LINEグループ": "LINEグループ",
  "LINE複数人トーク": "LINEの複数人のトーク",
};

/** 以前、名前の代わりに保存した送り方や不明の表示も名前として扱わない。 */
export function hasSenderName(name: string | null | undefined): boolean {
  const value = (name ?? "").trim();
  return Boolean(value && !WAYS[value] && !/^[UCR][0-9a-f]{32}$/.test(value)
    && !/^名前の分からない人(?:（.*）)?$/.test(value));
}

/** 名前には「さん」を付け、番号の人には付けない。 */
export function senderText(name: string | null | undefined, way?: string | null, number?: number): string {
  if (hasSenderName(name)) return `${name!.trim()}さん`;
  if (number !== undefined) {
    const group = way === "group" || way === "room" || way === "LINEグループ" || way === "LINE複数人トーク";
    return group ? `グループで送ってきた方 ${number}` : `個別に送ってきた方 ${number}`;
  }
  const kind = WAYS[way ?? ""] ?? WAYS[(name ?? "").trim()];
  return kind ? `名前の分からない人（${kind}）` : "名前の分からない人";
}

/**
 * 既存の受信記録だけから計算する。名前のない利用者を自治会内の初回受信順に並べる。
 * 同時刻はID順。一人に一つの番号とし、名前だけの人やグループ自体のIDは数えない。
 */
export async function senderNumbers(db: D1Database, wardId: string): Promise<Map<string, number>> {
  const rows = await db.prepare(`
    SELECT CASE WHEN source_type IN ('group', 'room') AND sender_id = source_id THEN NULL ELSE sender_id END AS sender_id,
      sender_display_name AS name, received_at
    FROM line_inbox_items WHERE ward_id = ? AND COALESCE(source_type, '') <> 'admin'
    UNION ALL
    SELECT COALESCE(NULLIF(line_user_id, ''), CASE WHEN line_source_type = 'user' THEN line_source_id END) AS sender_id,
      line_sender_label AS name, received_at
    FROM inquiry_records WHERE ward_id = ? AND line_source_type IN ('user', 'group', 'room')
    UNION ALL
    SELECT CASE WHEN source_type IN ('group', 'room') AND sender_id = source_id THEN NULL ELSE sender_id END AS sender_id,
      sender_name AS name, received_at
    FROM line_talk_inquiry_posts WHERE ward_id = ? AND source_type IN ('user', 'group', 'room')
  `).bind(wardId, wardId, wardId).all<{ sender_id: string | null; name: string | null; received_at: string }>();
  const people = new Map<string, { firstAt: number; unnamed: boolean }>();
  for (const row of rows.results) {
    if (!row.sender_id) continue;
    const previous = people.get(row.sender_id);
    people.set(row.sender_id, {
      firstAt: Math.min(previous?.firstAt ?? Infinity, Date.parse(row.received_at)),
      unnamed: Boolean(previous?.unnamed || !hasSenderName(row.name)),
    });
  }
  return new Map([...people].filter(([, person]) => person.unnamed)
    .sort(([a, x], [b, y]) => x.firstAt - y.firstAt || (a < b ? -1 : a > b ? 1 : 0))
    .map(([id], index) => [id, index + 1]));
}
