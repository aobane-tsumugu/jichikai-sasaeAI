import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { newId } from "../src/core/ids";
import { seedAccount, seedWard } from "../src/core/testing";
import { copySeed } from "../src/archive/index";
import { applyChange, createProject, getProjectState } from "../src/project/api";

const db = env.DB;

describe("閉じるとこれをもとに新しく始める", () => {
  it("終わったものには中身を書けない", async () => {
    const ward = await seedWard(db);
    const account = await seedAccount(db, ward.wardId, "架空の役員");
    const project = await createProject(db, ward.wardId, { kind: "event", title: "架空の行事", year: 2026, accountId: account.accountId });
    await db.prepare("UPDATE projects SET closed_at = ?, closed_by_account_id = ? WHERE ward_id = ? AND project_id = ?")
      .bind("2026-11-05T00:00:00.000Z", account.accountId, ward.wardId, project.projectId).run();
    const result = await applyChange(db, ward.wardId, project.projectId, {
      kind: "item", itemKey: "content", value: "閉じたあとの書き込み", source: { kind: "person", accountId: account.accountId },
      confidence: "high", packVersion: "close-test@1",
    });
    expect(result).toEqual({ status: "rejected", reason: "closed" });
  });

  it("去年のやることと今年の中身を種に複写し、行事の日に時期を置き直す", async () => {
    const ward = await seedWard(db);
    const account = await seedAccount(db, ward.wardId, "架空の役員");
    const source = await createProject(db, ward.wardId, {
      kind: "event", title: "架空の行事", year: 2026, eventDay: "2026-10-24", accountId: account.accountId,
    });
    await applyChange(db, ward.wardId, source.projectId, {
      kind: "item", itemKey: "place", value: "架空の会場", source: { kind: "person", accountId: account.accountId },
      confidence: "high", packVersion: "seed-test@1", requestId: newId(),
    });
    await db.prepare("UPDATE projects SET closed_at = ? WHERE ward_id = ? AND project_id = ?")
      .bind("2026-11-05T00:00:00.000Z", ward.wardId, source.projectId).run();
    const next = await createProject(db, ward.wardId, {
      kind: source.kind, title: "架空の行事", year: 2027, eventDay: "2027-10-23", seedProjectId: source.projectId, accountId: account.accountId,
    });
    await copySeed(db, ward.wardId, source.projectId, next.projectId, source.year, "2027-10-23");
    const state = await getProjectState(db, ward.wardId, next.projectId);
    expect(state?.project.projectId).toBe(next.projectId);
    expect(state?.items.find((item) => item.key === "place")?.references[0]?.content).toBe("架空の会場");
    expect(state?.mapTasks.find((task) => task.taskKey === "day")?.periodStart).toBe("2027-10-23");
  });
});
