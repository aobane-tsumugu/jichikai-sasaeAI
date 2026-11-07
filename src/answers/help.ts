import { newId, nowIso } from "../core/ids";

export interface HelpOpportunity {
  projectId: string;
  title: string;
  body: string;
  publishedAt: string;
}

export interface HelpOffer {
  offerId: string;
  name: string;
  times: string;
}

/** 取消をその場で戻すために、役員画面だけへ返す内容。 */
export interface HelpOfferReceipt extends HelpOffer {
  submissionId: string | null;
  createdAt: string;
}

export async function getHelpOffer(db: D1Database, wardId: string, projectId: string, offerId: string): Promise<HelpOffer | null> {
  return db.prepare(`SELECT offer_id AS offerId, name, times FROM project_help_offers
    WHERE ward_id = ? AND project_id = ? AND offer_id = ?`).bind(wardId, projectId, offerId).first<HelpOffer>();
}

/** 連絡を受けた訂正は締切後も受ける。閉じた行事は変えない。 */
export async function updateHelpOffer(db: D1Database, wardId: string, projectId: string, offerId: string, times: string): Promise<boolean> {
  const result = await db.prepare(`UPDATE project_help_offers SET times = ?
    WHERE ward_id = ? AND project_id = ? AND offer_id = ?
      AND EXISTS (SELECT 1 FROM projects p WHERE p.ward_id = ? AND p.project_id = ? AND p.closed_at IS NULL)`)
    .bind(times, wardId, projectId, offerId, wardId, projectId).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function cancelHelpOffer(db: D1Database, wardId: string, projectId: string, offerId: string): Promise<HelpOfferReceipt | null> {
  return db.prepare(`DELETE FROM project_help_offers WHERE ward_id = ? AND project_id = ? AND offer_id = ?
    AND EXISTS (SELECT 1 FROM projects p WHERE p.ward_id = ? AND p.project_id = ? AND p.closed_at IS NULL)
    RETURNING offer_id AS offerId, name, times, submission_id AS submissionId, created_at AS createdAt`)
    .bind(wardId, projectId, offerId, wardId, projectId).first<HelpOfferReceipt>();
}

/** 募集の締切を過ぎても、押し間違えた取消は同じ申込として戻せる。 */
export async function restoreHelpOffer(db: D1Database, wardId: string, projectId: string, offer: HelpOfferReceipt): Promise<boolean> {
  await db.prepare(`INSERT INTO project_help_offers (offer_id, ward_id, project_id, name, times, submission_id, created_at)
    SELECT ?, ?, p.project_id, ?, ?, ?, ? FROM projects p
    WHERE p.ward_id = ? AND p.project_id = ? AND p.closed_at IS NULL
    ON CONFLICT DO NOTHING`)
    .bind(offer.offerId, wardId, offer.name, offer.times, offer.submissionId, offer.createdAt, wardId, projectId).run();
  return (await getHelpOffer(db, wardId, projectId, offer.offerId)) !== null;
}

function todayInJapan(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
}

/** 配った募集だけを読む。名簿と、まだ配っていない案は参照しない。 */
export async function listHelpOpportunities(db: D1Database, wardId: string, projectId?: string): Promise<HelpOpportunity[]> {
  const result = await db.prepare(`SELECT p.project_id AS projectId, p.title, v.body, r.published_at AS publishedAt
    FROM projects p JOIN documents d ON d.ward_id = p.ward_id AND d.project_id = p.project_id
    JOIN publication_records r ON r.ward_id = d.ward_id AND r.project_id = d.project_id AND r.document_id = d.document_id
    JOIN document_versions v ON v.ward_id = r.ward_id AND v.version_id = r.version_id
    LEFT JOIN project_deadlines deadline ON deadline.ward_id = p.ward_id AND deadline.project_id = p.project_id AND deadline.kind = 'answer_due'
    WHERE p.ward_id = ? AND p.closed_at IS NULL AND d.kind = 'recruitment' AND v.scope = 'public'
      AND r.unpublished_at IS NULL AND (deadline.due_on IS NULL OR deadline.due_on >= ?)
      AND NOT EXISTS (SELECT 1 FROM publication_records newer
        WHERE newer.ward_id = r.ward_id AND newer.document_id = r.document_id AND newer.version_no > r.version_no)
      ${projectId ? "AND p.project_id = ?" : ""}
    ORDER BY p.title`).bind(wardId, todayInJapan(), ...(projectId ? [projectId] : [])).all<HelpOpportunity>();
  return result.results;
}

/** 配った募集の「手伝いの時間帯」を選択肢にする。本文は別にそのまま表示する。 */
export function helpTimeChoices(body: string): string[] {
  let value: unknown;
  try { value = JSON.parse(body); } catch { return []; }
  if (typeof value !== "object" || value === null || !("items" in value) || !Array.isArray(value.items)) return [];
  const choices: string[] = [];
  const items: unknown[] = value.items;
  for (const item of items) {
    if (typeof item !== "object" || item === null || !("key" in item) || item.key !== "helper_slots" || !("content" in item) || typeof item.content !== "string") continue;
    choices.push(...item.content.split(/[\n\r、,]+/).map((time) => time.trim()).filter(Boolean));
  }
  return [...new Set(choices)];
}

export async function getHelpOfferBySubmission(db: D1Database, wardId: string, projectId: string, submissionId: string): Promise<HelpOffer | null> {
  return db.prepare(`SELECT offer_id AS offerId, name, times FROM project_help_offers WHERE ward_id = ? AND project_id = ? AND submission_id = ?`)
    .bind(wardId, projectId, submissionId).first<HelpOffer>();
}

export async function addHelpOffer(db: D1Database, wardId: string, projectId: string, name: string, times: string, submissionId?: string): Promise<HelpOffer | null> {
  const existing = () => submissionId
    ? getHelpOfferBySubmission(db, wardId, projectId, submissionId)
    : db.prepare(`SELECT offer_id AS offerId, name, times FROM project_help_offers WHERE ward_id = ? AND project_id = ? AND name = ? AND times = ? LIMIT 1`)
      .bind(wardId, projectId, name, times).first<HelpOffer>();
  const same = await existing();
  if (same) return same;
  const offerId = newId();
  const result = await db.prepare(`INSERT INTO project_help_offers (offer_id, ward_id, project_id, name, times, created_at, submission_id)
    SELECT ?, ?, p.project_id, ?, ?, ?, ? FROM projects p
    WHERE p.ward_id = ? AND p.project_id = ? AND p.closed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM project_deadlines deadline WHERE deadline.ward_id = p.ward_id
        AND deadline.project_id = p.project_id AND deadline.kind = 'answer_due' AND deadline.due_on < ?)
      AND EXISTS (SELECT 1 FROM documents d JOIN publication_records r
        ON r.ward_id = d.ward_id AND r.project_id = d.project_id AND r.document_id = d.document_id
        JOIN document_versions v ON v.ward_id = r.ward_id AND v.version_id = r.version_id
        WHERE d.ward_id = p.ward_id AND d.project_id = p.project_id AND d.kind = 'recruitment'
          AND v.scope = 'public' AND r.unpublished_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM publication_records newer WHERE newer.ward_id = r.ward_id
            AND newer.document_id = r.document_id AND newer.version_no > r.version_no))
    ON CONFLICT (ward_id, project_id, submission_id) WHERE submission_id IS NOT NULL DO NOTHING`)
    .bind(offerId, wardId, name, times, nowIso(), submissionId || null, wardId, projectId, todayInJapan()).run();
  if ((result.meta.changes ?? 0) > 0) return { offerId, name, times };
  return submissionId ? existing() : null;
}

export async function listHelpOffers(db: D1Database, wardId: string, projectId: string): Promise<HelpOffer[]> {
  const result = await db.prepare(`SELECT offer_id AS offerId, name, times FROM project_help_offers
    WHERE ward_id = ? AND project_id = ? ORDER BY created_at, offer_id`).bind(wardId, projectId).all<HelpOffer>();
  return result.results;
}
