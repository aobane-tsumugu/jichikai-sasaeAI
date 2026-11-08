import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { addAnswer, getAnswer } from "../src/answers/api";
import { addAnswerField, updateAnswerField } from "../src/answers/fields";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("日の候補から外した日を選んでいた返事は、直す画面で選んだまま出て、名前だけ直しても消えず、役員が外せば外れる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "試しの年末の見回り", year: 2026, accountId: account.accountId });
  const fieldId = await addAnswerField(env.DB, ward.wardId, project.projectId, "days", account.accountId,
    { label: "参加できる日", options: ["12月26日（土）", "12月27日（日）"], multiple: true });
  expect(fieldId).toBeTruthy();
  const answerId = await addAnswer(env.DB, ward.wardId, { projectId: project.projectId, household: "試しの世帯", district: "", peopleCount: 2,
    source: "web", fieldValues: { [fieldId!]: ["12月26日（土）"] } });
  // 役員が候補を 27 日だけに直す。
  expect(await updateAnswerField(env.DB, ward.wardId, project.projectId, fieldId!, { label: "参加できる日", options: ["12月27日（日）"], multiple: true })).toBe(true);

  const editPath = `/${ward.slug}/admin/answers/${project.projectId}/${answerId}/edit`;
  const page = await (await get(realApp, editPath, cookie)).text();
  expect(page).toContain("12月26日（土）（今の候補にはありません）");
  expect(page).toMatch(/value="12月26日（土）" checked/);

  // 画面のとおり（26 日に印のまま）名前だけ直して保存すると、26 日は残る。
  const kept = await postForm(realApp, `${editPath}`, { household: "試しの世帯（直した）", district: "", attend: "yes", people_count: "2", [`field_${fieldId}`]: "12月26日（土）" }, cookie);
  expect(kept.status).toBeLessThan(400);
  expect((await getAnswer(env.DB, ward.wardId, project.projectId, answerId))?.fieldValues?.[fieldId!]).toEqual(["12月26日（土）"]);

  // 役員が印を外して保存すれば、26 日は外れる（選び直せる）。
  await postForm(realApp, `${editPath}`, { household: "試しの世帯（直した）", district: "", attend: "yes", people_count: "2" }, cookie);
  expect((await getAnswer(env.DB, ward.wardId, project.projectId, answerId))?.fieldValues?.[fieldId!]).toBeUndefined();
});
