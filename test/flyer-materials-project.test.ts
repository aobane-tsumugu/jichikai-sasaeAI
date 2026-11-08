import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { flyerMaterials } from "../src/draft/notice-flyers";
import { createProject } from "../src/project/api";
import { noticeFlyerJpeg } from "./fixtures/notice-flyer";

it("前提 21: 住民に出す画像の候補に、どの準備の資料にも入っていない写真（年賀状や予約票など）を並べない", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "年末の見回り", year: 2026, accountId: account.accountId });
  const add = async (name: string, projectId: string | null) => {
    const job = crypto.randomUUID(), original = crypto.randomUUID(), now = new Date().toISOString(), path = `originals/${original}.jpg`;
    await new WardBucket(env.ORIGINALS, ward.wardId).put(path, noticeFlyerJpeg());
    await env.DB.prepare("INSERT INTO jobs (ward_id, job_id, project_id, via, created_at, updated_at) VALUES (?, ?, ?, 'admin', ?, ?)").bind(ward.wardId, job, projectId, now, now).run();
    await env.DB.prepare(`INSERT INTO originals (ward_id, original_id, job_id, position, kind, content_hash, media_type, filename, byte_size, r2_path, received_at)
      VALUES (?, ?, ?, 1, 'photo', ?, 'image/jpeg', ?, ?, ?, ?)`).bind(ward.wardId, original, job, original, name, noticeFlyerJpeg().byteLength, path, now).run();
    return original;
  };
  const used = await add("去年の見回りの写真.jpg", project.projectId);
  await add("年賀状.jpg", null);
  expect((await flyerMaterials(env, ward.wardId, project.projectId)).map((photo) => photo.original_id)).toEqual([used]);
});
