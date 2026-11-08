import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { applyChange, createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("終わったものの画面は、動きを日付の順に並べ、決めたことを札でなく文で出す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, eventDay: "2026-10-25", accountId: account.accountId });
  for (const data of [
    { what: "当日の受付はだれに頼みましたか。 → 3班の班長に頼みました。", decidedOn: "2026-11-08" },
    { what: "予算は去年と同じ 8万円", decidedOn: "2026年4月 役員会" },
  ]) {
    await applyChange(env.DB, ward.wardId, project.projectId, { kind: "row", table: "decisions", data, source: { kind: "person", accountId: account.accountId }, confidence: "high", packVersion: "test@1" });
  }
  expect((await postForm(realApp, `${root}/close/${project.projectId}/finalize`, {}, cookie)).status).toBe(303);
  const page = await (await get(realApp, `${root}/archive/${project.projectId}`, cookie)).text();
  const moves = page.slice(page.indexOf("年の動き</h2>"), page.indexOf("</ul>", page.indexOf("年の動き</h2>")));
  const months = [...moves.matchAll(/<b>(\d{1,2})月/g)].map((match) => Number(match[1]));
  expect(months.length).toBeGreaterThan(2);
  expect(months).toEqual([...months].sort((a, b) => a - b));
  const decisions = page.match(/<section><h2>決めたこと<\/h2>[\s\S]*?<\/section>/)?.[0] ?? "";
  expect(decisions).toContain("当日の受付はだれに頼みましたか。");
  expect(decisions).toContain("答え: 3班の班長に頼みました。");
  expect(decisions).toContain("11月8日（日）に決めました");
  expect(decisions).toContain("決めたとき: 2026年4月 役員会");
  expect(decisions).not.toContain("何を:");
});
