// 試験用の区、行事、人名、文、鍵はすべて架空です。
import type { Scenes } from "../../scripts/line-sim";

export const LOCAL_FLOW: Scenes = {
  fictional: true,
  notice: "この試験の区、行事、人名、会話はすべて架空です。",
  projectTitle: "架空の秋の収穫祭",
  roster: [
    { household: "架空参加一郎", district: "1班" },
    { household: "架空同名一郎", district: "1班" },
    { household: "架空同名一郎", district: "2班" },
    { household: "架空欠席一郎", district: "1班" },
  ],
  scenes: [
    { id: "inquiry", category: "公式への質問", talk: "group", group: true,
      messages: [{ text: "公式へ。架空の秋の収穫祭は何時からですか。", expected: { kind: "問い合わせ" } }] },
    { id: "work", category: "作業の連絡", talk: "group", group: true,
      messages: [
        { text: "架空の秋の収穫祭の設営は3人で進めます。", expected: { kind: "資料に入る" } },
        { text: "架空の秋の収穫祭の机を12台手配しました。", expected: { kind: "資料に入る" } },
      ] },
    { id: "attend", category: "出欠の答え", talk: "attend", group: false,
      messages: [{ text: "架空参加一郎です。1班です。架空の秋の収穫祭に大人2人で参加します。", expected: { kind: "答えに数える", household: "架空参加一郎", district: "1班", people: 2 } }] },
    { id: "same-known", category: "同名の世帯", talk: "known", group: true,
      messages: [{ text: "架空同名一郎です。2班です。架空の秋の収穫祭に3人で行きます。", expected: { kind: "答えに数える", household: "架空同名一郎", district: "2班", people: 3 } }] },
    { id: "same-unknown", category: "同名の世帯", talk: "unknown", group: false,
      messages: [{ text: "架空同名一郎です。架空の秋の収穫祭に1人で行きます。", expected: { kind: "答えに数える", household: "架空同名一郎", district: "", people: 1 } }] },
    { id: "decline", category: "不参加", talk: "decline", group: false,
      messages: [{ text: "架空欠席一郎です。1班です。架空の秋の収穫祭に参加しません。", expected: { kind: "答えに数える", household: "架空欠席一郎", district: "1班", people: 0 } }] },
    { id: "chat", category: "雑談", talk: "group", group: true,
      messages: [{ text: "おはようございます。", expected: { kind: "残さない" } }] },
  ],
};
