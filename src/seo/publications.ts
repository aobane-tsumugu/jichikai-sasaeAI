/** 下書きの範囲や本文は見ず、配ったときに公開だった内容を読む。 */
export interface PublicDocument {
  project_id: string;
  project_title: string;
  kind: string;
  body: string;
}

export async function publicDocuments(db: D1Database, wardId: string, projectId?: string): Promise<PublicDocument[]> {
  const result = await db.prepare(`SELECT p.project_id, p.title AS project_title, d.kind, v.body
    FROM publication_records r
    JOIN projects p ON p.ward_id = r.ward_id AND p.project_id = r.project_id
    JOIN documents d ON d.ward_id = r.ward_id AND d.project_id = r.project_id AND d.document_id = r.document_id
    JOIN document_versions v ON v.ward_id = r.ward_id AND v.project_id = r.project_id
      AND v.document_id = r.document_id AND v.version_id = r.version_id
    WHERE r.ward_id = ? AND v.scope = 'public' AND r.unpublished_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM publication_records newer WHERE newer.ward_id = r.ward_id
        AND newer.document_id = r.document_id AND newer.version_no > r.version_no)
      ${projectId ? "AND r.project_id = ?" : ""}
    ORDER BY r.published_at DESC, r.version_no DESC`)
    .bind(wardId, ...(projectId ? [projectId] : [])).all<PublicDocument>();
  return result.results;
}
