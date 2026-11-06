import { FIRST_SLICE } from "../../fixtures/first-slice";

// U47の通しだけに使う架空の当番、世帯、免除の理由。実在の資料ではない。
export const ROTA_FIXTURE = {
  title: "集積所の当番（架空）",
  reason: "家族の介護のため（架空の理由）",
  oldRoster: [FIRST_SLICE.firstHousehold, FIRST_SLICE.secondHousehold, FIRST_SLICE.phoneHousehold]
    .map((household) => ({ household, district: FIRST_SLICE.district })),
  newRoster: [FIRST_SLICE.firstHousehold, FIRST_SLICE.secondHousehold, FIRST_SLICE.rosterName]
    .map((household) => ({ household, district: FIRST_SLICE.district })),
  slots: ["第1週", "第2週", "第3週"],
} as const;

// U53の点検用。名前、班、当番、連絡先は全て架空。
export const ROTA_REVIEW_FIXTURE = {
  title: "清掃の当番（架空）",
  first: "山田 太郎",
  exempt: "佐藤 花子",
  removed: "鈴木 一郎",
  fourth: "高橋 春子",
  district: "1班",
  otherDistrict: "2班",
  groups: ["1班", "環境部", "各班2名"],
  slots: ["午前", "昼", "午後", "夕方"],
  task: "清掃",
  committeeRole: "実行委員長",
  contact: "役員へ（架空）",
} as const;

// U54用の架空の資料。名前と理由は実在の資料に由来しない。
export const MATERIAL_EXEMPTION_FIXTURE = {
  filename: "当番の引き継ぎメモ（架空）.txt",
  sentence: `${ROTA_REVIEW_FIXTURE.district} ${ROTA_REVIEW_FIXTURE.exempt}さんは高齢のため当番を免除。`,
  editedReason: "高齢のため今年の当番を免除（架空の役員が直した理由）",
  text: `これは試験用の架空の資料です。\n${ROTA_REVIEW_FIXTURE.district} ${ROTA_REVIEW_FIXTURE.exempt}さんは高齢のため当番を免除。`,
} as const;
