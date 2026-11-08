import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import * as ai from "../src/ai/api";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { createProject, getProjectSummary } from "../src/project/api";
import { projectTasks, taskCollectsAttendance } from "../src/project/task-features";
import { get, postForm, realApp, sendLatest } from "./helpers";

it("L-319: 住民へのメッセージの入口は五つから選び、行事の案内では出欠を聞くかを選べる。実行委員と班長への連絡も同じ入口から作る", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId, eventDay: "2027-10-25" });
  const fake = vi.spyOn(ai, "startTask").mockResolvedValue("fictional-job");
  try {
    const picker = await (await get(realApp, `${root}/messages/new`, cookie)).text();
    for (const title of ["行事の案内や宣伝", "手伝いの募集", "連絡事項", "終わった報告", "実行委員と班長への連絡"]) expect(picker).toContain(title);
    expect(picker).toContain("行事の案内や宣伝のとき、出欠を聞きますか");

    // 出欠を聞かないと選ぶと、案内に返事の入口と回答票を付けない。
    const made = await postForm(realApp, `${root}/messages`, { kind: "announcement", projectId: project.projectId, attendance: "no" }, cookie);
    expect(made.status).toBe(303);
    expect(made.headers.get("location")).toContain(`/projects/${project.projectId}/draft/announcement?edit=1`);
    expect(taskCollectsAttendance(await projectTasks(env.DB, ward.wardId, project.projectId), "announcement")).toBe(false);
    await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, { kind: "announcement", title: "秋の収穫祭のご案内", scope: "public",
      basedOn: (await getProjectSummary(env.DB, ward.wardId, project.projectId))!.stateVersion, body: JSON.stringify({ text: "秋の収穫祭を行います。", items: [] }) });
    const draft = await (await get(realApp, `${root}/projects/${project.projectId}/draft/announcement`, cookie)).text();
    expect(draft).toContain("出欠を聞かない案内です");
    expect(draft).not.toContain("住民に返事で聞くこと");
    expect((await sendLatest(ward.slug, ward.wardId, project.projectId, "announcement", cookie)).status).toBe(303);
    expect(await (await get(realApp, `/${ward.slug}/p/${project.projectId}`)).text()).not.toContain("出欠を答える");

    // 下書きの画面から、出欠を聞くに戻せる。
    const on = await postForm(realApp, `${root}/answers/${project.projectId}/attendance`, { state: "on" }, cookie);
    expect(on.headers.get("location")).toContain("notice=attendance_on");
    expect(taskCollectsAttendance(await projectTasks(env.DB, ward.wardId, project.projectId), "announcement")).toBe(true);
    expect(await (await get(realApp, `/${ward.slug}/p/${project.projectId}`)).text()).toContain("出欠を答える");
    expect(await env.DB.prepare("SELECT answers_off_at FROM projects WHERE ward_id = ? AND project_id = ?").bind(ward.wardId, project.projectId).first()).toEqual({ answers_off_at: null });

    // 実行委員と班長への連絡は、同じ入口から当番表か進め方の下書きを開く。
    const space = await postForm(realApp, `${root}/messages`, { kind: "space", projectId: project.projectId }, cookie);
    expect(space.status).toBe(303);
    expect(space.headers.get("location")).toMatch(new RegExp(`/projects/${project.projectId}/draft/(duty_roster|procedure)\\?edit=1`));
  } finally { fake.mockRestore(); }
});
