// 役員が知っておくこと。十五の仕事を基本にし、区ごとに足す、外す、名前を変えることができる。
import { newId, nowIso } from "../core/ids";
import { formatJstDate } from "../core/time";

export interface KnowBase {
  key: string;
  title: string;
  /** 何を書く項目かの例。 */
  hint: string;
  /** この月数を過ぎたら見直しの合図を出す。 */
  months: number;
  /** 総会で変わりやすい項目。総会を閉じたあと直されていなければ合図を出す。 */
  afterMeeting?: boolean;
  /** サービスで預からない物。 */
  keepOut?: string;
}

export const KNOW_BASE: readonly KnowBase[] = [
  { key: "officers", title: "役員と仕事の割り振り", hint: "役員の一覧、任期、決め方、ほかの団体の委員", months: 12, afterMeeting: true },
  { key: "board", title: "役員会と班長会", hint: "開く時期、回数、場所", months: 12 },
  { key: "meeting", title: "総会", hint: "開く時期、成立の決まり、委任の決まり、規約", months: 12, afterMeeting: true },
  { key: "roster", title: "世帯の名簿", hint: "世帯の代表者、班と班長、加入と転入の手続き", months: 12 },
  { key: "notices", title: "案内と回覧", hint: "案内の作り方、回覧の決まり", months: 24 },
  { key: "delivery", title: "配り方", hint: "回覧板か全戸配布か、部数、印刷する場所", months: 24 },
  { key: "inquiries", title: "問い合わせと要望", hint: "住民の連絡先、行政への要望の出し方", months: 12 },
  { key: "answers", title: "出欠と手伝いの集め方", hint: "返事の集め方、締切の決め方", months: 24 },
  { key: "dues", title: "会費と募金", hint: "会費の額、集め方、募金の取りまとめ", months: 12, afterMeeting: true },
  { key: "accounts", title: "会計と補助金", hint: "予算と決算、監査、補助金の申請", months: 12, afterMeeting: true, keepOut: "通帳、印鑑、暗証番号" },
  { key: "city", title: "行政や他の団体の依頼", hint: "市の担当の窓口、毎年来る依頼", months: 12 },
  { key: "handover", title: "記録と引き継ぎ", hint: "預かっている書類の場所、備品、メールやSNSの入り口", months: 12, keepOut: "鍵とパスワード" },
  { key: "events", title: "行事", hint: "毎年の行事、頼んでいる業者や協賛先、保険", months: 12 },
  { key: "duties", title: "当番と共同作業", hint: "ごみ集積所の当番、清掃や草刈りの決まり", months: 24 },
  { key: "safety", title: "防災と施設", hint: "防災の組織と訓練、集会所、防犯灯", months: 24 },
];

export const KNOW_LIMITS = { title: 60, body: 4000 } as const;

export type KnowState = "empty" | "fact" | "old" | "checking";

export interface KnowItem {
  id: string;
  title: string;
  body: string;
  /** 区が書いた文のほかに、名簿のように仕組みから分かる値。 */
  auto: string;
  hint: string;
  keepOut: string;
  added: boolean;
  state: KnowState;
  /** 状態の理由を一文で。 */
  note: string;
  /** 役員が書いた文と違う内容の紙が届いた時の、紙の内容。 */
  proposed: string;
  proposedOriginalId: string | null;
}

interface Row { item_id: string; title: string; body: string; reviewed_at: string | null; added: number; removed_at: string | null; updated_at: string; proposed_text: string; proposed_original_id: string | null }

const monthsBetween = (from: string, to: Date) => {
  const start = new Date(from);
  return (to.getUTCFullYear() - start.getUTCFullYear()) * 12 + to.getUTCMonth() - start.getUTCMonth();
};
const ago = (months: number) => months >= 12 ? `${Math.floor(months / 12)}年${months % 12 ? `${months % 12}か月` : ""}前` : `${months}か月前`;

function stateOf(base: KnowBase | undefined, value: string, seen: string | null, meetingClosedAt: string | null, now: Date): { state: KnowState; note: string } {
  if (!value) return { state: "empty", note: `まだ書かれていません。${base?.hint ?? ""}` };
  if (!seen) return { state: "fact", note: "届いた資料から読み取りました" };
  if (base?.afterMeeting && meetingClosedAt && seen < meetingClosedAt) return { state: "old", note: "総会のあと直されていません" };
  const months = monthsBetween(seen, now);
  if (base && months >= base.months) return { state: "old", note: `${ago(months)}に見直しました` };
  return { state: "fact", note: `${formatJstDate(seen)}に見直しました` };
}

