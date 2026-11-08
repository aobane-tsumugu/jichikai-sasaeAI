import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { SHORT_TEMPLATE } from "../src/know/year";
import { createProject } from "../src/project/api";
import { startTemplate } from "../src/project/start-template";
import { get, postForm, realApp } from "./helpers";

// AIの起動だけ止め、選ぶ画面、仕事から選ぶ指示とD1への保存は実際の経路を使う。
vi.mock("../src/ai/session", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/ai/session")>(),
  dispatchProject: vi.fn(async () => {}),
}));

it("メッセージの相手と下書きへの指示を種類によらず仕事から選び、当日と次の仕事を説明する", async () => {
  // 準備の名前、日付と資料は全て。
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const template = startTemplate("決算と総会の準備");
  const meeting = await createProject(env.DB, ward.wardId, {
    kind: template.kind, title: "試しの決算と総会の準備", year: 2026, eventDay: "2026-12-20", accountId: account.accountId,
  });
  const board = await createProject(env.DB, ward.wardId, { kind: "board_meeting", title: "試しの議題の整理", year: 2026, accountId: account.accountId });
  const publicProject = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "試しの清掃の準備", year: 2026, taskKeys: SHORT_TEMPLATE.tasks, accountId: account.accountId,
  });
  // 中の種類だけを入れ替え、仕事が変わらなければ相手と指示も変わらないことを確かめる。
  await env.DB.prepare("UPDATE projects SET kind = 'event' WHERE ward_id = ? AND project_id IN (?, ?)")
    .bind(ward.wardId, meeting.projectId, board.projectId).run();
  await env.DB.prepare("UPDATE projects SET kind = 'board_meeting' WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, publicProject.projectId).run();
  const picker = await (await get(realApp, `${root}/messages/new`, cookie)).text();
  expect(picker).toContain(meeting.title);
  expect(picker).toContain(publicProject.title);
  expect(picker).not.toContain(board.title);
  expect(picker).toContain("当日は12月20日（日）です。");
  expect(picker).toContain("次は「");
  for (const label of ["総会です", "行事です", "役員会です"]) expect(picker).not.toContain(label);

  for (const [projectId, kind] of [[meeting.projectId, "report"], [board.projectId, "announcement"]] as const) {
    const refused = await postForm(realApp, `${root}/messages`, { projectId, kind }, cookie);
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("住民ではなく役員や当番の担当に向けたものなので、ここでは作れません。");
    expect(await env.DB.prepare("SELECT job_id FROM jobs WHERE ward_id = ? AND project_id = ? AND task = 'draft'")
      .bind(ward.wardId, projectId).first()).toBeNull();
  }
  for (const [project, instruction] of [[meeting, "総会の招集を作ります。"], [publicProject, "住民向けの行事案内を作ってください。"]] as const) {
    const ctx = createExecutionContext();
    const response = await realApp.fetch(new Request(`http://localhost${root}/messages`, {
      method: "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ projectId: project.projectId, kind: "announcement" }),
    }), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain("notice=started");
    const job = await env.DB.prepare("SELECT instruction FROM jobs WHERE ward_id = ? AND project_id = ? AND task = 'draft'")
      .bind(ward.wardId, project.projectId).first<{ instruction: string }>();
    expect(job?.instruction).toContain(instruction);
    expect(job?.instruction).toContain("対象の文書: announcement。範囲: public。");
  }
});
