import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { checkPublicDraft } from "../src/check";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";

it("連絡先の欄に入れた番号には個人の連絡先の警告を出さず、本文に出た番号には出す", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2030, accountId: account.accountId });
  const inField = await checkPublicDraft(env.DB, ward.wardId, project.projectId, "announcement",
    { text: "秋の収穫祭を行います。", items: [{ key: "public_contact", content: "書記 090-0000-0002" }] });
  expect(inField.filter((warning) => warning.startsWith("個人の連絡先"))).toEqual([]);
  const inText = await checkPublicDraft(env.DB, ward.wardId, project.projectId, "announcement",
    { text: "分からないときは 090-0000-0002 へ。", items: [{ key: "public_contact", content: "書記" }] });
  expect(inText).toContain("個人の連絡先: 090-0000-0002");
});
