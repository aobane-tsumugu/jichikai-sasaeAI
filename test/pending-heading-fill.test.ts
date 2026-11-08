import { expect, it } from "vitest";
import { reconcileDocumentBody } from "../src/project/document-body";

const DAY = "2026年12月26日（土）から28日（月）まで 毎晩 午後8時から";

it("「■いつ」の下に「日時（確認中）」と書かれた本文に日を入れると、「日時」を残さず日だけにする", () => {
  const previous = { text: "■いつ\n日時（確認中）\n\n■どこで\n集会所の前", items: [{ key: "place" as const, content: "集会所の前" }] };
  const next = { text: previous.text, items: [{ key: "date_time" as const, content: DAY }, { key: "place" as const, content: "集会所の前" }] };
  const result = reconcileDocumentBody(previous, next);
  expect(result.text).toBe(`■いつ\n${DAY}\n\n■どこで\n集会所の前`);
  expect(result.text).not.toContain("日時2026");
});

it("見出しが無く「日時（確認中）」だけの行に日を入れると、項目名と日の間に区切りを入れる", () => {
  const previous = { text: "日時（確認中）\n場所：集会所の前", items: [] };
  const next = { text: previous.text, items: [{ key: "date_time" as const, content: DAY }] };
  expect(reconcileDocumentBody(previous, next).text).toBe(`日時：${DAY}\n場所：集会所の前`);
});

it("見出しの下が「（確認中）」だけのときは、これまでどおり見出しの下に日を入れる", () => {
  const previous = { text: "■いつ\n（確認中）", items: [] };
  const next = { text: previous.text, items: [{ key: "date_time" as const, content: DAY }] };
  expect(reconcileDocumentBody(previous, next).text).toBe(`■いつ\n${DAY}`);
});

it("見出しが「■いつ行いますか」「■どこに集まりますか」のような問いの形でも、下の（確認中）に日と場所を入れる（三回目の通し A-3）", () => {
  const previous = { text: "■いつ行いますか\n（確認中）\n\n■どこに集まりますか\n（確認中）\n\n■どんな行事ですか\n町内を回ります。", items: [] };
  const next = { text: previous.text, items: [{ key: "date_time" as const, content: DAY }, { key: "place" as const, content: "集会所の前" }] };
  const result = reconcileDocumentBody(previous, next);
  expect(result.text).toBe(`■いつ行いますか\n${DAY}\n\n■どこに集まりますか\n集会所の前\n\n■どんな行事ですか\n町内を回ります。`);
  expect(result.text).not.toContain("（確認中）");
});
