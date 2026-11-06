import type { ItemKey } from "./model";

export interface DocumentBody {
  text: string;
  items: { key: ItemKey; content: string; source?: string }[];
}

/** 本文を直した時はその文を優先し、項目だけ直した時は文中の同じ中身も揃える。AI は使わない。 */
export function reconcileDocumentBody(previous: DocumentBody, next: DocumentBody): DocumentBody {
  const textChanged = previous.text !== next.text;
  let text = next.text;
  const items = next.items.filter((item) => {
    const old = previous.items.find((entry) => entry.key === item.key);
    if (!old?.content || !previous.text.includes(old.content)) return true;
    if (textChanged) {
      // 同時に直した項目も、役員が書いた文と食い違うなら足さない。
      return item.content !== old.content ? next.text.includes(item.content) : next.text.includes(old.content);
    }
    if (item.content !== old.content) text = text.split(old.content).join(item.content);
    return true;
  });
  return { text, items };
}
