import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { replaceRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import type { RowData } from "../src/project/model";
import { householdHistory } from "../src/rota/history";
import { get, postForm, realApp } from "./helpers";

it("複数で担当した当番を各世帯で読み返せ、同名の世帯は推測して選ばない", async () => {
  // 名前、班、当番と日付は試験用の試しのもの。
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const first = { household: "甲", district: "1班" };
  const second = { household: "乙", district: "1班" };
  const sameNames = ["1班", "2班"].map((district) => ({ household: "同名", district }));
  await replaceRoster(env.DB, ward.wardId, [first, second, ...sameNames], { household: 0, district: 1 });
  const project = await createProject(env.DB, ward.wardId, {
    kind: "duty", title: "試しの清掃当番", year: 2026, eventDay: "2026-11-08", accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin`;
  const source = { kind: "person" as const, accountId: account.accountId };
  const tasks: RowData[] = [
    { slot: "午前", task: "試しの会場準備", assignee: `${first.household}、${second.household}`, attendance: "present" },
    { slot: "午後", task: "試しの単独当番", assignee: first.household },
    { slot: "夕方", task: "試しの同名の担当", assignee: sameNames[0]!.household },
  ];
  for (const data of tasks) {
    expect((await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "row", table: "duties", data, source, confidence: "high", packVersion: "fictional-history@1",
    })).status).toBe("applied");
  }
  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  if (!state) throw new Error("試しの当番がありません");
  expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "duty_roster", scope: "space", title: "試しの当番表", basedOn: state.project.stateVersion,
    body: JSON.stringify({ text: "試験用の試しの当番表です。", items: [] }),
  })).toBe(true);
  const document = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
    WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1`).bind(ward.wardId, project.projectId)
    .first<{ document_id: string; version_id: string; version_no: number }>();
  if (!document) throw new Error("試しの当番表がありません");
  expect((await postForm(realApp, `${root}/publish/${project.projectId}/space`, {
    documentId: document.document_id, versionId: document.version_id, versionNo: String(document.version_no),
  }, cookie)).status).toBe(303);
  // 配った表にない、あとから手で記録した当番も読み返す。
  expect((await applyChange(env.DB, ward.wardId, project.projectId, {
    kind: "row", table: "duties", data: { slot: "夜", task: "試しの片付け", assignee: `${first.household}／${second.household}`, attendance: "absent" },
    source, confidence: "high", packVersion: "fictional-history@1",
  })).status).toBe("applied");
  await env.DB.prepare("UPDATE projects SET closed_at = ? WHERE ward_id = ? AND project_id = ?")
    .bind("2026-11-09T00:00:00.000Z", ward.wardId, project.projectId).run();

  const history = await householdHistory(env.DB, ward.wardId);
  for (const [entry, count] of [[first, 3], [second, 2]] as const) {
    const household = history.find((item) => item.household === entry.household && item.district === entry.district);
    expect(household?.records).toHaveLength(count);
    expect(household?.records).toEqual(expect.arrayContaining([
      expect.objectContaining({ who: entry.household, what: "試しの清掃当番 / 午前 / 試しの会場準備", detail: "出席の記録あり" }),
      expect.objectContaining({ who: entry.household, what: "試しの清掃当番 / 夜 / 試しの片付け", detail: "欠席の記録あり" }),
    ]));
  }
  expect(history.find((item) => item.household === first.household)?.records)
    .toContainEqual(expect.objectContaining({ what: "試しの清掃当番 / 午後 / 試しの単独当番", detail: "担当の記録。実施したかの記録はありません。" }));
  for (const entry of sameNames) {
    expect(history.find((item) => item.household === entry.household && item.district === entry.district)?.records).toEqual([]);
  }
  expect(history.find((item) => item.district === "世帯を特定できない記録")?.records)
    .toEqual([expect.objectContaining({ who: sameNames[0]!.household, what: "試しの清掃当番 / 夕方 / 試しの同名の担当" })]);

  const page = await get(realApp, `${root}/rota/history`, cookie);
  expect(page.status).toBe(200);
  const sections = (await page.text()).match(/<details\b[^>]*>[\s\S]*?<\/details>/g) ?? [];
  for (const entry of [first, second]) {
    const section = sections.find((html) => html.includes(`<summary>${entry.district} ${entry.household}（`));
    expect(section).toContain("試しの会場準備");
    expect(section).toContain("試しの片付け");
    expect(section).toContain(`${root}/archive/${project.projectId}`);
  }
});

it("履歴の名前照合も名簿とそろえ、空白や英字の違いで世帯を誤って選ばない", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  // 名前と当番は試験用の試しのもの。同名の世帯は班だけが違う。
  const first = { household: "甲", district: "1班" };
  const second = { household: "Alice", district: "1班" };
  const ambiguous = [{ household: " 同名", district: "1班" }, { household: "同名", district: "2班" }];
  await replaceRoster(env.DB, ward.wardId, [first, second, ...ambiguous], { household: 0, district: 1 });
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "試しの会場準備", year: 2026, accountId: account.accountId,
  });
  expect((await applyChange(env.DB, ward.wardId, project.projectId, {
    kind: "row", table: "duties", data: { slot: "午前", task: "試しの受付", assignee: " 甲、ALICE、同名" },
    source: { kind: "person", accountId: account.accountId }, confidence: "high", packVersion: "fictional-history@1",
  })).status).toBe("applied");

  const history = await householdHistory(env.DB, ward.wardId);
  for (const entry of [first, second]) {
    expect(history.find((item) => item.household === entry.household && item.district === entry.district)?.records)
      .toEqual([expect.objectContaining({ projectId: project.projectId, what: "試しの会場準備 / 午前 / 試しの受付" })]);
  }
  for (const entry of ambiguous) {
    expect(history.find((item) => item.household === entry.household && item.district === entry.district)?.records).toEqual([]);
  }
  expect(history.find((item) => item.district === "世帯を特定できない記録")?.records)
    .toEqual([expect.objectContaining({ who: "同名", projectId: project.projectId })]);
});
