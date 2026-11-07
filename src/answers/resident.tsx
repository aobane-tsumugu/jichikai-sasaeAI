import { PENDING } from "../project/document-body";
import { formatDateText, formatJstDate } from "../core/time";
import { getPublicContact } from "../settings/store";
import { getAnswerLabels, type AnswerLabels } from "../settings/answer-labels";
import { labelsFromBody } from "./counts";

export interface ResidentDocument {
  documentId: string;
  kind: string;
  title: string;
  body: string;
  publishedAt: string;
}

/** 配ったものだけを使う。文書の題が「案内」でも、行事名とは取り違えない。 */
export async function residentContext(db: D1Database, wardId: string, projectId: string) {
  const [result, contact] = await Promise.all([
    db.prepare(`SELECT d.document_id AS documentId, d.kind, COALESCE(v.title, d.title) AS title, v.body, r.published_at AS publishedAt
      FROM publication_records r JOIN documents d ON d.ward_id = r.ward_id AND d.document_id = r.document_id
      JOIN document_versions v ON v.ward_id = r.ward_id AND v.version_id = r.version_id
      WHERE r.ward_id = ? AND r.project_id = ? AND v.scope = 'public' AND r.unpublished_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM publication_records newer WHERE newer.ward_id = r.ward_id
          AND newer.document_id = r.document_id AND newer.version_no > r.version_no)
      ORDER BY r.published_at DESC, r.version_no DESC`).bind(wardId, projectId).all<ResidentDocument>(),
    getPublicContact(db, wardId),
  ]);
  const documents = result.results;
  const announcement = documents.find((document) => document.kind === "announcement");
  const labels: AnswerLabels = announcement ? labelsFromBody(announcement.body) : await getAnswerLabels(db, wardId);
  const eventDocuments = [
    ...documents.filter((document) => document.kind === "notice"),
    ...documents.filter((document) => document.kind === "announcement"),
    ...documents.filter((document) => document.kind === "recruitment"),
  ];
  const notices = documents.filter((document) => document.kind === "notice");
  const item = (key: string) => {
    // 知らせがある行事の日時と場所は、知らせの本文に書かれた物だけを出す。古い項目や案内へ戻らない。
    if (notices.length && (key === "date_time" || key === "place")) {
      for (const notice of notices) {
        const value = publishedItem(notice.body, key);
        if (value && writtenInNotice(notice.body, value)) return value;
      }
      return "";
    }
    for (const document of eventDocuments) {
      const value = publishedItem(document.body, key);
      if (value) return value;
    }
    return "";
  };
  return { documents, hasNotice: notices.length > 0, contact: item("public_contact") || contact, labels, item };
}

function noticeText(body: string): string {
  try {
    const parsed = JSON.parse(body) as { text?: unknown };
    return typeof parsed.text === "string" ? parsed.text : "";
  } catch { return ""; }
}

/** 知らせの項目が本文にそのまま書かれているか。古い項目が残った時は出さない。 */
function writtenInNotice(body: string, value: string): boolean {
  const text = noticeText(body);
  return text.includes(value) || text.includes(formatDateText(value));
}

export function publishedItem(body: string, key: string): string {
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed !== "object" || parsed === null || !("items" in parsed) || !Array.isArray(parsed.items)) return "";
    const item: unknown = parsed.items.find((value: unknown) => typeof value === "object" && value !== null && "key" in value && value.key === key);
    return typeof item === "object" && item !== null && "content" in item && typeof item.content === "string" && item.content.trim() !== PENDING ? item.content : "";
  } catch { return ""; }
}

export function ResidentContact({ contact }: { contact: string }) {
  return <p style="white-space:pre-wrap">{contact || "連絡先が分からないときは、班長か役員にお知らせください。"}</p>;
}

export function ReceptionClosed({ closed, due }: { closed: boolean; due: string | null }) {
  return <section class="notice"><h2>返事の受付は終わりました</h2>
    <p>{closed ? "この行事は終わりました。" : due ? `${formatJstDate(due)}で締め切りました。` : "受付は終わりました。"}変えたいときは、下の連絡先へお知らせください。</p>
  </section>;
}

export function EventDetails({ item, due, hasNotice = false }: { item: (key: string) => string; due?: string | null; hasNotice?: boolean }) {
  // 知らせの本文に日時も場所も書かれていない時は、案内へ戻って読めるようにする。
  if (hasNotice && !item("date_time") && !item("place")) return <p>お知らせがあります。日時や場所は案内で確かめてください。</p>;
  return <dl class="facts">{[["date_time", "いつ"], ["place", "どこで"], ["rain_plan", "雨のとき"]].map(([key, label]) => item(key!) ? <><dt>{label}</dt><dd>{formatDateText(item(key!))}</dd></> : null)}{due ? <><dt>返事の締切</dt><dd>{formatJstDate(due)}まで</dd></> : null}</dl>;
}
