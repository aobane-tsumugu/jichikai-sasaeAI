import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedAdmin, seedSeat } from "../src/core/testing";
import { createProject, getProjectState } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

async function fixture() {
  const setup = await seedAdmin(env.DB);
  const project = await createProject(env.DB, setup.ward.wardId, { kind: "event", title: "架空の日付確認会", year: 2026, eventDay: "2026-11-24", accountId: setup.account.accountId });
  const state = await getProjectState(env.DB, setup.ward.wardId, project.projectId);
  const task = state!.mapTasks.find((row) => row.taskKey === "venue")!;
  const root = `/${setup.ward.slug}/admin`;
  return { ...setup, project, task, root, path: `${root}/projects/${project.projectId}/map/${task.taskId}` };
}

it("逆の日付を保存せずに入力を残し、直した仕事を今の時期に表示する", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-07T03:00:00Z"));
  try {
    const f = await fixture();
    const original = { name: "架空の元の会場の手配", start: "2026-11-01", end: "2026-11-10", progress: "open", seat_id: "" };
    expect((await postForm(realApp, f.path, original, f.cookie)).status).toBe(303);
    const before = (await getProjectState(env.DB, f.ward.wardId, f.project.projectId))!.mapTasks;
    expect(await (await get(realApp, `${f.root}/`, f.cookie)).text()).toContain(original.name);

    const seatId = await seedSeat(env.DB, f.ward.wardId, "架空の会場担当");
    const values = { name: "架空の直した会場の手配", start: "2026-11-10", end: "2026-11-01", progress: "started", seat_id: seatId };
    const invalid = await postForm(realApp, f.path, values, f.cookie);
    expect(invalid.status).toBe(400);
    const html = await invalid.text();
    expect(html).toContain("始める日が終わる日よりあとになっています。");
    expect(html).toContain(`action="${f.path}"`);
    expect(html).toMatch(/<details\b(?=[^>]*class="fold")(?=[^>]*\bopen)[^>]*><summary>時期や担当を直す/);
    for (const key of ["name", "start", "end"] as const) {
      expect(html).toMatch(new RegExp(`<input\\b(?=[^>]*name="${key}")(?=[^>]*value="${values[key]}")[^>]*>`));
    }
    for (const value of [seatId, values.progress]) expect(html).toMatch(new RegExp(`<option\\b(?=[^>]*value="${value}")(?=[^>]*\\bselected)[^>]*>`));
    expect((await getProjectState(env.DB, f.ward.wardId, f.project.projectId))!.mapTasks).toEqual(before);

    expect((await postForm(realApp, f.path, { ...values, start: "2026-11-02", end: "2026-11-08" }, f.cookie)).status).toBe(303);
    const updated = (await getProjectState(env.DB, f.ward.wardId, f.project.projectId))!.mapTasks.find((task) => task.taskId === f.task.taskId);
    expect(updated).toMatchObject({ name: values.name, periodStart: "2026-11-02", periodEnd: "2026-11-08", progress: values.progress, seatId });
    expect(await (await get(realApp, `${f.root}/`, f.cookie)).text()).toContain(values.name);
  } finally {
    vi.useRealTimers();
  }
});

it("同日と、片方または両方が未定の仕事は保存できる", async () => {
  const f = await fixture();
  for (const [start, end] of [["2026-11-07", "2026-11-07"], ["", "2026-11-07"], ["2026-11-07", ""], ["", ""]] as const) {
    expect((await postForm(realApp, f.path, { name: f.task.name, start, end, progress: "open", seat_id: "" }, f.cookie)).status).toBe(303);
    const saved = (await getProjectState(env.DB, f.ward.wardId, f.project.projectId))!.mapTasks.find((task) => task.taskId === f.task.taskId);
    expect(saved).toMatchObject({ periodStart: start || null, periodEnd: end || null });
  }
});
