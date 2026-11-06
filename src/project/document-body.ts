import { ITEM_LABEL, isItemKey, type ItemKey } from "./model";

export interface DocumentBody {
  text: string;
  items: { key: ItemKey; content: string; source?: string }[];
}

/** 本文を直した時はその文を優先し、項目だけ直した時は文中の同じ中身も揃える。AI は使わない。 */
export function reconcileDocumentBody(previous: DocumentBody, next: DocumentBody, checks?: ItemKey[]): DocumentBody {
  // フォーム送信で変わる改行の形式だけでは、本文を手で直した扱いにしない。
  const textChanged = previous.text.replace(/\r\n/g, "\n") !== next.text.replace(/\r\n/g, "\n");
  let text = next.text;
  const replacements = new Map<string, string>();
  const items = next.items.filter((item) => {
    const old = previous.items.find((entry) => entry.key === item.key);
    // 一文字の中身は本文の別の所にも当たるので、揃えない。
    if (!old?.content || old.content === "（確認中）" || old.content.length < 2 || !previous.text.includes(old.content)) return true;
    if (textChanged) {
      // 同時に直した項目も、役員が書いた文と食い違うなら足さない。
      return item.content !== old.content ? next.text.includes(item.content) : next.text.includes(old.content);
    }
    if (item.content !== old.content && !replacements.has(old.content)) replacements.set(old.content, item.content);
    return true;
  });
  // 別の項目の一部に当たり、その項目を意図しない中身に変える置換は本文全体にかけない。
  const shared = new Set([...replacements].filter(([content, replacement]) => previous.items.some((old) =>
    old.content.includes(content) && (items.find((item) => item.key === old.key)?.content ?? old.content) !== old.content.replaceAll(content, replacement)))
    .map(([content]) => content));
  for (const content of shared) replacements.delete(content);
  if (replacements.size) {
    // 元の本文から一度で置き換え、入れた中身を別の項目の旧値として扱わない。
    const pattern = [...replacements.keys()].sort((a, b) => b.length - a.length)
      .map((content) => content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    text = text.replace(new RegExp(pattern, "g"), (content) => replacements.get(content) ?? content);
  }
  for (const item of items) {
    const old = previous.items.find((entry) => entry.key === item.key);
    if (!item.content.trim() || item.content === old?.content) continue;
    // 共通の文字は項目の見出しがある箇所だけを直す。確認中の欄も同じ形で埋める。
    const aliases: Partial<Record<ItemKey, string[]>> = {
      rain_plan: ["雨天時"], content: ["内容"], public_contact: ["問い合わせ先"],
    };
    const labels = [ITEM_LABEL[item.key], ...(aliases[item.key] ?? [])]
      .map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const previousValues = ["（確認中）", ...(old && shared.has(old.content) ? [old.content] : [])]
      .map((content) => content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
    const placeholder = new RegExp(`^([ \\t　]*(?:■[ \\t　]*)?(?:${labels})[ \\t　]*(?:[:：][ \\t　]*)?(?:\\r?\\n[ \\t　]*)?)(?:${previousValues})([ \\t　]*\\r?$)`, "gm");
    let filled = false;
    text = text.replace(placeholder, (_match, heading: string, ending: string) => {
      filled = true;
      return heading + item.content + ending;
    });
    const replaced = !textChanged && !!old?.content && replacements.has(old.content);
    if (checks && previous.text.trim() && !filled && !replaced && (!textChanged || !text.includes(item.content))) checks.push(item.key);
  }
  return { text, items };
}

/** 保存後の画面でだけ、本文も確かめる項目を一文で知らせる。 */
export function documentBodyCheckMessage(raw: string | undefined): string | null {
  const labels = [...new Set((raw ?? "").split(",").filter(isItemKey))].map((key) => ITEM_LABEL[key]);
  return labels.length ? `本文の${labels.join("、")}のところも確かめてください。` : null;
}
