import { describe, expect, it } from "vitest";
import {
  cleanName,
  generateDeviceToken,
  generatePassword,
  generateSalt,
  hashPassword,
  nameKey,
  normalizePassword,
  safeEqual,
  verifyPassword,
} from "../src/core/password";
import { slugProblem } from "../src/core/ward";

describe("パスワード", () => {
  it("読み間違えやすい文字を含まない 4 組 6 文字の乱数", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 200; i++) {
      const p = generatePassword();
      expect(p).toMatch(/^[a-hjkmnp-z2-9]{6}(-[a-hjkmnp-z2-9]{6}){3}$/);
      seen.add(p);
    }
    expect(seen.size).toBe(200);
  });

  it("全部の文字が出る（偏りの粗い確認）", () => {
    const chars = new Set<string>();
    for (let i = 0; i < 400; i++) for (const ch of generatePassword().replace(/-/g, "")) chars.add(ch);
    expect(chars.size).toBe(31);
  });

  it("要約で照合でき、違う物や違う塩では一致しない", async () => {
    const salt = generateSalt();
    const hash = await hashPassword("abcdef-ghjkmn-pqrstu-vwxyz2", salt);
    expect(await verifyPassword("abcdef-ghjkmn-pqrstu-vwxyz2", salt, hash)).toBe(true);
    expect(await verifyPassword("abcdef-ghjkmn-pqrstu-vwxyz3", salt, hash)).toBe(false);
    expect(await verifyPassword("abcdef-ghjkmn-pqrstu-vwxyz2", generateSalt(), hash)).toBe(false);
    expect(hash).not.toContain("abcdef");
  });

  it("打ち間違いに寛容: 大文字、全角、ハイフン、空白は同じ", () => {
    expect(normalizePassword("ABCDEF-GHJKMN")).toBe("abcdefghjkmn");
    expect(normalizePassword("ａｂｃｄｅｆ－ｇｈｊｋｍｎ")).toBe("abcdefghjkmn");
    expect(normalizePassword(" abcdef ghjkmn ")).toBe("abcdefghjkmn");
  });

  it("長さの違う文字列は一致しない", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("abc", "abd")).toBe(false);
  });

  it("端末の札は長い乱数で、毎回違う", () => {
    const a = generateDeviceToken();
    expect(a.length).toBeGreaterThanOrEqual(43);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(generateDeviceToken()).not.toBe(a);
  });
});

describe("名前", () => {
  it("表示用は空白を整え、照合用は空白と大文字小文字を無くす", () => {
    expect(cleanName("  山田　　太郎 ")).toBe("山田 太郎");
    expect(nameKey("山田 太郎")).toBe(nameKey("山田太郎"));
    expect(nameKey("ＡＢＣ")).toBe("abc");
  });
});

describe("区のスラッグ", () => {
  it("使える形と使えない形", () => {
    expect(slugProblem("aozora-ku")).toBeNull();
    expect(slugProblem("ward01")).toBeNull();
    expect(slugProblem("a")).not.toBeNull();
    expect(slugProblem("Aozora")).not.toBeNull();
    expect(slugProblem("-aozora")).not.toBeNull();
    expect(slugProblem("aozora-")).not.toBeNull();
    expect(slugProblem("a_b")).not.toBeNull();
    expect(slugProblem("区")).not.toBeNull();
    expect(slugProblem("a".repeat(41))).not.toBeNull();
  });

  it("先頭の経路と重なる語は使えない", () => {
    for (const word of ["ops", "hooks", "healthz", "admin", "mcp", "line"]) {
      expect(slugProblem(word), word).not.toBeNull();
    }
  });
});
