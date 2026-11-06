import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { writeDailyWardSnapshots } from "../src/archive/snapshot";
import { CRON } from "../src/core/cron";
import { WardBucket } from "../src/core/storage";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { requestJobDeletion, runDeletionCron } from "../src/ops/lifecycle";
import { addQuestion, applyChange, createProject, getProjectState } from "../src/project/api";

it("資料を消すと段取りの進み具合と質問も元の資料由来の分だけ消え、毎日の写しにも残らない", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の行事", year: 2026, accountId: account.accountId,
  });
  const received = await receive(env, {
    wardId: ward.wardId, projectId: project.projectId, via: "admin", accountId: account.accountId,
    parts: [{ kind: "text", filename: "架空の連絡.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("架空の会場の手配と持ち物の連絡") }],
  });
  const originalId = received.received[0]!.originalId;
  const source = { kind: "original" as const, ref: originalId, year: 2026 };
  expect((await applyChange(env.DB, ward.wardId, project.projectId, {
    kind: "map_task", taskKey: "venue", progress: "done", source, confidence: "high", packVersion: "deletion-test@1",
  })).status).toBe("applied");
  expect((await applyChange(env.DB, ward.wardId, project.projectId, {
    kind: "item", itemKey: "belongings", value: "架空の読めない持ち物", source, confidence: "low", packVersion: "deletion-test@1",
  })).status).toBe("applied");
  expect((await addQuestion(env.DB, ward.wardId, project.projectId, {
    kind: "decide", text: "架空の元の資料に書かれた質問", source, packVersion: "deletion-test@1",
  })).status).toBe("added");
  expect((await applyChange(env.DB, ward.wardId, project.projectId, {
    kind: "map_task", taskKey: "committee", progress: "done", source: { kind: "person", accountId: account.accountId },
    confidence: "high", packVersion: "deletion-test@1",
  })).status).toBe("applied");
  expect((await addQuestion(env.DB, ward.wardId, project.projectId, {
    kind: "decide", text: "架空の役員が書いた質問", source: { kind: "person", accountId: account.accountId }, packVersion: "deletion-test@1",
  })).status).toBe("added");
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
  expect(await env.DB.prepare("SELECT original_id FROM originals WHERE ward_id = ? AND original_id = ?").bind(ward.wardId, originalId).first()).toBeNull();
  const bucket = new WardBucket(env.ORIGINALS, ward.wardId);
  expect(await bucket.get(`originals/${originalId}`)).toBeNull();
  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  expect(state?.mapTasks.find((task) => task.taskKey === "venue")).toMatchObject({ progress: "open", progressSource: null });
  expect(state?.mapTasks.find((task) => task.taskKey === "committee")?.progress).toBe("done");
  expect(state?.questions.map((question) => question.text)).toEqual(["架空の役員が書いた質問"]);
  const snapshot = await (await bucket.get("snapshots/daily/2026-11-05.json"))!.text();
  expect(snapshot).not.toContain(originalId);
  expect(snapshot).not.toContain("架空の元の資料に書かれた質問");
  expect(snapshot).toContain("架空の役員が書いた質問");
});
