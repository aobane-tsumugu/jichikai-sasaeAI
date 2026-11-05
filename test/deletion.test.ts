import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { CRON } from "../src/core/cron";
import { WardBucket } from "../src/core/storage";
import { createProject } from "../src/project/api";
import { runDeletionCron } from "../src/ops/lifecycle";
import { get, postForm, realApp } from "./helpers";

describe("消す求め", () => {
  it("Web で受けた回答を消すと、回答の表と毎日の写しから消える", async () => {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭（架空）", year: 2026, accountId: account.accountId });
    for (const [answerId, household] of [["answer-erase", "架空 消す世帯"], ["answer-keep", "架空 残る世帯"]] as const) {
      await env.DB.prepare(`INSERT INTO project_answers (answer_id, ward_id, project_id, household, district, people_count, source)
        VALUES (?, ?, ?, ?, '1班', 2, 'web')`).bind(answerId, ward.wardId, project.projectId, household).run();
    }
    const bucket = new WardBucket(env.ORIGINALS, ward.wardId);
    const rows = await env.DB.prepare("SELECT * FROM project_answers WHERE ward_id = ?").bind(ward.wardId).all();
    await bucket.put("snapshots/daily/2026-11-05.json", JSON.stringify({ format: 1, wardId: ward.wardId, capturedAt: "2026-11-05T00:00:00.000Z", tables: { project_answers: rows.results } }));

    const page = await (await get(realApp, `/${ward.slug}/admin/settings/deletion`, cookie)).text();
    expect(page).toContain("架空 消す世帯");
    const response = await postForm(realApp, `/${ward.slug}/admin/settings/deletion/answers/answer-erase`, {}, cookie);
    expect(response.status).toBe(303);
    const left = await env.DB.prepare("SELECT answer_id FROM project_answers WHERE ward_id = ? ORDER BY answer_id").bind(ward.wardId).all<{ answer_id: string }>();
    expect(left.results.map((row) => row.answer_id)).toEqual(["answer-keep"]);

    // 列は区をまたいで一件ずつ進むので、この区の求めが終わるまで回す。
    for (let i = 0; i < 10; i++) {
      const pending = await env.DB.prepare("SELECT COUNT(*) AS n FROM ops_deletion_queue WHERE ward_id = ?").bind(ward.wardId).first<{ n: number }>();
      if (!pending?.n) break;
      await runDeletionCron({ cron: CRON.EVERY_5_MIN } as ScheduledController, env);
    }
    const queue = await env.DB.prepare("SELECT COUNT(*) AS n FROM ops_deletion_queue WHERE ward_id = ?").bind(ward.wardId).first<{ n: number }>();
    expect(queue?.n).toBe(0);
    const snapshot = await (await bucket.get("snapshots/daily/2026-11-05.json"))!.text();
    expect(snapshot).not.toContain("架空 消す世帯");
    expect(snapshot).toContain("架空 残る世帯");

    expect((await postForm(realApp, `/${ward.slug}/admin/settings/deletion/answers/answer-erase`, {}, cookie)).status).toBe(404);
  });
});
