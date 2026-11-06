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
