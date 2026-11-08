import { isItemKey, ITEM_SCREEN_LABEL, type ItemKey, type Source } from "./model";

export interface ReferenceConflictItem {
  itemKey: ItemKey;
  options: string[];
  sources: Source[];
  currentValueId?: string;
}

export interface ReferenceConflictDetail {
  scope?: string;
  refYear?: number | null;
  comparisonKey?: string;
  comparisonText?: string;
  items?: ReferenceConflictItem[];
  originals?: { originalId: string; description: string }[];
  options?: string[];
  itemKey?: string;
  sources?: Source[];
  currentValueId?: string;
}

/** 一項目だった保存済みの質問も、項目の並びとして読む。 */
export function referenceConflictItems(detail: ReferenceConflictDetail): ReferenceConflictItem[] {
  const items = detail.items ?? (isItemKey(detail.itemKey) ? [{ itemKey: detail.itemKey,
    options: detail.options ?? [], sources: detail.sources ?? [], currentValueId: detail.currentValueId }] : []);
  if (!items.length || !items.every((item) => isItemKey(item.itemKey) && Array.isArray(item.options)
    && item.options.length >= 2 && item.options.every((value) => typeof value === "string")
    && Array.isArray(item.sources) && item.sources.length === item.options.length
    && item.sources.every((source) => source?.kind === "original" && !!source.ref))) return [];
  return items;
}

export function referenceConflictText(detail: ReferenceConflictDetail): string {
  const captions = detail.originals?.map((original) => original.description) ?? [];
  const items = referenceConflictItems(detail);
  return `${captions.join("と")}で、次の項目が違います。`
    + items.map((item) => `${ITEM_SCREEN_LABEL[item.itemKey]}: ${item.options.map((value) => `「${value}」`).join(" と ")}。`).join("")
    + (detail.comparisonText ?? "") + (captions.length > 2 ? "どの資料が最後ですか。" : "どちらが最後の資料ですか。")
    + "答えるまでも下書きは作れます。";
}
