import type { Reading } from "../ai/schema";

/** 選んだ元の資料だけの読みを残す。下書きの紙と、行事ごとの取り分けで共用する。 */
export function subset(body: Reading, ids: Set<string>): Reading {
  const take = <T extends { original_id: string }>(rows: T[]) => rows.filter((row) => ids.has(row.original_id));
  return { ...body, summary: take(body.text_blocks).map((block) => block.text).join("\n").slice(0, 2000),
    original_years: take(body.original_years), text_blocks: take(body.text_blocks), fields: take(body.fields),
    tables: take(body.tables), decisions: take(body.decisions), unreadable: take(body.unreadable),
    project_suggestions: take(body.project_suggestions ?? []) };
}
