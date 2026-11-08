import { expect, it } from "vitest";
import { needsYearQuestion } from "../src/line/clarifications";
import type { Reading } from "../src/ai/schema";

const base = (extra: Partial<Reading> = {}): Reading => ({
  document_kind: "other", summary: "試しの写真", original_years: [{ original_id: "o1", year: null }],
  text_blocks: [{ original_id: "o1", locator: "全体", text: "本日限り 卵 1パック 98円" }], fields: [], tables: [], decisions: [], unreadable: [],
  project_suggestions: [], ward_facts: [], year_entries: [], ...extra,
} as Reading);

it("準備に入っていない、自治会と関係の無い写真（特売のチラシなど）には、年を聞き返さない", () => {
  expect(needsYearQuestion(base(), "o1", false)).toBe(false);
});

it("読み取りが準備の候補、基本情報、一年の予定に出した写真には、年が書いていなければ聞き返す", () => {
  expect(needsYearQuestion(base({ project_suggestions: [{ original_id: "o1", title: "秋の収穫祭", year_item: "", date_text: "", place: "" }] }), "o1", false)).toBe(true);
  expect(needsYearQuestion(base({ ward_facts: [{ original_id: "o1", topic: "dues", text: "会費は年 3,000 円" }] } as Partial<Reading>), "o1", false)).toBe(true);
  expect(needsYearQuestion(base({ year_entries: [{ original_id: "o1", title: "防災訓練", month: 9, date_text: "9月" }] }), "o1", false)).toBe(true);
});

it("準備に入った写真は、今までどおり年が書いていなければ聞き返し、年が分かれば聞かない", () => {
  expect(needsYearQuestion(base(), "o1", true)).toBe(true);
  expect(needsYearQuestion(base({ original_years: [{ original_id: "o1", year: 2025 }] }), "o1", true)).toBe(false);
  expect(needsYearQuestion(base({ text_blocks: [{ original_id: "o1", locator: "全体", text: "令和7年の秋の収穫祭" }] }), "o1", true)).toBe(false);
});
