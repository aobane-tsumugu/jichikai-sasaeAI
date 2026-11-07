import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { addAnswer, listAnswers, listUnansweredByDistrict, replaceRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("別の班の同名世帯はそれぞれ答えを照合し、全員答え後も名簿にある班を表示する", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の行事", year: 2026, accountId: account.accountId,
  });
  await replaceRoster(env.DB, ward.wardId, [
    { household: "架空の同名世帯", district: "1班" },
    { household: "架空の同名世帯", district: "2班" },
  ], { household: 0, district: 1 });
  const path = `/${ward.slug}/answer/${project.projectId}`;
  expect((await postForm(realApp, path, { household: "架空の同名世帯", district: "1班", people_count: "2" })).status).toBe(200);
  expect(await listUnansweredByDistrict(env.DB, ward.wardId, project.projectId)).toEqual([
    { district: "1班", households: [] },
    { district: "2班", households: ["架空の同名世帯"] },
  ]);
  expect((await postForm(realApp, path, { household: "架空の同名世帯", district: "2班", people_count: "3" })).status).toBe(200);
  const page = await (await get(realApp, `/${ward.slug}/admin/answers/${project.projectId}?view=unanswered`, cookie)).text();
  expect(page).not.toContain("名簿はまだありません。");
  expect(page.match(/まだ返事のない世帯はありません。/g)).toHaveLength(2);
});

it.each(["event", "general_meeting"] as const)("%s: 同じ班の同名2世帯を答え1件で両方消さず、班が不明な答えで推定しない", async (kind) => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind, title: "架空の同名世帯の確認会", year: 2026, accountId: account.accountId,
  });
  const household = "架空の同名代表者";
  await replaceRoster(env.DB, ward.wardId, [
    { household, district: "1班" }, { household, district: "1班" },
  ], { household: 0, district: 1 });
  const path = `/${ward.slug}/answer/${project.projectId}`;
  const admin = `/${ward.slug}/admin/answers/${project.projectId}?view=unanswered`;
  const answer = async (district: string) => {
    const counts: Record<string, string> = kind === "general_meeting" ? { meeting_status: "attend", proxy_name: "" } : { people_count: "2" };
    expect((await postForm(realApp, path, { household, district, submission_id: crypto.randomUUID(), ...counts })).status).toBe(200);
  };
  const remaining = async (count: number) => {
    expect(await listUnansweredByDistrict(env.DB, ward.wardId, project.projectId)).toEqual([
      { district: "1班", households: Array.from({ length: count }, () => household) },
    ]);
    const expected = kind === "general_meeting" && count === 0 ? "まだ返事のない世帯はありません。" : `1班（${count}世帯）`;
    expect(await (await get(realApp, admin, cookie)).text()).toContain(expected);
    if (count === 1) expect(await (await get(realApp, `${admin}&print=1`, cookie)).text()).toContain(expected);
  };
  await answer("");
  await remaining(2);
  await answer("1班");
  await remaining(1);
  await answer("1班");
  await remaining(0);
});

it.each(["event", "general_meeting"] as const)("%s: 紙の答えと名簿の班が全角半角でも、一世帯ずつ照合する", async (kind) => {
  // 班名と代表者名、紙の識別子は試験用の架空のもの。
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind, title: "架空の班の照合", year: 2026, accountId: account.accountId,
  });
  const household = "架空の同名代表者";
  await replaceRoster(env.DB, ward.wardId, [
    { household, district: "１班" }, { household, district: "１班" }, { household, district: "２班" },
  ], { household: 0, district: 1 });
  const path = `/${ward.slug}/admin/answers/${project.projectId}?view=unanswered`;
  for (const index of [0, 1]) {
    await addAnswer(env.DB, ward.wardId, {
      projectId: project.projectId, household, district: "1班", peopleCount: 2, source: "sheet",
      originalId: "fictional-district-width-sheet", sheetRowIndex: index,
      ...(kind === "general_meeting" ? { meetingStatus: "attend" as const, proxyName: "" } : {}),
    });
    expect(await listUnansweredByDistrict(env.DB, ward.wardId, project.projectId)).toEqual([
      { district: "１班", households: index === 0 ? [household] : [] },
      { district: "２班", households: [household] },
    ]);
    // 元の班名を画面と紙に保ち、別の班の同名世帯は残す。
    for (const suffix of ["", "&print=1"]) {
      const html = await (await get(realApp, `${path}${suffix}`, cookie)).text();
      if (index === 0) expect(html).toContain("１班（1世帯）");
      expect(html).toContain("２班（1世帯）");
    }
  }
  expect((await listAnswers(env.DB, ward.wardId, project.projectId)).map((answer) => answer.district)).toEqual(["1班", "1班"]);
});
