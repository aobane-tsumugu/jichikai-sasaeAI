import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { addAnswer, listAnswers, type AnswerInput } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("閉じた後は取り込み済みの回答票も変わらず、開き直すと同じ回答を直せる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の行事", year: 2026, accountId: account.accountId,
  });
  const sheet = await receive(env, {
    wardId: ward.wardId, projectId: project.projectId, via: "admin", readKind: "answer_sheet", accountId: account.accountId,
    parts: [{ kind: "photo", filename: "架空の回答票.jpg", mediaType: "image/jpeg", bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0]) }],
  });
  const input: AnswerInput = {
    projectId: project.projectId, household: "架空の世帯", district: "1班", peopleCount: 2,
    source: "sheet", originalId: sheet.received[0]!.originalId, sheetRowIndex: 0, accountId: account.accountId,
  };
  const answerId = await addAnswer(env.DB, ward.wardId, input);
  const closePath = `/${ward.slug}/admin/close/${project.projectId}`;
  expect((await postForm(realApp, `${closePath}/finalize`, {}, cookie)).status).toBe(303);
  await expect(addAnswer(env.DB, ward.wardId, { ...input, peopleCount: 9 }))
    .rejects.toThrow("このプロジェクトは回答を受け付けていません。");
  expect(await listAnswers(env.DB, ward.wardId, project.projectId))
    .toMatchObject([{ answerId, peopleCount: 2 }]);

  const rowPath = `/${ward.slug}/admin/answers/${project.projectId}/sheet/${input.originalId}/row/0`;
  const response = await postForm(realApp, rowPath, { household: input.household, district: input.district, people_count: "9" }, cookie);
  expect(response.status).toBe(303);
  const location = response.headers.get("location")!;
  expect(new URL(location, "http://localhost").pathname).toBe(closePath);
  expect(await (await get(realApp, location, cookie)).text()).toContain("答えを直すときは「もう一度開く」を押してください。");
  expect(await listAnswers(env.DB, ward.wardId, project.projectId))
    .toMatchObject([{ answerId, peopleCount: 2 }]);

  expect((await postForm(realApp, `${closePath}/reopen`, {}, cookie)).status).toBe(303);
  expect((await postForm(realApp, rowPath, { household: input.household, district: input.district, people_count: "4" }, cookie)).status).toBe(303);
  expect(await listAnswers(env.DB, ward.wardId, project.projectId))
    .toMatchObject([{ answerId, peopleCount: 4 }]);
});
