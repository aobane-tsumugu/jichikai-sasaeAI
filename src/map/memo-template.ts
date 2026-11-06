import type { ProjectKind } from "../project/model";

export interface MemoTemplate { key: string; name: string; hint: string; }

const VENUE: MemoTemplate = { key: "venue", name: "会場", hint: "借りたところ、予約した時期など" };
const PRINT: MemoTemplate = { key: "printing", name: "印刷と配布", hint: "頼んだ先、紙の量など" };

/** 一般の項目を見せるための型。金額や頼み先を補うものではない。 */
export const MEMO_TEMPLATES: Record<ProjectKind, readonly MemoTemplate[]> = {
  event: [
    VENUE,
    { key: "sound", name: "音響", hint: "マイクの数、頼んだ先など" },
    { key: "security", name: "警備", hint: "人数、時間、交通整理、頼んだ先など" },
    { key: "equipment", name: "テントと机", hint: "借りたところ、返す日など" },
    { key: "materials", name: "食材と消耗品", hint: "買ったもの、量、頼んだ先など" },
    { key: "insurance", name: "保険", hint: "行事の保険に入るかなど" },
    { key: "permission", name: "届け出と許可", hint: "道路、食べ物、火の使用など" },
    { key: "waste", name: "ごみの片付け", hint: "分別、回収の頼み先など" },
    { key: "borrowed", name: "借りたもの", hint: "貸してくれたところ、返す日など" },
    { key: "thanks", name: "お礼と交通費", hint: "額の目安、渡した相手など" },
    { key: "parking", name: "駐車場", hint: "借りたところ、誘導など" },
  ],
  general_meeting: [VENUE, PRINT, { key: "equipment", name: "借りたもの", hint: "机、マイク、返す日など" }],
  board_meeting: [VENUE, PRINT],
  city_request: [PRINT, { key: "delivery", name: "郵送と持参", hint: "送ったもの、届けた先など" }],
  duty: [{ key: "equipment", name: "使ったもの", hint: "道具、消耗品、借りたところなど" }, { key: "thanks", name: "交通費", hint: "移動にかかった額など" }],
  request: [PRINT, { key: "delivery", name: "郵送と持参", hint: "送ったもの、届けた先など" }],
};
