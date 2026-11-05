import { describe, expect, it } from "vitest";
import { questionTerms } from "../src/archive/search";

describe("問いの文から探す言葉", () => {
  it("かなと記号で切り、二文字以上を残す", () => {
    expect(questionTerms("去年の会計はいくらでしたか。")).toEqual(["去年", "会計"]);
    expect(questionTerms("テントは何張り借りた？")).toEqual(["テント"]);
  });
  it("言葉が無ければ空", () => {
    expect(questionTerms("どうでしたか")).toEqual([]);
  });
});
