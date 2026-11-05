// 記録の検索。三文字以上は FTS5 の三文字索引、二文字と問いの文は本文を直に見て、区の中の上位だけを返す。
import { PROJECT_KINDS, type ProjectKind } from "../project/model";

export const ARCHIVE_RECORD_TYPES = ["reading", "decision", "report", "map"] as const;
export type ArchiveRecordType = (typeof ARCHIVE_RECORD_TYPES)[number];

export interface ArchiveSearchResult {
  entry_id: number;
  project_id: string;
  title: string;
  closed_at: string | null;
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
  if (query.length < 2) return [];
  const short = query.length < 3;
  const clauses = ["e.ward_id = ?", short ? "instr(e.content, ?) > 0" : "archive_search_fts MATCH ?"];
  const binds: (string | number)[] = [wardId, short ? query : `"${query.replaceAll('"', '""')}"`];
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
    SELECT e.entry_id, e.project_id, p.title, p.closed_at, p.kind AS project_kind, e.year, e.record_type,
           e.counterpart, e.source_id, e.locator,
           ${short ? "substr(e.content, 1, 80)" : "snippet(archive_search_fts, 0, '「', '」', ' … ', 16)"} AS excerpt
      FROM ${short ? "archive_search_entries e" : "archive_search_fts JOIN archive_search_entries e ON e.entry_id = archive_search_fts.rowid"}
      JOIN projects p ON p.ward_id = e.ward_id AND p.project_id = e.project_id
     WHERE ${clauses.join(" AND ")}
     ORDER BY e.year DESC, e.created_at DESC, e.entry_id DESC
     LIMIT ?`).bind(...binds).all<ArchiveSearchResult>();
  return result.results;
}

/** 問いの文から探す言葉を取り出す。かなと記号で切り、漢字、カタカナ、英数の二文字以上を残す。 */
export function questionTerms(question: string): string[] {
  return [...new Set(question.match(/[\p{Script=Han}\p{Script=Katakana}ー0-9A-Za-z]{2,}/gu) ?? [])].slice(0, 6);
}

/** 記録に聞く時の断片。言葉が多く当たる物を先に、答えを作れるだけの長さで返す。 */
export async function findFragments(db: D1Database, wardId: string, question: string, limit: number): Promise<ArchiveSearchResult[]> {
  const terms = questionTerms(question);
  if (terms.length === 0) return [];
  const hits = terms.map(() => "(instr(e.content, ?) > 0)").join(" + ");
  const result = await db.prepare(`
    SELECT e.entry_id, e.project_id, p.title, p.closed_at, p.kind AS project_kind, e.year, e.record_type,
           e.counterpart, e.source_id, e.locator, substr(e.content, 1, 600) AS excerpt
      FROM archive_search_entries e
      JOIN projects p ON p.ward_id = e.ward_id AND p.project_id = e.project_id
     WHERE e.ward_id = ? AND (${hits}) > 0
     ORDER BY (${hits}) DESC, e.year DESC, e.entry_id DESC
     LIMIT ?`).bind(wardId, ...terms, ...terms, limit).all<ArchiveSearchResult>();
  return result.results;
}
