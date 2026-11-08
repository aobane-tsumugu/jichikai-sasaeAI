import { ITEM_KEYS, ITEM_LABEL, ITEM_SCREEN_LABEL, isItemKey, type ItemKey } from "./model";

/** AI が質問の対象に書く言葉のぶれ（鍵、本文の見出し、画面の名前、言い換え）を、項目の鍵にそろえる。 */
const OTHER_NAMES: Partial<Record<ItemKey, string[]>> = {
  date_time: ["日程", "日付", "開催日", "実施日", "日にち"],
  place: ["会場"],
  rain_plan: ["雨天時"],
  due: ["返事の締切", "申し込みの締切", "提出の締切", "回答の締切"],
  public_contact: ["問い合わせ先", "連絡先"],
};

const NAMES: [ItemKey, string[]][] = ITEM_KEYS.map((key) => [key, [ITEM_LABEL[key], ITEM_SCREEN_LABEL[key], ...(OTHER_NAMES[key] ?? [])]]);

/** 質問がどの項目についてか。項目でない（表、やること、対象なし）ときは null。 */
export function questionItemKey(target: string | null | undefined): ItemKey | null {
  const raw = (target ?? "").trim();
  if (!raw) return null;
  for (const part of [raw, ...raw.split(/[:：./]/).map((piece) => piece.trim()).filter(Boolean)]) {
    if (isItemKey(part)) return part;
    const named = NAMES.find(([, names]) => names.includes(part));
    if (named) return named[0];
  }
  return null;
}
