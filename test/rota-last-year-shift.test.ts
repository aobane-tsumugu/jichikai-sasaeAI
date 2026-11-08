import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { applyChange, createProject } from "../src/project/api";
import { compareRota, shiftSlots } from "../src/rota/store";

it("去年の表の日を、今年の当日に合わせてずらし、曜日も今年の物にする", () => {
  expect(shiftSlots(["12月26日（金）", "12月27日（土） 午後8時", "12月28日（日）"], "2026-12-26", 2025))
    .toEqual({ slots: ["12月26日（土）", "12月27日（日） 午後8時", "12月28日（月）"], shifted: true });
  expect(shiftSlots(["2025-12-30", "2026-01-02"], "2026-12-29", 2025)).toEqual({ slots: ["2026-12-29", "2027-01-01"], shifted: true });
  expect(shiftSlots(["12月26日（金）"], undefined, 2025)).toEqual({ slots: ["12月26日（金）"], shifted: false });
});

it("試しの期間の終わりを、先にずらした始まりの日と取り違えずに動かす", () => {
  expect(shiftSlots(["12月26日〜12月27日 午後8時"], "2026-12-27", 2025))
    .toEqual({ slots: ["12月27日（日）〜12月28日（月） 午後8時"], shifted: true });
});

it("試しの欄に同じ日が二度あっても、それぞれに今年の曜日を一つだけ添える", () => {
  expect(shiftSlots(["12月26日 午前・12月26日 午後"], "2026-12-26", 2025))
    .toEqual({ slots: ["12月26日（土） 午前・12月26日（土） 午後"], shifted: true });
});

it("世帯の名簿が無い時は、去年の当番表の世帯を外さずに残し、日は今年の当日に合わせる", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "duty", title: "年末の見回り", year: 2026, accountId: account.accountId, eventDay: "2026-12-26" });
  const got = await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "admin", parts: [
    { kind: "text", filename: "去年の見回りの当番表.txt", mediaType: "text/plain", bytes: new TextEncoder().encode("去年の見回りの当番表") },
  ] });
  const ref = got.received[0]!.originalId;
  for (const [slot, task, assignee] of [["12月26日（金）", "1班", "佐藤、田中"], ["12月27日（土）", "3班", "高橋、伊藤"]] as const) {
    await applyChange(env.DB, ward.wardId, project.projectId, { kind: "row", table: "duties", data: { slot, task, assignee }, confidence: "high", packVersion: "test@1",
      source: { kind: "original", ref, year: 2025, locator: "当番表" } });
  }
  const proposal = await compareRota(env.DB, ward.wardId, project.projectId);
  expect(proposal?.comparison).toMatchObject({ hasPreviousTable: true, noRoster: true, shifted: true, removed: [] });
  expect(proposal?.comparison.entries.map((entry) => [entry.data.slot, entry.data.assignee, entry.explanation])).toEqual([
    ["12月26日（土）", "佐藤、田中", ""], ["12月27日（日）", "高橋、伊藤", ""],
  ]);
});
