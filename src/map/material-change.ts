import { ITEM_SCREEN_LABEL, TABLES, TABLE_KEYS } from "../project/model";
import type { ProjectState, SourceView } from "../project/types";

const MAX_LABELS = 3;
const MAX_PARTS = 3;

const fromOriginal = (source: SourceView | null, originalId: string) => source?.kind === "original" && source.ref === originalId;

function labelList(labels: string[]): string {
  if (labels.length <= MAX_LABELS) return labels.join("、");
  return `${labels.slice(0, MAX_LABELS).join("、")}など${labels.length}項目`;
}

function itemParts(state: ProjectState, originalId: string): string[] {
  const current = state.items.filter((item) => item.current && fromOriginal(item.current.source, originalId));
  const reference = state.items.filter((item) => !current.includes(item) && item.references.some((value) => fromOriginal(value.source, originalId)));
  return [
    ...(current.length ? [`${labelList(current.map((item) => ITEM_SCREEN_LABEL[item.key]))}を入れました`] : []),
    ...(reference.length ? [`参考に、${labelList(reference.map((item) => ITEM_SCREEN_LABEL[item.key]))}を入れました`] : []),
  ];
}

function tableParts(state: ProjectState, originalId: string): string[] {
  return TABLE_KEYS.flatMap((key) => {
    const rows = state.tables[key].filter((row) => fromOriginal(row.source, originalId));
    if (!rows.length) return [];
    const current = rows.filter((row) => row.scope === "current");
    if (key === "sponsors") {
      const replied = current.filter((row) => row.data.reply === "yes" || row.data.reply === "no").length;
      if (replied) return [`${state.tables.sponsors.filter((row) => row.scope === "current").length}軒のうち${replied}軒の返事を入れました`];
    }
    const place = key === "ledger" ? TABLES[key].label : `${TABLES[key].label}の一覧`;
    return [`${current.length ? "" : "参考に、"}${place}に${rows.length}行入れました`];
  });
}

/** 届いた資料で変わったことを、記録に残った出どころから一行にする。何も入っていなければ空。 */
export function materialChangeText(state: ProjectState, originalId: string): string {
  const tasks = state.mapTasks.filter((task) => fromOriginal(task.progressSource, originalId))
    .map((task) => `「${task.name}」を${task.progress === "done" ? "済み" : "進行中"}にしました`);
  const questions = state.questions.filter((question) => fromOriginal(question.source, originalId)).length;
  return [
    ...tasks,
    ...itemParts(state, originalId),
    ...tableParts(state, originalId),
    ...(questions ? [`質問を${questions === 1 ? "一" : questions}つ足しました`] : []),
  ].slice(0, MAX_PARTS).join("。");
}
