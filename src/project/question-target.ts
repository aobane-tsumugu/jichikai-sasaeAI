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

/**
 * 対象が空の「決めてほしい」質問が、どの項目を聞いているかを文から見分ける。一つの項目だけをはっきり聞いている時だけ返す。
 * AI は質問の対象を書かないことがあり（三回目の通しの練習で、日を決めて知らせても「何月何日の何時から…」が閉じなかった）、
 * 役員が下書きの欄で決めた項目の質問を閉じるのに使う。二つ以上の項目を聞く文、どれにも当たらない文は null。
 */
// 場所や雨は「会場を押さえる（来年向け）」のような仕事の質問にも出て取り違えるので、文からは見分けない（対象が書いてある時だけ）。
// 日時と締切は、日や時刻を聞く言い方がはっきりしている物だけを見る。
const TEXT_SIGNS: [ItemKey, RegExp][] = [
  ["due", /締切|しめきり|いつまでに/],
  // 場所は、場所を聞く言い方だけを見る（「会場を押さえる」のような仕事の名前は場所の質問ではない）。
  ["place", /どこで|どこに|どこですか|場所は|会場は/],
  ["date_time", /何月何日|何時から何時|日時は|日時を|日にちは|開催日は/],
];

export function questionItemKeyFromText(text: string | null | undefined): ItemKey | null {
  const value = (text ?? "").normalize("NFKC");
  // 問いの形の文だけを見る。「会場を押さえる（来年向け）」のような仕事の名前は、場所を聞く質問ではない。
  if (!/[?？]|か[。.]?\s*$|か。|ますか|ですか|教えて|ください/.test(value)) return null;
  // 「いつまでに」は締切なので、日時の手がかりの「いつ」とは別に見る。
  const matched = TEXT_SIGNS.filter(([key, sign]) => sign.test(key === "date_time" ? value.replace(/いつまでに/g, "") : value)).map(([key]) => key);
  return matched.length === 1 ? matched[0]! : null;
}
