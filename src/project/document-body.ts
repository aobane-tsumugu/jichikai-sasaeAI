import type { ItemKey } from "./model";

export interface DocumentBody {
  text: string;
  items: { key: ItemKey; content: string; source?: string }[];
}

/** 本文を直した時はその文を優先し、項目だけ直した時は文中の同じ中身も揃える。AI は使わない。 */
export function reconcileDocumentBody(previous: DocumentBody, next: DocumentBody): DocumentBody {
  // フォーム送信で変わる改行の形式だけでは、本文を手で直した扱いにしない。
  const textChanged = previous.text.replace(/\r\n/g, "\n") !== next.text.replace(/\r\n/g, "\n");
  let text = next.text;
  const replacements = new Map<string, string>();
  const items = next.items.filter((item) => {
    const old = previous.items.find((entry) => entry.key === item.key);
    // 一文字の中身は本文の別の所にも当たるので、揃えない。
    if (!old?.content || old.content.length < 2 || !previous.text.includes(old.content)) return true;
    if (textChanged) {
      // 同時に直した項目も、役員が書いた文と食い違うなら足さない。
      return item.content !== old.content ? next.text.includes(item.content) : next.text.includes(old.content);
    }
    if (item.content !== old.content && !replacements.has(old.content)) replacements.set(old.content, item.content);
    return true;
  });
  if (replacements.size) {
    // 元の本文から一度で置き換え、入れた中身を別の項目の旧値として扱わない。
    const pattern = [...replacements.keys()].sort((a, b) => b.length - a.length)
      .map((content) => content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    text = text.replace(new RegExp(pattern, "g"), (content) => replacements.get(content) ?? content);
  }
  return { text, items };
}
