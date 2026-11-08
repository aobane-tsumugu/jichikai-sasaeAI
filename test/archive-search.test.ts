import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { findFragments, questionTerms } from "../src/archive/search";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";

describe("質問の文から探す言葉", () => {
  it("かなと記号で切り、二文字以上を残す", () => {
    expect(questionTerms("去年の会計はいくらでしたか。")).toEqual(["去年", "会計"]);
    expect(questionTerms("テントは借りた？")).toEqual(["テント"]);
  });
  it("言葉がなければ空", () => {
    expect(questionTerms("どうでしたか")).toEqual([]);
  });
});

it("記録に聞く抜粋は英字の大小によらず答えの箇所を含み、別の自治会の記録を混ぜない", async () => {
  const local = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const padding = "去年の準備の経過を確認しました。\n".repeat(80);
  const records = [
    { owner: local, title: "架空の長い議事録", content: padding + "テント代は8,000円でした。LINEで連絡しました。" + padding },
    { owner: local, title: "架空の冒頭に答えがある記録", content: "テント代は3,000円でした。lineで連絡しました。" + padding },
    { owner: other, title: "架空の別の自治会の記録", content: padding + "テント代は99,000円でした。Lineで連絡しました。" },
  ];
  for (const { owner, title, content } of records) {
    const project = await createProject(env.DB, owner.ward.wardId, {
      kind: "event", title, year: 2026, accountId: owner.account.accountId,
    });
    await env.DB.prepare(`INSERT INTO archive_search_entries
      (ward_id, project_id, record_type, year, locator, content, created_at)
      VALUES (?, ?, 'decision', 2026, '費用の記録', ?, '2026-11-06T00:00:00Z')`)
      .bind(owner.ward.wardId, project.projectId, content).run();
  }
  for (const question of ["テントはいくらでしたか？", "費用はいくら？テントは？", "去年のテントはいくらでしたか？", "LINEは？", "lineは？", "LiNeは？"]) {
    const fragments = await findFragments(env.DB, local.ward.wardId, question, 8);
    expect(fragments).toHaveLength(2);
    expect(fragments.find(fragment => fragment.title === records[0]!.title)?.excerpt).toContain("テント代は8,000円でした。");
    expect(fragments.find(fragment => fragment.title === records[1]!.title)?.excerpt).toMatch(/^テント代は3,000円でした。/);
    expect(fragments.find(fragment => fragment.title === records[0]!.title)?.excerpt).toContain("LINEで連絡しました。");
    expect(fragments.find(fragment => fragment.title === records[1]!.title)?.excerpt).toContain("lineで連絡しました。");
    for (const fragment of fragments) expect(fragment.excerpt.length).toBeLessThanOrEqual(600);
  }
});