/** 基本の項目に区の上書きを重ねて返す。外した項目は別に返す。 */
export async function listKnowItems(db: D1Database, wardId: string, now = new Date()) {
  const [rows, meeting, roster] = await Promise.all([
    db.prepare("SELECT item_id, title, body, reviewed_at, added, removed_at, updated_at, proposed_text, proposed_original_id FROM ward_know_items WHERE ward_id = ? ORDER BY created_at, item_id").bind(wardId).all<Row>(),
    db.prepare("SELECT MAX(closed_at) AS closed_at FROM projects WHERE ward_id = ? AND kind = 'general_meeting' AND closed_at IS NOT NULL").bind(wardId).first<{ closed_at: string | null }>(),
    db.prepare(`SELECT COUNT(*) AS n, MAX(s.updated_at) AS updated_at FROM ward_roster_entries e
      JOIN ward_roster_settings s ON s.ward_id = e.ward_id AND s.active_set_id = e.roster_set_id WHERE e.ward_id = ?`).bind(wardId).first<{ n: number; updated_at: string | null }>(),
  ]);
  const byId = new Map(rows.results.map((row) => [row.item_id, row]));
  const build = (id: string, base: KnowBase | undefined, row: Row | undefined): KnowItem => {
    const auto = id === "roster" && roster?.n ? `世帯の名簿 ${roster.n}世帯` : "";
    const body = row?.body ?? "";
    const seen = [row?.reviewed_at, auto ? roster?.updated_at : null].filter((value): value is string => Boolean(value)).sort().at(-1) ?? null;
    const state = row?.proposed_text ? { state: "checking" as const, note: "新しい紙に違う内容があります" } : stateOf(base, body.trim() || auto, seen, meeting?.closed_at ?? null, now);
    return { id, title: row?.title || base?.title || "", body, auto, hint: base?.hint ?? "", keepOut: base?.keepOut ?? "", added: !base, proposed: row?.proposed_text ?? "", proposedOriginalId: row?.proposed_original_id ?? null, ...state };
  };
  const all = [...KNOW_BASE.map((base) => ({ item: build(base.key, base, byId.get(base.key)), removed: Boolean(byId.get(base.key)?.removed_at) })),
    ...rows.results.filter((row) => row.added).map((row) => ({ item: build(row.item_id, undefined, row), removed: Boolean(row.removed_at) }))];
  return { items: all.filter((entry) => !entry.removed).map((entry) => entry.item), removed: all.filter((entry) => entry.removed).map((entry) => entry.item) };
}

export async function getKnowItem(db: D1Database, wardId: string, id: string) {
  const { items, removed } = await listKnowItems(db, wardId);
  return items.find((item) => item.id === id) ?? removed.find((item) => item.id === id) ?? null;
}

const upsert = (db: D1Database, wardId: string, id: string) => db.prepare("INSERT OR IGNORE INTO ward_know_items (ward_id, item_id) VALUES (?, ?)").bind(wardId, id);

export async function saveKnowItem(db: D1Database, wardId: string, id: string, input: { body: string }): Promise<void> {
  const now = nowIso();
  await db.batch([upsert(db, wardId, id),
    db.prepare("UPDATE ward_know_items SET body = ?, reviewed_at = ?, updated_at = ? WHERE ward_id = ? AND item_id = ?").bind(input.body, now, now, wardId, id)]);
}

/** 紙の内容を使うか、今のままにするかを決める。どちらでも質問は閉じる。 */
export async function answerKnowProposal(db: D1Database, wardId: string, id: string, use: boolean): Promise<void> {
  const now = nowIso();
  await db.prepare(`UPDATE ward_know_items SET body = CASE WHEN ? = 1 THEN proposed_text ELSE body END, proposed_text = '', proposed_original_id = NULL,
    reviewed_at = ?, updated_at = ? WHERE ward_id = ? AND item_id = ?`).bind(use ? 1 : 0, now, now, wardId, id).run();
}

export async function renameKnowItem(db: D1Database, wardId: string, id: string, title: string): Promise<void> {
  await db.batch([upsert(db, wardId, id),
    db.prepare("UPDATE ward_know_items SET title = ?, updated_at = ? WHERE ward_id = ? AND item_id = ?").bind(title, nowIso(), wardId, id)]);
}

