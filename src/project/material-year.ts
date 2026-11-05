// 役員が原本を今年の資料だと直す。読み取りは変えず、今年の年を付けて通常の適用を通す。
import { nowIso } from "../core/ids";
import { originalInProject } from "../intake/store";
import { applyChange } from "./apply";
import { getProjectState } from "./state";
import type { ChangeInput, ProjectState, RowView, ValueView } from "./types";

/** 年不明の中身を持つ原本だけに、今年の物に直す操作を出す。 */
export function unknownYearContents(state: ProjectState) {
  const isUnknown = (value: ValueView | RowView) => value.scope === "reference" && value.refYear === null
    && value.source.kind === "original" && value.source.ref !== null && value.source.year === null;
  return {
    items: state.items.flatMap((item) => item.references.filter(isUnknown).map((value) => ({ itemKey: item.key, ...value }))),
    rows: Object.values(state.tables).flat().filter(isUnknown),
  };
}

export async function markMaterialThisYear(
  db: D1Database, wardId: string, projectId: string, originalId: string, accountId: string,
): Promise<boolean> {
  const state = await getProjectState(db, wardId, projectId);
  if (!state || state.project.closedAt || !(await originalInProject(db, wardId, projectId, originalId))) return false;
  const unknown = unknownYearContents(state);
  const items = unknown.items.filter((value) => value.source.ref === originalId);
  const rows = unknown.rows.filter((row) => row.source.ref === originalId);
  const options = { actorAccountId: accountId, compareCurrent: true };
  const changes: Array<{ change: ChangeInput; retire: D1PreparedStatement }> = [];
  const now = nowIso();
  for (const value of items) {
    changes.push({
      change: { kind: "item", itemKey: value.itemKey, value: value.content, confidence: value.confidence,
        packVersion: "material-year@1", source: { kind: "original", ref: originalId, locator: value.source.locator ?? "全体", year: state.project.year } },
      retire: db.prepare(`UPDATE project_item_values SET superseded_at = ?
        WHERE ward_id = ? AND project_id = ? AND value_id = ? AND scope = 'reference' AND ref_year IS NULL AND superseded_at IS NULL`)
        .bind(now, wardId, projectId, value.valueId),
    });
  }
  for (const row of rows) {
    changes.push({
      change: { kind: "row", table: row.table, data: row.data, confidence: row.confidence,
        packVersion: "material-year@1", source: { kind: "original", ref: originalId, locator: row.source.locator ?? "全体", year: state.project.year } },
      retire: db.prepare(`UPDATE project_rows SET removed_at = ?
        WHERE ward_id = ? AND project_id = ? AND row_id = ? AND scope = 'reference' AND ref_year IS NULL AND removed_at IS NULL`)
        .bind(now, wardId, projectId, row.rowId),
    });
  }
  for (const { change, retire } of changes) {
    const result = await applyChange(db, wardId, projectId, change, options);
    if (result.status === "rejected" || result.status === "dropped") return false;
    // 今年の中身か食い違いの問いとして残った後に、年不明の参考から外す。原本と変更の記録は残る。
    await db.batch([
      retire,
      db.prepare("UPDATE projects SET state_version = state_version + 1 WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL")
        .bind(wardId, projectId),
    ]);
  }
  return true;
}
