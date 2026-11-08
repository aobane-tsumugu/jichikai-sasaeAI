import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { plainProjectTitle } from "../src/project/heading";
import { get, realApp } from "./helpers";

it("届いた文書の件名から、準備の名前に要らない終わりの言葉を外す", () => {
  expect(plainProjectTitle("防災訓練の参加予定人数のご報告について（お願い）")).toBe("防災訓練の参加予定人数のご報告");
  expect(plainProjectTitle("敬老会の開催について")).toBe("敬老会の開催");
  expect(plainProjectTitle("秋の収穫祭のご案内")).toBe("秋の収穫祭");
  expect(plainProjectTitle("秋の収穫祭")).toBe("秋の収穫祭");
  expect(plainProjectTitle("（お願い）")).toBe("（お願い）");
});

it("市からの依頼の件名で始めた準備でも、案内の題を「…（お願い）のご案内」にしない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "防災訓練の参加予定人数のご報告について（お願い）", year: 2026, accountId: account.accountId });
  const page = await (await get(realApp, `/${ward.slug}/admin/projects/${project.projectId}/draft/announcement?edit=1`, cookie)).text();
  expect(page).toContain('value="防災訓練の参加予定人数のご報告のご案内"');
  expect(page).not.toContain("（お願い）のご案内");
});
