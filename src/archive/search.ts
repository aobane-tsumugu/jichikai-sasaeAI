// 記録の検索。FTS5 の三文字索引を使い、区の中の上位だけを返す。
import { PROJECT_KINDS, type ProjectKind } from "../project/model";

export const ARCHIVE_RECORD_TYPES = ["reading", "decision", "report", "map"] as const;
export type ArchiveRecordType = (typeof ARCHIVE_RECORD_TYPES)[number];

export interface ArchiveSearchResult {
  entry_id: number;
  project_id: string;
  title: string;
  project_kind: string;
  year: number;
  record_type: ArchiveRecordType;
  counterpart: string;
  source_id: string;
  locator: string;
  excerpt: string;
}

export interface ArchiveSearchInput {
  query: string;
  year?: number;
  recordType?: ArchiveRecordType;
  projectKind?: ProjectKind;
  counterpart?: string;
  limit?: number;
}

export async function searchArchive(db: D1Database, wardId: string, input: ArchiveSearchInput): Promise<ArchiveSearchResult[]> {
  const query = input.query.trim();
  if (query.length < 3) return [];
  const clauses = ["e.ward_id = ?", "archive_search_fts MATCH ?"];
  const binds: (string | number)[] = [wardId, `"${query.replaceAll('"', '""')}"`];
  if (input.year !== undefined) {
    clauses.push("e.year = ?");
    binds.push(input.year);
  }
  if (input.recordType) {
    clauses.push("e.record_type = ?");
    binds.push(input.recordType);
  }
  if (input.projectKind && PROJECT_KINDS.includes(input.projectKind)) {
    clauses.push("p.kind = ?");
    binds.push(input.projectKind);
  }
  if (input.counterpart?.trim()) {
    clauses.push("instr(e.counterpart, ?) > 0");
    binds.push(input.counterpart.trim().slice(0, 100));
  }
  binds.push(Math.max(1, Math.min(input.limit ?? 20, 50)));
  const result = await db.prepare(`
    SELECT e.entry_id, e.project_id, p.title, p.kind AS project_kind, e.year, e.record_type,
           e.counterpart, e.source_id, e.locator,
           snippet(archive_search_fts, 0, '「', '」', ' … ', 16) AS excerpt
      FROM archive_search_fts
      JOIN archive_search_entries e ON e.entry_id = archive_search_fts.rowid
      JOIN projects p ON p.ward_id = e.ward_id AND p.project_id = e.project_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY e.year DESC, e.created_at DESC, e.entry_id DESC
     LIMIT ?`).bind(...binds).all<ArchiveSearchResult>();
  return result.results;
}
