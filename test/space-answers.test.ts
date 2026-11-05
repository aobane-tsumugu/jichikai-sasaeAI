import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { addAnswer } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { cookieFrom, get, postForm, realApp } from "./helpers";

it("役員が空間を開き、実行委員が合言葉で回答を見て、閉じた後は案内を読む", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "秋の収穫祭（架空）", year: 2026, accountId: account.accountId,
  });
  await addAnswer(env.DB, ward.wardId, {
    projectId: project.projectId, household: "確認用の世帯（架空）", district: "1班", peopleCount: 3, source: "phone",
  });
  const admin = `/${ward.slug}/admin`;
  const space = `/${ward.slug}/space/${project.projectId}`;
  const answerList = await get(realApp, `${admin}/answers`, cookie);
  expect(await answerList.text()).toMatch(/<h1>回答(?:\s|<)/);
  const answer = await get(realApp, `${admin}/answers/${project.projectId}`, cookie);
  expect(await answer.text()).toContain("回答の一覧へ");

  const opened = await postForm(realApp, `${admin}/space/${project.projectId}/open`, { passphrase: "確認用の合言葉（架空）" }, cookie);
  expect(opened.status).toBe(303);
  const entrance = await get(realApp, space);
  expect(await entrance.text()).toContain("合言葉");
  const entered = await postForm(realApp, `${space}/enter`, { passphrase: "確認用の合言葉（架空）" });
  expect(entered.status).toBe(303);
  const memberCookie = cookieFrom(entered, `space_${project.projectId}`);
  expect(memberCookie).not.toBeNull();
  const page = await get(realApp, space, memberCookie!);
  expect(page.status).toBe(200);
  const html = await page.text();
  expect(html).toContain("確認用の世帯（架空）");
  expect(html).toContain("当番表と配置図");

  const closed = await postForm(realApp, `${admin}/space/${project.projectId}/close`, {}, cookie);
  expect(closed.status).toBe(303);
  const after = await get(realApp, space, memberCookie!);
  expect(after.status).toBe(403);
  const closedHtml = await after.text();
  expect(closedHtml).toContain("閉じました。役員に聞いてください");
  expect(closedHtml).not.toContain("確認用の世帯（架空）");
  expect((await get(realApp, `${admin}/space/${project.projectId}`, cookie)).status).toBe(200);
});
