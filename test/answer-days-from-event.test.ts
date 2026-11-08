import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { addAnswerField, getAnswerFields, updateAnswerField } from "../src/answers/fields";
import { seedAdmin } from "../src/core/testing";
import { setEventDay } from "../src/project/actions";
import { createProject } from "../src/project/api";

it("日が決まる前に足した日を選ぶ欄は、後から行事の日が決まると、その日を選ぶ日として出す。役員が書いた日は変えない", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "試しの年末の見回り", year: 2026, accountId: account.accountId });
  const fieldId = await addAnswerField(env.DB, ward.wardId, project.projectId, "days", account.accountId, { label: "参加できる日", options: [], multiple: true });
  expect((await getAnswerFields(env.DB, ward.wardId, project.projectId, [])).fields[0]?.options).toEqual([]);
  expect(await setEventDay(env.DB, ward.wardId, project.projectId, "2026-12-26", account.accountId, "2026-12-28")).toBe(true);
  expect((await getAnswerFields(env.DB, ward.wardId, project.projectId, [])).fields[0]?.options).toEqual(["12月26日（土）", "12月27日（日）", "12月28日（月）"]);
  // 役員が日を書いた後は、行事の日で上書きしない。
  expect(await updateAnswerField(env.DB, ward.wardId, project.projectId, fieldId!, { label: "参加できる日", options: ["12月27日（日）"], multiple: true })).toBe(true);
  expect((await getAnswerFields(env.DB, ward.wardId, project.projectId, [])).fields[0]?.options).toEqual(["12月27日（日）"]);
});
