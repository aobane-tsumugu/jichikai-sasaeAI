import { ITEM_LABEL, isItemKey, type ItemKey } from "./model";

/** 下書きで、分からない項目に入れておく印。配る紙とページには出さない。 */
export const PENDING = "（確認中）";

/** 配る本文から、まだ決まっていない所を外す。見出しと印だけの段は見出しごと、文の中なら文ごと外す。 */
export function withoutPending(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const kept: string[] = [];
  lines.forEach((line, index) => {
    if (!line.includes(PENDING)) { kept.push(line); return; }
    if (line.trim() === PENDING) {
      const nextLine = lines[index + 1]?.trim();
      while (kept.length && !kept[kept.length - 1]!.trim()) kept.pop();
      const heading = kept[kept.length - 1]?.trim() ?? "";
      if (!nextLine && heading && heading.length <= 30 && !/[。！？]$/.test(heading)) kept.pop();
      return;
    }
    const rest = line.split(/(?<=。)/).filter((sentence) => !sentence.includes(PENDING)).join("");
    if (rest.trim()) kept.push(rest);
  });
  return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

const bigrams = (value: string) => {
  const plain = value.replace(/[\s　、。・：:，,（）()「」『』■]/g, "");
  return Array.from({ length: Math.max(plain.length - 1, 0) }, (_, index) => plain.slice(index, index + 2));
};

/** 本文に書いてある項目か。紙とページで同じ決まりにする。要約の項目は言い換えがあるので、文字の重なりも見る。 */
export function writtenInText(key: string, content: string, text: string): boolean {
  const value = content.trim();
  if (!value || (isItemKey(key) && text.includes(ITEM_LABEL[key])) || text.includes(value.slice(0, 10))) return true;
  const pairs = bigrams(value);
  return pairs.length > 0 && pairs.filter((pair) => text.includes(pair)).length / pairs.length >= 0.6;
}

export interface DocumentBody {
  text: string;
  items: { key: ItemKey; content: string; source?: string }[];
}

/** 本文を直した時はその文を優先し、項目だけ直した時は文中の同じ中身も揃える。AI は使わない。 */
/** textFirst は知らせのように本文を正にする文書。本文を直した時、本文に無い古い項目を残さない。 */
export function reconcileDocumentBody(previous: DocumentBody, next: DocumentBody, checks?: ItemKey[], textFirst = false): DocumentBody {
  // フォーム送信で変わる改行の形式だけでは、本文を手で直した扱いにしない。
  const textChanged = previous.text.replace(/\r\n/g, "\n") !== next.text.replace(/\r\n/g, "\n");
  let text = next.text;
  const replacements = new Map<string, string>();
  const items = next.items.filter((item) => {
    const old = previous.items.find((entry) => entry.key === item.key);
    if (textFirst && textChanged && item.content === (old?.content ?? "") && !next.text.includes(item.content.trim().slice(0, 10))) return false;
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
      date_time: ["いつ"], place: ["どこで"], rain_plan: ["雨天時"], content: ["内容"], public_contact: ["問い合わせ先", "連絡先"],
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
