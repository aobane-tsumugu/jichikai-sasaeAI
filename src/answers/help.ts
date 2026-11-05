import { newId, nowIso } from "../core/ids";

export interface HelpOpportunity {
  projectId: string;
  title: string;
  body: string;
}

export interface HelpOffer {
  offerId: string;
  name: string;
  times: string;
}

function todayInJapan(): string {
  return new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
}

/** 配った募集だけを読む。名簿と、まだ配っていない案は参照しない。 */
export async function listHelpOpportunities(db: D1Database, wardId: string, projectId?: string): Promise<HelpOpportunity[]> {
  const result = await db.prepare(`SELECT p.project_id AS projectId, p.title, v.body
    FROM projects p JOIN documents d ON d.ward_id = p.ward_id AND d.project_id = p.project_id
    JOIN publication_records r ON r.ward_id = d.ward_id AND r.project_id = d.project_id AND r.document_id = d.document_id
    JOIN document_versions v ON v.ward_id = r.ward_id AND v.version_id = r.version_id
    LEFT JOIN project_deadlines deadline ON deadline.ward_id = p.ward_id AND deadline.project_id = p.project_id AND deadline.kind = 'answer_due'
    WHERE p.ward_id = ? AND p.closed_at IS NULL AND d.kind = 'recruitment' AND d.scope = 'public'
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

export async function addHelpOffer(db: D1Database, wardId: string, projectId: string, name: string, times: string): Promise<boolean> {
  const result = await db.prepare(`INSERT INTO project_help_offers (offer_id, ward_id, project_id, name, times, created_at)
    SELECT ?, ?, p.project_id, ?, ?, ? FROM projects p
    WHERE p.ward_id = ? AND p.project_id = ? AND p.closed_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM project_deadlines deadline WHERE deadline.ward_id = p.ward_id
        AND deadline.project_id = p.project_id AND deadline.kind = 'answer_due' AND deadline.due_on < ?)
      AND EXISTS (SELECT 1 FROM documents d JOIN publication_records r
        ON r.ward_id = d.ward_id AND r.project_id = d.project_id AND r.document_id = d.document_id
        WHERE d.ward_id = p.ward_id AND d.project_id = p.project_id AND d.kind = 'recruitment'
          AND d.scope = 'public' AND r.unpublished_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM publication_records newer WHERE newer.ward_id = r.ward_id
            AND newer.document_id = r.document_id AND newer.version_no > r.version_no))`)
    .bind(newId(), wardId, name, times, nowIso(), wardId, projectId, todayInJapan()).run();
  return (result.meta.changes ?? 0) > 0;
}

export async function listHelpOffers(db: D1Database, wardId: string, projectId: string): Promise<HelpOffer[]> {
  const result = await db.prepare(`SELECT offer_id AS offerId, name, times FROM project_help_offers
    WHERE ward_id = ? AND project_id = ? ORDER BY created_at, offer_id`).bind(wardId, projectId).all<HelpOffer>();
  return result.results;
}
