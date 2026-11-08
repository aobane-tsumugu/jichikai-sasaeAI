import { expect, it } from "vitest";
import { comparisonText, pairCaptions, type ComparedOriginal, type ComparedPair } from "../src/ai/compare-originals";

const original = (id: string, extra: Partial<ComparedOriginal>): ComparedOriginal => ({ original_id: id, job_id: `job-${id}`, document_date: null, document_date_source: null,
  received_at: "2026-11-07T22:00:10Z", via: "admin", filename: `${id}.jpg`, ...extra });
const pair = (a: ComparedOriginal, b: ComparedOriginal): ComparedPair => ({ key: "k", originals: [a, b], result: { descriptions: ["メモ", "メモ"],
  differences: ["秋の収穫祭の日が違います"], clues: ["手がかりはありません"], newer: null, assessment: "中身からは、どちらが新しいか分かりません。" } });

it("資料の日付が無い二つは、届いた日と送り方で呼び分け、ファイル名で呼ばない", () => {
  const captions = pairCaptions(pair(original("a", { via: "line_group" }), original("b", { via: "line_direct", received_at: "2026-11-07T22:05:00Z" })));
  expect(captions).toEqual(["11月8日に役員のLINEグループから届いたメモ", "11月8日に個別のLINEから届いたメモ"]);
  const text = comparisonText(pair(original("a", { via: "line_group" }), original("b", { via: "line_direct" })));
  expect(text).not.toContain("a.jpg");
  expect(text).not.toContain("日付の分からない");
});

it("同じ日に同じ送り方で届いた二つは時刻で、同じ時刻なら届いた順で分け、それでも分からない時だけファイル名を使う", () => {
  expect(pairCaptions(pair(original("a", {}), original("b", { received_at: "2026-11-07T23:30:00Z" }))))
    .toEqual(["11月8日 07:00に役員の画面から届いたメモ", "11月8日 08:30に役員の画面から届いたメモ"]);
  expect(pairCaptions(pair(original("a", {}), original("b", { received_at: "2026-11-07T22:00:40Z" }))))
    .toEqual(["11月8日 07:00に役員の画面から届いたメモのうち先に届いた方", "11月8日 07:00に役員の画面から届いたメモのうちあとに届いた方"]);
  expect(pairCaptions(pair(original("a", {}), original("b", {})))).toEqual(["11月8日 07:00に役員の画面から届いたメモ（a.jpg）", "11月8日 07:00に役員の画面から届いたメモ（b.jpg）"]);
});

it("資料に日付があれば、その日で呼ぶ", () => {
  const captions = pairCaptions(pair(original("a", { document_date: "2026-04-12T09:00:00Z", document_date_source: "exif_original" }), original("b", { via: "line_direct" })));
  expect(captions).toEqual(["4月12日に撮ったメモ", "11月8日に個別のLINEから届いたメモ"]);
});

it("比べた結果の文は「。」を重ねず、同じ時刻に同じ所から届いた二つには届き方を書かない", () => {
  const dated = (id: string, date: string) => original(id, { document_date: date, document_date_source: "office_modified" });
  const text = comparisonText(pair(dated("a", "2025-09-12T10:00:00Z"), dated("b", "2025-09-20T10:00:00Z")));
  expect(text).not.toContain("。。");
  expect(text).not.toContain("から届きました");
  const apart = comparisonText(pair(dated("a", "2025-09-12T10:00:00Z"), original("b", { ...dated("b", "2025-09-20T10:00:00Z"), via: "line_group" })));
  expect(apart).toContain("9月12日に保存したメモは、11月8日 07:00に役員の画面から届きました。");
});

it("比べの AI が違いや手がかりを多く返しても、役員が読む問いの文には違い三つ、手がかり二つまでしか出さない", () => {
  const base = pair(original("a", { via: "line_group" }), original("b", { via: "line_direct" }));
  const many: ComparedPair = { ...base, result: { ...base.result,
    differences: ["収穫祭の日が10月18日と10月25日で違います", "集合の時刻が違います", "片付けの担当が違います", "行頭の記号が違います", "空白の入れ方が違います"],
    clues: ["10月25日の方に「変更」とあります", "役員会のメモと合います", "保存の順では判断しません"] } };
  const text = comparisonText(many);
  expect(text).toContain("片付けの担当が違います。");
  expect(text).not.toContain("行頭の記号");
  expect(text).not.toContain("空白の入れ方");
  expect(text).toContain("役員会のメモと合います。");
  expect(text).not.toContain("保存の順では判断しません");
});
