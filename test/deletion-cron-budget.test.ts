import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { CRON } from "../src/core/cron";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { requestJobDeletion, runDeletionCron } from "../src/ops/lifecycle";

it("一回の Cron で、待っている資料の消す求めを続けて進め、何件も消し終える", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const queued: string[] = [];
  for (const index of [1, 2, 3]) {
    const received = await receive(env, { wardId: ward.wardId, via: "admin", accountId: account.accountId,
      parts: [{ kind: "text", filename: `試しの連絡${index}.txt`, mediaType: "text/plain", bytes: new TextEncoder().encode(`試しの連絡 ${index}`) }] });
    queued.push(await requestJobDeletion(env.DB, ward.wardId, received.jobId!));
  }
  await runDeletionCron({ cron: CRON.EVERY_5_MIN } as ScheduledController, env);
  const left = await env.DB.prepare(`SELECT count(*) AS n FROM ops_deletion_queue WHERE ward_id = ? AND state IN ('pending', 'running', 'error')`)
    .bind(ward.wardId).first<{ n: number }>();
  expect(left?.n).toBe(0);
  const originals = await env.DB.prepare("SELECT count(*) AS n FROM originals WHERE ward_id = ? AND r2_path IS NOT NULL").bind(ward.wardId).first<{ n: number }>();
  expect(originals?.n).toBe(0);
  expect(queued).toHaveLength(3);
});
