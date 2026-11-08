import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { addQuestion, createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("当日が過ぎた行事の質問の画面は、答えが報告に入ると書き、次を「報告をまとめて終わりにする」にする", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const harvest = await createProject(env.DB, ward.wardId, { kind: "duty", title: "秋の収穫祭", year: 2026, accountId: account.accountId, eventDay: "2026-01-10" });
  await addQuestion(env.DB, ward.wardId, harvest.projectId, { kind: "decide", text: "当日に来た人数は何人でしたか。", packVersion: "test@1" });
  const page = await (await get(realApp, `${root}/projects/${harvest.projectId}/questions`, cookie)).text();
  expect(page).toContain("分かるものだけ答えてください。答えると報告に入ります。答えなくても終わりにできます。");
  expect(page).not.toContain("答えなくても、案内は住民に知らせられます。");
  expect(page).toContain(`<a class="button" href="${root}/close/${harvest.projectId}">報告をまとめて終わりにする</a>`);
  expect(page).not.toContain("当番表の下書きを見る");

  // まだ当日の来ていない行事は、今までどおり下書きへ
  const patrol = await createProject(env.DB, ward.wardId, { kind: "event", title: "年末の見回り", year: 2030, accountId: account.accountId, eventDay: "2030-12-26" });
  await addQuestion(env.DB, ward.wardId, patrol.projectId, { kind: "decide", text: "集合の場所はどこですか。", packVersion: "test@1" });
  const future = await (await get(realApp, `${root}/projects/${patrol.projectId}/questions`, cookie)).text();
  expect(future).toContain("答えなくても、案内は住民に知らせられます。");
  expect(future).toContain("案内の下書きを見る");
});
