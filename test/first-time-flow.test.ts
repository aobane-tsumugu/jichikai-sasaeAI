import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, realApp } from "./helpers";

it("初めての人の動線: 済んだ行事を始めた直後は終わりにする道を主にし、担当を決める仕事は当番表を直接開き、消えるものが無い時は警告しない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const harvest = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId, eventDay: "2026-01-10" });
  const started = await (await get(realApp, `${root}/intake/started/${harvest.projectId}`, cookie)).text();
  expect(started).toContain("秋の収穫祭は、1月10日（土）に行いました。済んでいれば、報告をまとめて終わりにすると");
  expect(started).toContain(`<a class="button" href="${root}/close/${harvest.projectId}">報告をまとめて終わりにする</a>`);

  const close = await (await get(realApp, `${root}/close/${harvest.projectId}`, cookie)).text();
  expect(close).not.toContain("終わりにすると消えるものがあります");
  await env.DB.prepare("INSERT INTO project_help_offers (offer_id, ward_id, project_id, name, times, submission_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), ward.wardId, harvest.projectId, "手伝いの人", "[]", crypto.randomUUID(), new Date().toISOString()).run();
  expect(await (await get(realApp, `${root}/close/${harvest.projectId}`, cookie)).text()).toContain("手伝いだけの申し込み（1人）の名前と時間帯は消えます。");

  const patrol = await createProject(env.DB, ward.wardId, { kind: "duty", title: "年末の見回り", year: 2030, accountId: account.accountId, eventDay: "2030-12-26" });
  const map = await (await get(realApp, `${root}/projects/${patrol.projectId}/map`, cookie)).text();
  expect(map).toContain(`<a class="button" href="${root}/projects/${patrol.projectId}/draft/duty_roster">当番表を作る</a>`);
});