export async function markKnowReviewed(db: D1Database, wardId: string, id: string): Promise<void> {
  const now = nowIso();
  await db.batch([upsert(db, wardId, id),
    db.prepare("UPDATE ward_know_items SET reviewed_at = ?, updated_at = ? WHERE ward_id = ? AND item_id = ?").bind(now, now, wardId, id)]);
}

export async function setKnowRemoved(db: D1Database, wardId: string, id: string, removed: boolean): Promise<void> {
  const now = nowIso();
  await db.batch([upsert(db, wardId, id),
    db.prepare("UPDATE ward_know_items SET removed_at = ?, updated_at = ? WHERE ward_id = ? AND item_id = ?").bind(removed ? now : null, now, wardId, id)]);
}

export async function addKnowItem(db: D1Database, wardId: string, title: string): Promise<string> {
  const id = newId();
  await db.prepare("INSERT INTO ward_know_items (ward_id, item_id, title, added) VALUES (?, ?, ?, 1)").bind(wardId, id, title).run();
  return id;
}

export interface KnowSource { link_id: string; original_id: string; filename: string; media_type: string }

export async function listKnowSources(db: D1Database, wardId: string, id: string): Promise<KnowSource[]> {
  return (await db.prepare(`SELECT l.link_id, o.original_id, o.filename, o.media_type FROM ward_material_links l
    JOIN originals o ON o.ward_id = l.ward_id AND o.original_id = l.original_id
    WHERE l.ward_id = ? AND l.target_kind = 'know_item' AND l.target_id = ? AND o.withdrawn_at IS NULL ORDER BY l.created_at`)
    .bind(wardId, id).all<KnowSource>()).results;
}

export async function linkKnowSource(db: D1Database, wardId: string, id: string, originalId: string): Promise<boolean> {
  const original = await db.prepare("SELECT 1 AS ok FROM originals WHERE ward_id = ? AND original_id = ? AND withdrawn_at IS NULL").bind(wardId, originalId).first();
  if (!original) return false;
  await db.prepare(`INSERT OR IGNORE INTO ward_material_links (ward_id, link_id, original_id, target_kind, target_id, linked_by)
    VALUES (?, ?, ?, 'know_item', ?, 'person')`).bind(wardId, newId(), originalId, id).run();
  return true;
}

export async function unlinkKnowSource(db: D1Database, wardId: string, id: string, linkId: string): Promise<void> {
  await db.prepare("DELETE FROM ward_material_links WHERE ward_id = ? AND link_id = ? AND target_kind = 'know_item' AND target_id = ?").bind(wardId, linkId, id).run();
}

export interface WardFile {
  original_id: string; job_id: string; filename: string; media_type: string; received_at: string;
  project_title: string | null; sender: string | null; via: string;
}

export const WARD_FILES_PAGE = 40;

/** 区の資料。送った紙とファイルを、行き先の有無にかかわらず全部出す。 */
export async function listWardFiles(db: D1Database, wardId: string, page: number): Promise<{ files: WardFile[]; more: boolean }> {
  const rows = await db.prepare(`SELECT o.original_id, o.job_id, o.filename, o.media_type, o.received_at, p.title AS project_title, j.via,
      COALESCE((SELECT i.sender_display_name FROM line_inbox_items i WHERE i.ward_id = o.ward_id AND i.job_id = o.job_id LIMIT 1), j.sender_label) AS sender
    FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
    LEFT JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id
    WHERE o.ward_id = ? AND o.withdrawn_at IS NULL AND j.withdrawn_at IS NULL
    ORDER BY o.received_at DESC, o.original_id LIMIT ? OFFSET ?`).bind(wardId, WARD_FILES_PAGE + 1, page * WARD_FILES_PAGE).all<WardFile>();
  return { files: rows.results.slice(0, WARD_FILES_PAGE), more: rows.results.length > WARD_FILES_PAGE };
}

/** 原本ごとの、役員が知っておくことへのつながり。 */
export async function knowLinksByOriginal(db: D1Database, wardId: string): Promise<Map<string, string[]>> {
  const rows = await db.prepare("SELECT original_id, target_id FROM ward_material_links WHERE ward_id = ? AND target_kind = 'know_item'").bind(wardId).all<{ original_id: string; target_id: string }>();
  const links = new Map<string, string[]>();
  for (const row of rows.results) links.set(row.original_id, [...(links.get(row.original_id) ?? []), row.target_id]);
  return links;
}
