import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { writeDailyWardSnapshots } from "../src/archive/snapshot";
import { CRON } from "../src/core/cron";
import { WardBucket } from "../src/core/storage";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { listDeletionQueue, requestJobDeletion, requestProjectDeletion, runDeletionCron } from "../src/ops/lifecycle";
import { createProject } from "../src/project/api";
import { OPS_COOKIE } from "../src/ops/session";
import { cookieFrom, get, OPS_ID, OPS_PASSWORD, opsEnv, postForm, realApp } from "./helpers";

const tick = { cron: CRON.EVERY_5_MIN } as ScheduledController;

it("資料30件と準備2つを5回以内で消し、日次の写しは一つにつきまとめて一度だけ書き直す", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const w = ward.wardId;
  const projects = await Promise.all(["一つ目の準備", "二つ目の準備"].map((title) =>
    createProject(env.DB, w, { title, kind: "event", year: 2026, accountId: account.accountId })));
  const materials: Array<{ jobId: string; originalId: string; text: string }> = [];
  for (let i = 0; i < 30; i++) {
    const text = `消す試験資料の中身${i}`;
    const input = await receive(env, { wardId: w, via: "admin", projectId: projects[i % 3]?.projectId,
      parts: [{ kind: "text", filename: `資料${i}.txt`, mediaType: "text/plain", bytes: new TextEncoder().encode(text) }] });
    materials.push({ jobId: input.jobId!, originalId: input.received[0]!.originalId, text });
  }
  await writeDailyWardSnapshots(env, new Date("2026-11-08T00:00:00Z"));
  const bucket = new WardBucket(env.ORIGINALS, w);
  const base = await (await bucket.get("snapshots/daily/2026-11-08.json"))!.text();
  for (let day = 2; day <= 7; day++) await bucket.put(`snapshots/daily/2026-11-0${day}.json`, base);
  if (!env.ORIGINALS_BACKUP) throw new Error("試験用の別の保管先がありません");
  const backup = new WardBucket(env.ORIGINALS_BACKUP, w);
  await backup.put("snapshots/daily/2026-11-01.json", base);
  for (const material of materials) await requestJobDeletion(env.DB, w, material.jobId);
  for (const project of projects) expect(await requestProjectDeletion(env.DB, w, project.projectId)).toBe(true);
  await env.DB.prepare("UPDATE ops_deletion_queue SET requested_at = '2026-11-08T00:00:00Z' WHERE ward_id = ?").bind(w).run();
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM ops_deletion_queue WHERE ward_id = ?").bind(w).first("n")).toBe(32);
  const writes = vi.spyOn(env.ORIGINALS, "put");
  const reads = vi.spyOn(env.ORIGINALS, "get");
  let cronCalls = 0;
  try {
    for (; cronCalls < 5; cronCalls++) {
      if (!await env.DB.prepare("SELECT 1 FROM ops_deletion_queue WHERE ward_id = ? LIMIT 1").bind(w).first()) break;
      await runDeletionCron(tick, env);
    }
    const snapshotWrites = writes.mock.calls.map(([key]) => key).filter((key) => key.startsWith(`${w}/snapshots/daily/`));
    expect(snapshotWrites).toHaveLength(8);
    expect(new Set(snapshotWrites).size).toBe(8);
    expect(reads.mock.calls.filter(([key]) => key.startsWith(`${w}/snapshots/daily/`))).toHaveLength(7);
  } finally { writes.mockRestore(); reads.mockRestore(); }
  expect(cronCalls).toBeLessThanOrEqual(5);
  for (const table of ["ops_deletion_queue", "jobs", "originals", "readings", "projects"]) {
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ward_id = ?`).bind(w).first("n")).toBe(0);
  }
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM ops_deletion_marks WHERE ward_id = ?").bind(w).first("n")).toBe(32);
  for (const store of [bucket, backup]) {
    expect((await store.list("originals/")).keys).toHaveLength(0);
    for (let day = 1; day <= 8; day++) {
      const snapshot = await (await store.get(`snapshots/daily/2026-11-0${day}.json`))!.text();
      for (const material of materials) {
        expect(snapshot).not.toContain(material.originalId);
        expect(snapshot).not.toContain(material.jobId);
        expect(snapshot).not.toContain(material.text);
      }
      for (const project of projects) expect(snapshot).not.toContain(project.projectId);
    }
  }
}, 30_000);

it("同じ時刻なら積んだ順に終え、処理中の求めは待っている求めより先に終える", async () => {
  const { ward } = await seedAdmin(env.DB);
  const w = ward.wardId;
  const queueIds: string[] = [];
  const jobIds: string[] = [];
  for (let i = 0; i < 3; i++) {
    const input = await receive(env, { wardId: w, via: "admin", parts: [{ kind: "text", filename: `${i}.txt`, mediaType: "text/plain", bytes: new TextEncoder().encode(`順番を確かめる文${i}`) }] });
    jobIds.push(input.jobId!);
    queueIds.push(await requestJobDeletion(env.DB, w, input.jobId!));
  }
  await env.DB.prepare("UPDATE ops_deletion_queue SET requested_at = '2026-11-08T00:00:00Z' WHERE ward_id = ?").bind(w).run();
  await env.DB.prepare("UPDATE ops_deletion_queue SET state = 'running' WHERE ward_id = ? AND queue_id = ?").bind(w, queueIds[2]).run();
  await runDeletionCron(tick, env);
  const marks = await env.DB.prepare("SELECT target_id FROM ops_deletion_marks WHERE ward_id = ? ORDER BY rowid").bind(w).all<{ target_id: string }>();
  expect(marks.results.map((row) => row.target_id)).toEqual([jobIds[2], jobIds[0], jobIds[1]]);
});

it("写しの保存が止まるとerrorと途中位置を運用の画面に残し、次のCronで消し終えられる", async () => {
  const { ward } = await seedAdmin(env.DB);
  const w = ward.wardId;
  const input = await receive(env, { wardId: w, via: "admin", parts: [{ kind: "text", filename: "消す文.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("停止から再開する文") }] });
  await writeDailyWardSnapshots(env, new Date("2026-11-08T00:00:00Z"));
  const queueId = await requestJobDeletion(env.DB, w, input.jobId!);
  const failed = vi.spyOn(env.ORIGINALS, "put").mockRejectedValueOnce(new Error("試しの停止"));
  try { await runDeletionCron(tick, env); } finally { failed.mockRestore(); }
  expect((await listDeletionQueue(env.DB, w)).find((row) => row.queue_id === queueId))
    .toMatchObject({ state: "error", last_error: "処理を完了できませんでした。提供側で確認してください。" });
  const cursor = await env.DB.prepare("SELECT cursor FROM ops_deletion_queue WHERE ward_id = ? AND queue_id = ?").bind(w, queueId).first<string>("cursor");
  expect(cursor?.startsWith("batch:")).toBe(true);
  expect(await env.DB.prepare("SELECT job_id FROM jobs WHERE ward_id = ? AND job_id = ?").bind(w, input.jobId).first()).not.toBeNull();
  const login = await postForm(realApp, "/ops/login", { id: OPS_ID, password: OPS_PASSWORD }, undefined, opsEnv);
  const opsCookie = cookieFrom(login, OPS_COOKIE);
  if (!opsCookie) throw new Error("試験用の運用の画面にログインできませんでした");
  const response = await get(realApp, `/ops/wards/${ward.slug}/lifecycle`, opsCookie, opsEnv);
  expect(response.status).toBe(200);
  expect(await response.text()).toContain("処理を完了できませんでした");
  await runDeletionCron(tick, env);
  expect(await env.DB.prepare("SELECT queue_id FROM ops_deletion_queue WHERE ward_id = ? AND queue_id = ?").bind(w, queueId).first()).toBeNull();
  expect(await new WardBucket(env.ORIGINALS, w).get(`originals/${input.received[0]!.originalId}`)).toBeNull();
});
