import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { snapshotToSql } from "../scripts/snapshot-to-sql.mjs";
import { SNAPSHOT_TABLES, writeDailyWardSnapshots } from "../src/archive/snapshot";
import { CRON } from "../src/core/cron";
import { WardBucket } from "../src/core/storage";
import { seedAdmin } from "../src/core/testing";
import { requestJobDeletion, runDeletionCron } from "../src/ops/lifecycle";

it("資料を消した後の写しを戻せ、残す資料へのつながりと区の決まりは保つ", async () => {
  const { ward } = await seedAdmin(env.DB);
  const w = ward.wardId;
  // 番号、資料名、区の決まりは試験用の試しのもの。AIや外部サービスは使わない。
  const deletedJob = crypto.randomUUID(), keptJob = crypto.randomUUID();
  const originals = [
    { id: crypto.randomUUID(), job: deletedJob, position: 1 },
    { id: crypto.randomUUID(), job: deletedJob, position: 2 },
    { id: crypto.randomUUID(), job: keptJob, position: 1 },
  ];
  for (const job of [deletedJob, keptJob]) {
    await env.DB.prepare(`INSERT INTO jobs (ward_id, job_id, via, task, status, created_at, updated_at)
      VALUES (?, ?, 'admin', 'connect', 'done', '2026-11-07', '2026-11-07')`).bind(w, job).run();
  }
  const body = "試しの区の決まりを役員が書きました。";
  await env.DB.prepare("INSERT INTO ward_know_items (ward_id, item_id, body, reviewed_at) VALUES (?, 'meeting', ?, '2026-11-07')")
    .bind(w, body).run();
  for (const [index, original] of originals.entries()) {
    await env.DB.prepare(`INSERT INTO originals
      (ward_id, original_id, job_id, position, kind, content_hash, media_type, filename, byte_size, received_at)
      VALUES (?, ?, ?, ?, 'text', ?, 'text/plain', ?, 1, '2026-11-07')`)
      .bind(w, original.id, original.job, original.position, String(index + 1).repeat(64), `試しの資料${index + 1}.txt`).run();
    await env.DB.prepare(`INSERT INTO ward_material_links (ward_id, link_id, original_id, target_kind, target_id, linked_by)
      VALUES (?, ?, ?, 'know_item', 'meeting', 'person')`).bind(w, original.id, original.id).run();
  }

  await writeDailyWardSnapshots(env, new Date("2026-11-07T00:00:00Z"));
  const queueId = await requestJobDeletion(env.DB, w, deletedJob);
  for (let step = 0; step < 6; step++) {
    const queued = await env.DB.prepare("SELECT queue_id FROM ops_deletion_queue WHERE ward_id = ? AND queue_id = ?").bind(w, queueId).first();
    if (!queued) break;
    await runDeletionCron({ cron: CRON.EVERY_5_MIN } as ScheduledController, env);
  }
  expect(await env.DB.prepare("SELECT queue_id FROM ops_deletion_queue WHERE ward_id = ? AND queue_id = ?").bind(w, queueId).first()).toBeNull();
  const kept = originals[2]!;
  const links = () => env.DB.prepare("SELECT original_id FROM ward_material_links WHERE ward_id = ?").bind(w).all<{ original_id: string }>();
  expect((await links()).results).toEqual([{ original_id: kept.id }]);

  const object = await new WardBucket(env.ORIGINALS, w).get("snapshots/daily/2026-11-07.json");
  if (!object) throw new Error("試しの日次の写しがありません");
  const snapshot = await object.json();
  // 同じ試験用の区だけを空にし、消去を反映した写しを実際に戻す。
  for (const table of [...SNAPSHOT_TABLES].reverse()) await env.DB.prepare(`DELETE FROM ${table} WHERE ward_id = ?`).bind(w).run();
  await env.DB.exec(snapshotToSql(snapshot).sql);
  expect((await links()).results).toEqual([{ original_id: kept.id }]);
  expect(await env.DB.prepare("SELECT original_id FROM originals WHERE ward_id = ?").bind(w).all<{ original_id: string }>())
    .toMatchObject({ results: [{ original_id: kept.id }] });
  expect(await env.DB.prepare("SELECT body FROM ward_know_items WHERE ward_id = ? AND item_id = 'meeting'").bind(w).first("body")).toBe(body);
});
