import { TABLES, displayFieldValue, type RowData } from "../project/model";

type SpaceTable = "sponsors" | "duties" | "layout";

/** 空間では協賛の額と打診の中身を出さず、決められた見出しと読める値だけを並べる。 */
export function MaterialsTable({ table, items }: {
  table: SpaceTable;
  items: { kind: string; data: Record<string, unknown> }[];
}) {
  const rows = items.filter((item) => item.kind === table);
  if (!rows.length) return <p>まだありません。</p>;
  const fields = Object.entries(TABLES[table].fields).filter(([name]) =>
    table !== "sponsors" || name === "name" || name === "reply");
  return <div class="panel" role="region" aria-label={TABLES[table].label}>
    <table class="stack">
      <caption>{table === "duties" ? "当番表" : table === "layout" ? "配置図" : "協賛先と打診"}</caption>
      <thead><tr>{fields.map(([name, field]) => <th scope="col" key={name}>{field.label}</th>)}</tr></thead>
      <tbody>{rows.map((row, index) => <tr key={index}>{fields.map(([name]) => {
        const value = row.data[name];
        const text: RowData[string] | undefined = typeof value === "string" || typeof value === "number" ? value : undefined;
        return <td key={name} data-label={TABLES[table].fields[name]?.label} class="preserve-lines">{displayFieldValue(table, name, text) || "—"}</td>;
      })}</tr>)}</tbody>
    </table>
  </div>;
}
