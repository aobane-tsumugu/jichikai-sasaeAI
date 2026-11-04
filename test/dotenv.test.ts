import { describe, expect, it } from "vitest";
import { formatDotenv, parseDotenv, splitEmpty } from "../scripts/lib/dotenv.ts";

describe("鍵のファイルの読み書き（scripts/lib/dotenv.ts）", () => {
  it("名前=値 の行を読み、注釈と空行を飛ばす", () => {
    const { entries, badLines } = parseDotenv("# 注釈\n\nA_KEY=abc123\nB_KEY = def # 後ろの注釈\nexport C_KEY=ghi\n");
    expect(badLines).toEqual([]);
    expect(entries).toEqual([
      { name: "A_KEY", value: "abc123" },
      { name: "B_KEY", value: "def" },
      { name: "C_KEY", value: "ghi" },
    ]);
  });

  it("BOM と CRLF があっても読める（Windows で書いたファイル）", () => {
    const { entries } = parseDotenv("\uFEFFA_KEY=1\r\nB_KEY=2\r\n");
    expect(entries.map((e) => e.name)).toEqual(["A_KEY", "B_KEY"]);
    expect(entries.map((e) => e.value)).toEqual(["1", "2"]);
  });

  it("値に = や # を含められ、引用符の中は注釈にならない", () => {
    const { entries } = parseDotenv('A_KEY=abc==\nB_KEY="x # y"\nC_KEY=\'a"b\'\n');
    expect(entries).toEqual([
      { name: "A_KEY", value: "abc==" },
      { name: "B_KEY", value: "x # y" },
      { name: "C_KEY", value: 'a"b' },
    ]);
  });

  it("複数行の値（署名鍵）を引用符で囲んで書ける", () => {
    const pem = "-----BEGIN FAKE KEY-----\nAAAA\nBBBB\n-----END FAKE KEY-----";
    const parsed = parseDotenv(`A_KEY="${pem}"\nB_KEY=2\n`);
    expect(parsed.badLines).toEqual([]);
    expect(parsed.entries).toEqual([
      { name: "A_KEY", value: pem },
      { name: "B_KEY", value: "2" },
    ]);
    // \n で一行に書いた形も同じ値になる
    expect(parseDotenv(`A_KEY="${pem.replace(/\n/g, "\\n")}"\n`).entries[0]?.value).toBe(pem);
  });

  it("書き出して読み直すと同じ（特殊な値も）", () => {
    const entries = [
      { name: "PLAIN", value: "abc-123_x.y/z+w=" },
      { name: "SPACED", value: "a b # c" },
      { name: "QUOTED", value: 'a"b\\c' },
      { name: "MULTI", value: "line1\nline2\n" },
      { name: "JP", value: "日本語の値" },
    ];
    const text = formatDotenv(entries);
    expect(text.endsWith("\n")).toBe(true);
    expect(text).not.toContain("\r");
    expect(parseDotenv(text).entries).toEqual(entries);
    // 安全な値は引用符なし
    expect(text.split("\n")[0]).toBe("PLAIN=abc-123_x.y/z+w=");
  });

  it("読めない行は番号だけを返し、行の中身を返さない", () => {
    const secret = "sk-this-must-not-leak";
    const { badLines, entries } = parseDotenv(`A_KEY=1\n${secret}\n1BAD=2\nC_KEY="開いたまま\n`);
    expect(badLines).toEqual([2, 3, 4]);
    expect(JSON.stringify({ badLines })).not.toContain(secret);
    expect(entries.map((e) => e.name)).toEqual(["A_KEY"]);
  });

  it("同じ名前は後の行が勝ち、重複を知らせる", () => {
    const { entries, duplicates } = parseDotenv("A_KEY=1\nB_KEY=2\nA_KEY=3\n");
    expect(entries).toEqual([
      { name: "A_KEY", value: "3" },
      { name: "B_KEY", value: "2" },
    ]);
    expect(duplicates).toEqual(["A_KEY"]);
  });

  it("値が空の行は渡さず、名前だけを知らせる", () => {
    const { entries } = parseDotenv("A_KEY=\nB_KEY=  \nC_KEY=1\nD_KEY=\"\"\n");
    const { filled, emptyNames } = splitEmpty(entries);
    expect(filled).toEqual([{ name: "C_KEY", value: "1" }]);
    expect(emptyNames).toEqual(["A_KEY", "B_KEY", "D_KEY"]);
  });
});
