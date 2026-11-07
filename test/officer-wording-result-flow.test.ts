import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { listAnswers } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("電話の返事を入れ間違えた役員が、案内を読んで戻り、直して一覧に残せる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
  });
  const path = `/${ward.slug}/admin/answers/${project.projectId}`;
  const failed = await postForm(realApp, `${path}/phone`, { household: "", people_count: "2" }, cookie);
  expect(failed.status).toBe(400);
  expect(failed.headers.get("content-type")).toContain("text/html");
  const guidance = await failed.text();
  expect(guidance).toContain(`${ward.name} 役員の画面`);
  expect(guidance).toContain("世帯の代表者のお名前が入っていません。");
  // 入れ間違いは別の画面へ移らず、入れた内容を残した同じ入力の画面で直す。
  expect(guidance).toContain("入れた内容は残っています。");
  expect(guidance).toContain("世帯の代表者（ふつうは世帯主）のお名前");

  const entry = await (await get(realApp, `${path}?view=hand`, cookie)).text();
  expect(entry).toContain("電話や紙の返事を手で入れる");
  expect(entry).toContain("世帯の代表者（ふつうは世帯主）のお名前");
  const saved = await postForm(realApp, `${path}/phone`, {
    household: FIRST_SLICE.firstHousehold, district: FIRST_SLICE.district,
    children_count: "0", adults_count: "2", seniors_count: "0",
  }, cookie);
  expect(saved.status).toBe(303);
  const result = await (await get(realApp, saved.headers.get("location")!, cookie)).text();
  expect(result).toContain("入れました。数に入りました");
  const list = await (await get(realApp, `${path}?view=list`, cookie)).text();
  expect(list).toContain("返事の一覧");
  expect(list).toContain(FIRST_SLICE.firstHousehold);
  expect(await listAnswers(env.DB, ward.wardId, project.projectId)).toMatchObject([
    { household: FIRST_SLICE.firstHousehold, district: FIRST_SLICE.district, peopleCount: 2, source: "phone" },
  ]);
});
