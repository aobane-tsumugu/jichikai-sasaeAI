import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { writeDailyWardSnapshots } from "../src/archive/snapshot";
import { CRON } from "../src/core/cron";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { saveFlyer } from "../src/draft/notice-flyers";
import { requestProjectDeletion, runDeletionCron } from "../src/ops/lifecycle";
import { saveDocument } from "../src/project/actions";
import { createProject } from "../src/project/api";
import { getNoticeFlyer } from "../src/publish/notice-flyers";
import { noticeFlyerJpeg } from "./fixtures/notice-flyer";

it("丸ごとの削除でチラシの画像と見本も消し、別の準備のチラシは保つ", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const bucket = new WardBucket(env.ORIGINALS, ward.wardId);
  // 名前も画像も架空。既存の保存処理だけを使い、LINEやAIには接続しない。
  const records = [];
  for (const title of ["消す準備（架空）", "残す準備（架空）"]) {
    const project = await createProject(env.DB, ward.wardId, { kind: "event", title, year: 2026, accountId: account.accountId });
    expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
      kind: "announcement", title: "架空の案内", scope: "public", basedOn: project.stateVersion,
      body: JSON.stringify({ text: "試験用の架空の案内です。", items: [] }),
    })).toBe(true);
    const version = await env.DB.prepare("SELECT version_id FROM document_versions WHERE ward_id = ? AND project_id = ?")
      .bind(ward.wardId, project.projectId).first<{ version_id: string }>();
    if (!version) throw new Error("架空の案内がありません");
    // 本体と小さい見本を別々に保管する場合も消去する。
    await saveFlyer(env, ward.wardId, project.projectId, version.version_id, {
      current: null, image: noticeFlyerJpeg().buffer, preview: noticeFlyerJpeg().buffer,
    });
    const flyer = await getNoticeFlyer(env.DB, ward.wardId, version.version_id);
    if (!flyer?.r2_path || !flyer.preview_r2_path) throw new Error("架空のチラシがありません");
    expect(flyer.preview_r2_path).not.toBe(flyer.r2_path);
    for (const path of [flyer.r2_path, flyer.preview_r2_path]) expect(await bucket.head(path)).not.toBeNull();
    records.push({ project, flyer });
  }
  await writeDailyWardSnapshots(env, new Date("2026-11-07T00:00:00Z"));
  const deleted = records[0]!, kept = records[1]!;
  expect(await requestProjectDeletion(env.DB, ward.wardId, deleted.project.projectId)).toBe(true);
  for (let step = 0; step < 10; step++) {
    if (!(await env.DB.prepare("SELECT queue_id FROM ops_deletion_queue WHERE ward_id = ? AND target_id = ?")
      .bind(ward.wardId, deleted.project.projectId).first())) break;
    await runDeletionCron({ cron: CRON.EVERY_5_MIN } as ScheduledController, env);
  }
  expect(await env.DB.prepare("SELECT queue_id FROM ops_deletion_queue WHERE ward_id = ? AND target_id = ?")
    .bind(ward.wardId, deleted.project.projectId).first()).toBeNull();
  expect(await getNoticeFlyer(env.DB, ward.wardId, deleted.flyer.version_id)).toBeNull();
  for (const path of [deleted.flyer.r2_path!, deleted.flyer.preview_r2_path!]) expect(await bucket.head(path)).toBeNull();
  expect(await getNoticeFlyer(env.DB, ward.wardId, kept.flyer.version_id)).toEqual(kept.flyer);
  for (const path of [kept.flyer.r2_path!, kept.flyer.preview_r2_path!]) expect(await bucket.head(path)).not.toBeNull();
  const snapshot = await (await bucket.get("snapshots/daily/2026-11-07.json"))!.text();
  expect(snapshot).not.toContain(deleted.project.projectId);
  expect(snapshot).not.toContain(deleted.flyer.r2_path);
  expect(snapshot).toContain(kept.project.projectId);
  expect(snapshot).toContain(kept.flyer.r2_path);
});
