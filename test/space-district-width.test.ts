import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { addAnswer, replaceRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { createInvite, getSpaceMaterials } from "../src/space/api";
import { cookieFrom, get, postForm, realApp } from "./helpers";

it("行事の班長に全角半角の違う同じ班の返事を出し、別の班や準備の返事は出さない", async () => {
  // 名前、班、紙の番号、合言葉はすべて試験用の試しのもの。
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "試しの行事", year: 2026, accountId: account.accountId,
  });
  const answers = [
    { household: "試しのA世帯", district: "1班" },
    { household: "試しのB世帯", district: "１班" },
    { household: "試しの別の班の世帯", district: "2班" },
    { household: "試しの班が不明な世帯", district: "" },
  ];
  await replaceRoster(env.DB, ward.wardId, answers.slice(0, 2).map((row) => ({ ...row, district: "１班" })), { household: 0, district: 1 });
  for (const [index, answer] of answers.entries()) await addAnswer(env.DB, ward.wardId, {
    ...answer, projectId: project.projectId, peopleCount: 2, source: "sheet", originalId: "fictional-space-sheet", sheetRowIndex: index,
  });
  const other = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "別の試しの行事", year: 2026, accountId: account.accountId,
  });
  const otherName = "試しの別の準備の世帯";
  await addAnswer(env.DB, ward.wardId, { projectId: other.projectId, household: otherName, district: "1班", peopleCount: 3, source: "phone" });
  const leaderData = await getSpaceMaterials(env.DB, ward.wardId, project.projectId, "１班");
  expect(leaderData.attendance.map((answer) => answer.household)).toEqual(answers.slice(0, 2).map((answer) => answer.household));
  expect(leaderData.attendance.map((answer) => answer.district)).toEqual(["1班", "１班"]);

  const space = `/${ward.slug}/space/${project.projectId}`;
  const passphrase = "試しの班の確認用合言葉";
  expect((await postForm(realApp, `/${ward.slug}/admin/space/${project.projectId}/open`, { passphrase }, cookie)).status).toBe(200);
  const token = await createInvite(env.DB, ward.wardId, project.projectId, "leader", "１班", account.accountId, true);
  const entrance = await get(realApp, `${space}/person/${token}`);
  const leaderCookie = cookieFrom(entrance, `space_${project.projectId}`);
  if (!leaderCookie) throw new Error("試しの班長の入口にログインできません");
  const page = await get(realApp, space, leaderCookie);
  expect(page.status).toBe(200);
  const html = await page.text();
  for (const answer of answers.slice(0, 2)) expect(html).toContain(answer.household);
  for (const name of [answers[2]!.household, answers[3]!.household, otherName]) expect(html).not.toContain(name);
  expect(html).toContain("１班の班長さんへ");

  const entered = await postForm(realApp, `${space}/enter`, { passphrase });
  expect(entered.status).toBe(303);
  const memberCookie = cookieFrom(entered, `space_${project.projectId}`);
  if (!memberCookie) throw new Error("試しの実行委員がログインできません");
  const member = await (await get(realApp, space, memberCookie)).text();
  for (const answer of answers) expect(member).toContain(answer.household);
  expect(member).not.toContain(otherName);
});
