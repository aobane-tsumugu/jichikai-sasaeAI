import type { RowData } from "../project/model";

export interface PublishedTableRow {
  kind: "duties" | "layout" | "sponsors";
  data: RowData;
}

/** 配布の記録を作る SQL の中で使う。区とプロジェクトをこの順に bind する。 */
export const publicationTablesSql = `(SELECT json_group_array(json_object('kind', table_key, 'data', json(data)))
  FROM (SELECT table_key, data FROM project_rows
    WHERE ward_id = ? AND project_id = ? AND scope = 'current' AND removed_at IS NULL
      AND table_key IN ('duties', 'layout', 'sponsors') ORDER BY table_key, created_at, row_id))`;

/** NULL は保存を始める前の配布。今の表で補わない。 */
export function readPublicationTables(raw: string | null): PublishedTableRow[] | null {
  return raw === null ? null : JSON.parse(raw) as PublishedTableRow[];
}

export async function currentPublicationTables(db: D1Database, wardId: string, projectId: string): Promise<PublishedTableRow[]> {
  const row = await db.prepare(`SELECT ${publicationTablesSql} AS tables_snapshot`)
    .bind(wardId, projectId).first<{ tables_snapshot: string }>();
  if (!row) throw new Error("表を読み取れませんでした。");
  return JSON.parse(row.tables_snapshot) as PublishedTableRow[];
}

export async function latestSpaceTables(db: D1Database, wardId: string, projectId: string) {
  return db.prepare(`SELECT v.tables_snapshot FROM document_versions v
    JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
    WHERE v.ward_id = ? AND v.project_id = ? AND v.scope = 'space' AND v.published_at IS NOT NULL
      AND d.kind IN ('duty_roster', 'procedure')
    ORDER BY v.published_at DESC, v.rowid DESC LIMIT 1`)
    .bind(wardId, projectId).first<{ tables_snapshot: string | null }>();
}

/** 行や項目の並び順だけでは配り直しの案内を出さない。 */
export function publicationTablesDiffer(raw: string | null, current: PublishedTableRow[]): boolean {
  const previous = readPublicationTables(raw);
  if (previous === null) return true;
  const contents = (rows: PublishedTableRow[]) => rows.map((row) =>
    JSON.stringify([row.kind, Object.entries(row.data).sort(([a], [b]) => a.localeCompare(b))])).sort();
  return JSON.stringify(contents(previous)) !== JSON.stringify(contents(current));
}
