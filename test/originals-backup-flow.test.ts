import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { PROVIDER_CONTACT_FIXTURE } from "../fixtures/provider-contact";
import { backupStatus, runBackupCron } from "../src/archive/backup";
import { writeDailyWardSnapshots } from "../src/archive/snapshot";
import { deleteContact } from "../src/contact/delete";
import { appendMessage, CONTACT_WARD, contactById, receiveContact } from "../src/contact/store";
import { CRON } from "../src/core/cron";
import { WardBucket } from "../src/core/storage";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { withdrawJob } from "../src/intake/store";
import { requestProjectDeletion, requestWardDeletion, runDeletionCron } from "../src/ops/lifecycle";
import { createProject } from "../src/project/api";

it("架空の原本と写しを別に保管し、失敗後に続け、取り下げ・受付・行事・区の消去も両方へ反映する", async () => {
  if (!env.ORIGINALS_BACKUP) throw new Error("試験用の別の保管先がありません");
  const { ward, account } = await seedAdmin(env.DB);
  const w = ward.wardId;
  const project = await createProject(env.DB, w, { kind: "event", title: "架空の保管確認会", year: 2026, accountId: account.accountId });
  const received = await receive(env, {
    wardId: w, projectId: project.projectId, via: "admin", accountId: account.accountId,
    parts: Array.from({ length: 7 }, (_, i) => ({ kind: "text" as const, filename: `架空の資料${i}.txt`,
      mediaType: "text/plain", bytes: new TextEncoder().encode(`${PROVIDER_CONTACT_FIXTURE.more}${i}`) })),
  });
  const primary = new WardBucket(env.ORIGINALS, w);
  const backup = new WardBucket(env.ORIGINALS_BACKUP, w);
  const provider = new WardBucket(env.ORIGINALS, CONTACT_WARD);
  const providerBackup = new WardBucket(env.ORIGINALS_BACKUP, CONTACT_WARD);
  const contact = await receiveContact(env.DB, { kind: "access", ...PROVIDER_CONTACT_FIXTURE });
  const kept = await receiveContact(env.DB, { kind: "usage", ...PROVIDER_CONTACT_FIXTURE });
  const row = await contactById(env.DB, contact.id);
  if (!row) throw new Error("架空の受付を作れませんでした");
  await appendMessage(env, row, "person", PROVIDER_CONTACT_FIXTURE.more,
    new File([PROVIDER_CONTACT_FIXTURE.more], "架空の添付.jpg", { type: "image/jpeg" }));
  const photo = await env.DB.prepare("SELECT photo_key FROM provider_contact_messages WHERE ward_id = ? AND contact_id = ? AND photo_key IS NOT NULL")
    .bind(CONTACT_WARD, contact.id).first<{ photo_key: string }>();
  if (!photo) throw new Error("架空の添付を作れませんでした");
  const day = new Date("2026-11-07T00:00:00Z");
  const tick = { cron: CRON.EVERY_5_MIN } as ScheduledController;
  const daily = { cron: CRON.DAILY } as ScheduledController;
  const snapshotKey = "snapshots/daily/2026-11-07.json";
  await writeDailyWardSnapshots(env, day);

  async function finishBackup(at: Date) {
    for (let step = 0; step < 80; step++) {
      await runBackupCron(tick, env, at);
      const active = await env.DB.batch([w, CONTACT_WARD].map((id) => env.DB.prepare(
        "SELECT ward_id FROM archive_backup_state WHERE ward_id = ? AND completed_day < requested_day",
      ).bind(id)));
      if (active.every((result) => result.results.length === 0)) return;
    }
    throw new Error("架空の保管の続きが終わりませんでした");
  }
  async function finishDeletion(id: string) {
    for (let step = 0; step < 100; step++) {
      await runDeletionCron(tick, env);
      const queued = await env.DB.prepare("SELECT state FROM ops_deletion_queue WHERE ward_id = ? LIMIT 1")
        .bind(id).first<{ state: string }>();
      expect(queued?.state).not.toBe("error");
      if (!queued) return;
    }
    throw new Error("架空の消去の続きが終わりませんでした");
  }

  await runBackupCron(daily, env, day);
  const progress = await env.DB.prepare("SELECT cursor, phase FROM archive_backup_state WHERE ward_id = ?")
    .bind(w).first<{ cursor: string | null; phase: string }>();
  expect(progress?.phase).toBe("copy");
  expect(progress?.cursor).toEqual(expect.any(String));
  const failedPut = vi.spyOn(env.ORIGINALS_BACKUP, "put").mockRejectedValueOnce(new Error("架空の停止"));
  try { await runBackupCron(tick, env, day); } finally { failedPut.mockRestore(); }
  expect((await backupStatus(env, [w]))?.failures).toBe(1);
  await finishBackup(day);
  expect(await backupStatus(env, [w])).toMatchObject({ failures: 0, lastCopiedAt: expect.any(String) });
  for (const original of received.received) {
    const key = `originals/${original.originalId}`;
    expect(await (await backup.get(key))!.text()).toBe(await (await primary.get(key))!.text());
  }
  expect(await (await providerBackup.get(photo.photo_key))!.text()).toBe(PROVIDER_CONTACT_FIXTURE.more);
  expect(await (await backup.get(snapshotKey))!.text()).toBe(await (await primary.get(snapshotKey))!.text());

  // 翌日の照合では、既に複写した原本の本体を読み直さない。
  const reads = vi.spyOn(env.ORIGINALS, "get");
  try {
    const tomorrow = new Date("2026-11-08T00:00:00Z");
    await runBackupCron(daily, env, tomorrow);
    await finishBackup(tomorrow);
    expect(reads).not.toHaveBeenCalled();
  } finally { reads.mockRestore(); }
  const { ORIGINALS_BACKUP: omitted, ...withoutBackup } = env;
  expect(omitted).toBeDefined();
  await runBackupCron(daily, withoutBackup, day);
  expect(await backupStatus(withoutBackup, [w])).toBeNull();

  // 元の場所だけを失っても、DBが指す本体と別の場所だけにある写しを失わない。
  const missingKey = `originals/${received.received[0]!.originalId}`;
  await primary.delete(missingKey);
  await primary.delete(snapshotKey);
  const later = new Date("2026-11-09T00:00:00Z");
  await runBackupCron(daily, env, later);
  await finishBackup(later);
  expect(await backup.head(missingKey)).not.toBeNull();
  expect(await backup.head(snapshotKey)).not.toBeNull();
  expect(await withdrawJob(env, w, received.jobId!)).toBe(true);
  await finishDeletion(w);
  for (const original of received.received) expect(await backup.head(`originals/${original.originalId}`)).toBeNull();
  expect(await (await backup.get(snapshotKey))!.text()).not.toContain(received.received[0]!.originalId);

  // 提供側の受付も、過去の写しと別の場所だけの写しから同じ受付だけを除く。
  const providerOnlyKey = "snapshots/daily/2026-11-06.json";
  await providerBackup.put(providerOnlyKey, await (await provider.get(snapshotKey))!.text());
  expect(await deleteContact(env, contact.id)).toBe("deleted");
  await finishDeletion(CONTACT_WARD);
  expect(await providerBackup.head(photo.photo_key)).toBeNull();
  for (const store of [provider, providerBackup]) {
    for (const key of [snapshotKey, providerOnlyKey]) {
      const snapshot = await store.get(key);
      if (!snapshot) throw new Error("書き直した写しがありません");
      const text = await snapshot.text();
      expect(text).not.toContain(contact.id);
      expect(text).toContain(kept.id);
    }
  }
  await writeDailyWardSnapshots(env, day);
  expect(await (await providerBackup.get(snapshotKey))!.text()).not.toContain(contact.id);

  await requestProjectDeletion(env.DB, w, project.projectId);
  await finishDeletion(w);
  expect(await (await backup.get(snapshotKey))!.text()).not.toContain(project.projectId);
  const other = await seedAdmin(env.DB);
  const otherBackup = new WardBucket(env.ORIGINALS_BACKUP, other.ward.wardId);
  await otherBackup.put("originals/fixture", PROVIDER_CONTACT_FIXTURE.more);
  await backup.put("originals/backup-only", PROVIDER_CONTACT_FIXTURE.more);
  await requestWardDeletion(env.DB, w);
  await finishDeletion(w);
  expect((await backup.list("")).keys).toHaveLength(0);
  expect((await primary.list("")).keys).toHaveLength(0);
  expect(await (await otherBackup.get("originals/fixture"))!.text()).toBe(PROVIDER_CONTACT_FIXTURE.more);
  expect(await providerBackup.head(snapshotKey)).not.toBeNull();
});
