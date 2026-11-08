// 区、行事、人名、文、鍵は、この試験のために用意したものです。
import type { Scenes } from "../../scripts/line-sim";

export const LOCAL_FLOW: Scenes = {
  sampleData: true,
  provenance: "この試験の区、行事、人名、会話は期間中に作った試しの内容で、実在の資料や住民の情報は使っていません。",
  projectTitle: "試しの秋の収穫祭",
  roster: [
    { household: "参加一郎", district: "1班" },
    { household: "同名一郎", district: "1班" },
    { household: "同名一郎", district: "2班" },
    { household: "欠席一郎", district: "1班" },
  ],
  scenes: [
    { id: "inquiry", category: "公式への質問", talk: "group", group: true,
      messages: [{ text: "公式へ。試しの秋の収穫祭は何時からですか。", expected: { kind: "問い合わせ" } }] },
    { id: "work", category: "作業の連絡", talk: "group", group: true,
      messages: [
        { text: "試しの秋の収穫祭の設営は3人で進めます。", expected: { kind: "資料に入る" } },
        { text: "試しの秋の収穫祭の机を12台手配しました。", expected: { kind: "資料に入る" } },
      ] },
    { id: "attend", category: "出欠の答え", talk: "attend", group: false,
      messages: [{ text: "参加一郎です。1班です。試しの秋の収穫祭に大人2人で参加します。", expected: { kind: "答えに数える", household: "参加一郎", district: "1班", people: 2 } }] },
    { id: "same-known", category: "同名の世帯", talk: "known", group: true,
      messages: [{ text: "同名一郎です。2班です。試しの秋の収穫祭に3人で行きます。", expected: { kind: "答えに数える", household: "同名一郎", district: "2班", people: 3 } }] },
    { id: "same-unknown", category: "同名の世帯", talk: "unknown", group: false,
      messages: [{ text: "同名一郎です。試しの秋の収穫祭に1人で行きます。", expected: { kind: "答えに数える", household: "同名一郎", district: "", people: 1 } }] },
    { id: "decline", category: "不参加", talk: "decline", group: false,
      messages: [{ text: "欠席一郎です。1班です。試しの秋の収穫祭に参加しません。", expected: { kind: "答えに数える", household: "欠席一郎", district: "1班", people: 0 } }] },
    { id: "chat", category: "雑談", talk: "group", group: true,
      messages: [{ text: "おはようございます。", expected: { kind: "残さない" } }] },
  ],
};
