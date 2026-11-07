import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { snapshotToSql } from "../scripts/snapshot-to-sql.mjs";
import { SNAPSHOT_TABLES, writeDailyWardSnapshots } from "../src/archive/snapshot";
import { CRON } from "../src/core/cron";
import { WardBucket } from "../src/core/storage";
import { seedAdmin } from "../src/core/testing";
import { requestJobDeletion, runDeletionCron } from "../src/ops/lifecycle";

it("写真を消した日次の写しを戻すとき、別の受付で届いた確認の返事も連動して外す", async () => {
  const { ward } = await seedAdmin(env.DB);
  const w = ward.wardId;
  // 写真、受付、確認と返事はすべて架空。AIやLINEには接続しない。
  const deletedJob = crypto.randomUUID(), keptJob = crypto.randomUUID(), answerJob = crypto.randomUUID();
  for (const job of [deletedJob, keptJob, answerJob]) {
    await env.DB.prepare(`INSERT INTO jobs (ward_id, job_id, via, task, status, created_at, updated_at)
      VALUES (?, ?, 'line_group', 'connect', 'done', '2026-11-07', '2026-11-07')`).bind(w, job).run();
  }
  const batch = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO line_photo_batches
    (ward_id, batch_id, destination, source_type, source_id, sender_id, created_at, last_received_at)
    VALUES (?, ?, 'fictional-destination', 'group', 'fictional-group', 'fictional-sender', '2026-11-07', '2026-11-07')`)
    .bind(w, batch).run();
  const records = [deletedJob, keptJob].map((job) => ({ job, original: crypto.randomUUID(), clarification: crypto.randomUUID(), event: crypto.randomUUID() }));
  for (const [index, row] of records.entries()) {
    await env.DB.prepare(`INSERT INTO originals
      (ward_id, original_id, job_id, position, kind, content_hash, media_type, filename, byte_size, received_at)
      VALUES (?, ?, ?, 1, 'photo', ?, 'image/jpeg', '架空の写真.jpg', 1, '2026-11-07')`)
      .bind(w, row.original, row.job, String(index + 1).repeat(64)).run();
    await env.DB.prepare(`INSERT INTO line_clarifications
      (ward_id, clarification_id, batch_id, job_id, original_id, topic, text)
      VALUES (?, ?, ?, ?, ?, 'year', '架空の写真は何年のものですか')`)
      .bind(w, row.clarification, batch, row.job, row.original).run();
    await env.DB.prepare(`INSERT INTO line_clarification_answers
      (ward_id, event_id, clarification_id, job_id, answer_text, sender_label)
      VALUES (?, ?, ?, ?, '架空の2026年の写真です。', '架空の送信者')`)
      .bind(w, row.event, row.clarification, answerJob).run();
  }
  const answers = () => env.DB.prepare("SELECT event_id FROM line_clarification_answers WHERE ward_id = ?").bind(w).all<{ event_id: string }>();
  await writeDailyWardSnapshots(env, new Date("2026-11-07T00:00:00Z"));
  const queueId = await requestJobDeletion(env.DB, w, deletedJob);
  for (let step = 0; step < 6; step++) {
    if (!(await env.DB.prepare("SELECT queue_id FROM ops_deletion_queue WHERE ward_id = ? AND queue_id = ?").bind(w, queueId).first())) break;
    await runDeletionCron({ cron: CRON.EVERY_5_MIN } as ScheduledController, env);
  }
  expect(await env.DB.prepare("SELECT queue_id FROM ops_deletion_queue WHERE ward_id = ? AND queue_id = ?").bind(w, queueId).first()).toBeNull();
  const kept = records[1]!;
  expect((await answers()).results).toEqual([{ event_id: kept.event }]);
  const object = await new WardBucket(env.ORIGINALS, w).get("snapshots/daily/2026-11-07.json");
  if (!object) throw new Error("架空の日次の写しがありません");
  const snapshot = await object.json();
  // 同じ試験用の自治会だけを空にして、消去を反映した写しから復旧する。
  for (const table of [...SNAPSHOT_TABLES].reverse()) await env.DB.prepare(`DELETE FROM ${table} WHERE ward_id = ?`).bind(w).run();
  await env.DB.exec(snapshotToSql(snapshot).sql);
  expect((await answers()).results).toEqual([{ event_id: kept.event }]);
  expect((await env.DB.prepare("SELECT clarification_id FROM line_clarifications WHERE ward_id = ?").bind(w).all()).results)
    .toEqual([{ clarification_id: kept.clarification }]);
  expect((await env.DB.prepare("SELECT job_id FROM jobs WHERE ward_id = ? ORDER BY job_id").bind(w).all()).results)
    .toEqual([keptJob, answerJob].sort().map((job_id) => ({ job_id })));
});
