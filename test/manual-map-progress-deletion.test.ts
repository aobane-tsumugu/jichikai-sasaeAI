import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { writeDailyWardSnapshots } from "../src/archive/snapshot";
import { CRON } from "../src/core/cron";
import { WardBucket } from "../src/core/storage";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { requestJobDeletion, runDeletionCron } from "../src/ops/lifecycle";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import { postForm, realApp } from "./helpers";

it("やることで人が保存した進み具合は、元の資料を消しても毎日の写しと一緒に残る", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の行事", year: 2026, accountId: account.accountId,
  });
  const received = await receive(env, {
    wardId: ward.wardId, projectId: project.projectId, via: "admin", accountId: account.accountId,
    parts: [{ kind: "text", filename: "架空の会場の連絡.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("架空の会場の手配を始めました。") }],
  });
  expect((await applyChange(env.DB, ward.wardId, project.projectId, {
    kind: "map_task", taskKey: "venue", progress: "started",
    source: { kind: "original", ref: received.received[0]!.originalId, year: 2026 },
    confidence: "high", packVersion: "manual-map-test@1",
  })).status).toBe("applied");
  const task = (await getProjectState(env.DB, ward.wardId, project.projectId))!.mapTasks.find((task) => task.taskKey === "venue")!;
  expect((await postForm(realApp, `/${ward.slug}/admin/projects/${project.projectId}/map/${task.taskId}`, {
    name: task.name, start: task.periodStart ?? "", end: task.periodEnd ?? "", progress: "done", seat_id: "",
  }, cookie)).status).toBe(303);
  await writeDailyWardSnapshots(env, new Date("2026-11-05T00:00:00.000Z"));
  const queueId = await requestJobDeletion(env.DB, ward.wardId, received.jobId!);
  let pending: { state: string } | null = null;
  for (let i = 0; i < 6; i++) {
    await runDeletionCron({ cron: CRON.EVERY_5_MIN } as ScheduledController, env);
    pending = await env.DB.prepare("SELECT state FROM ops_deletion_queue WHERE ward_id = ? AND queue_id = ?")
      .bind(ward.wardId, queueId).first<{ state: string }>();
    if (!pending || pending.state === "error") break;
  }
  expect(pending).toBeNull();
  expect(await env.DB.prepare("SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ?").bind(ward.wardId, received.jobId).first()).toBeNull();
  expect((await getProjectState(env.DB, ward.wardId, project.projectId))!.mapTasks.find((row) => row.taskId === task.taskId))
    .toMatchObject({ progress: "done", progressSource: { kind: "person" } });
  const object = await new WardBucket(env.ORIGINALS, ward.wardId).get("snapshots/daily/2026-11-05.json");
  const snapshot = await object!.json<{ tables: { project_map_tasks: Array<{ task_id: string; progress: string; progress_source_kind: string | null }> } }>();
  expect(snapshot.tables.project_map_tasks.find((row) => row.task_id === task.taskId))
    .toMatchObject({ progress: "done", progress_source_kind: "person" });
});
