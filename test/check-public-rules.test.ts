import { expect, it } from "vitest";
import { Inspector } from "../scripts/check-public.ts";

it("環境参照、コードの式、架空のメールを資格情報と取り違えない", () => {
  const check = new Inspector({}, []);
  check.inspect([
    'const accessToken = process.env.LINE_TOKEN;',
    'accessToken: String(form.get("accessToken")),',
    'const password = generateFixturePassword();',
    'apiKey: "fixture-only-placeholder",',
    '特典コード: ${benefit}',
    'fictional@example.invalid sample@example.com',
  ].join("\n"), { source: "tree", path: "fixture.ts" });
  expect(check.findings).toEqual([]);
});

it("架空の資格情報の形と照合語を見つけ、値と照合語を含むパスを出さない", () => {
  const term = "架空の所属の照合語";
  const check = new Inspector({ affiliation: [term] }, []);
  const key = "gh" + "p_" + "A".repeat(36);
  check.inspect(`API_TOKEN="${key}"\n${term}`, { source: "tree", path: `records/${term}.txt` });
  expect(check.findings.some((finding) => finding.kind === "credential")).toBe(true);
  expect(check.findings.some((finding) => finding.kind === "affiliation")).toBe(true);
  const output = JSON.stringify(check.findings);
  expect(output.includes(key)).toBe(false);
  expect(output.includes(term)).toBe(false);
  expect(check.findings.every((finding) => finding.path?.startsWith("[path:"))).toBe(true);
});
