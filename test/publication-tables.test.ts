import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { addAnswer } from "../src/answers/api";
import { seedAdmin, seedWard } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { applyChange, createProject } from "../src/project/api";
import type { RowData } from "../src/project/model";
import { createInvite, getSpaceMaterials, openSpace } from "../src/space/api";
import { cookieFrom, get, postForm, realApp } from "./helpers";

it("配った当番・配置・協賛先は直しても変わらず、配り直すと変わり、閉じると手伝いだけの人数が残る", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: FIRST_SLICE.nextYearTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
  });
  const id = project.projectId;
  const admin = `/${ward.slug}/admin`;
  const spacePath = `/${ward.slug}/space/${id}`;
  const source = { kind: "person" as const, accountId: account.accountId };
  const change = async (table: "duties" | "layout" | "sponsors", data: RowData) => {
    expect((await applyChange(env.DB, ward.wardId, id, {
      kind: "row", table, data, source, confidence: "high", packVersion: "publication-tables-test@1",
    })).status).toBe("applied");
  };
  await change("duties", { slot: FIRST_SLICE.helperTime, assignee: FIRST_SLICE.phoneHelper });
  await change("layout", { spot: FIRST_SLICE.layoutSpot, position: FIRST_SLICE.layoutPosition });
  await change("sponsors", { name: FIRST_SLICE.sponsorName, reply: "yes", amount: FIRST_SLICE.sponsorAmount });
  await openSpace(env.DB, ward.wardId, id, FIRST_SLICE.passphrase, account.accountId);
  const token = await createInvite(env.DB, ward.wardId, id, "member", null, account.accountId, true);
  const entered = await get(realApp, `${spacePath}/person/${token}`);
  const memberCookie = cookieFrom(entered, `space_${id}`);
  if (!memberCookie) throw new Error("班長が空間に入れません。");
  const before = await (await get(realApp, spacePath, memberCookie)).text();
  expect(before).toContain("まだ配っていません。");
  expect(before).not.toContain(FIRST_SLICE.phoneHelper);
  expect(before).not.toContain(FIRST_SLICE.layoutPosition);
  expect(before).not.toContain(FIRST_SLICE.sponsorName);

  expect(await saveDocument(env.DB, ward.wardId, id, account.accountId, {
    kind: "duty_roster", title: FIRST_SLICE.dutyTitle, scope: "space", basedOn: 0,
    body: JSON.stringify({ text: FIRST_SLICE.dutyText, items: [] }),
  })).toBe(true);
  const latest = async () => {
    const row = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM document_versions v
      JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
      WHERE v.ward_id = ? AND v.project_id = ? AND d.kind = 'duty_roster' ORDER BY v.version_no DESC LIMIT 1`)
      .bind(ward.wardId, id).first<{ document_id: string; version_id: string; version_no: number }>();
    if (!row) throw new Error("当番表がありません。");
    return row;
  };
  const first = await latest();
  const distribute = (version: Awaited<ReturnType<typeof latest>>) => postForm(realApp, `${admin}/publish/${id}/space`, {
    documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no),
  }, cookie);
  expect((await distribute(first)).status).toBe(303);
  expect(await (await get(realApp, `/${ward.slug}/p/${id}`)).text()).not.toContain(FIRST_SLICE.dutyText);
  const paperPath = (version: Awaited<ReturnType<typeof latest>>) => `${admin}/print/${id}/${version.document_id}/${version.version_no}/duty`;
  const originalPaper = await (await get(realApp, paperPath(first), cookie)).text();
  expect(originalPaper).toContain(FIRST_SLICE.phoneHelper);
  expect(originalPaper).toContain(FIRST_SLICE.layoutPosition);

  await change("duties", { slot: FIRST_SLICE.helperTime, assignee: FIRST_SLICE.requestedBy });
  await change("layout", { spot: FIRST_SLICE.layoutSpot, position: FIRST_SLICE.previousPlace });
  await change("sponsors", { name: FIRST_SLICE.sponsorName, reply: "no", ask: FIRST_SLICE.reportText });
  const unchanged = await (await get(realApp, spacePath, memberCookie)).text();
  expect(unchanged).toContain(FIRST_SLICE.phoneHelper);
  expect(unchanged).toContain(FIRST_SLICE.layoutPosition);
  expect(unchanged).toContain("可");
  expect(unchanged).not.toContain(FIRST_SLICE.requestedBy);
  expect(unchanged).not.toContain(FIRST_SLICE.reportText);
  expect(await (await get(realApp, paperPath(first), cookie)).text()).toBe(originalPaper);
  expect(await (await get(realApp, `${admin}/publish/${id}`, cookie)).text())
    .toContain("配ったときから表が変わっています。今の表を配り直せます。");

  // 文書を手で保存し直さなくても、同じ所から今の表を配り直せる。
  expect((await distribute(first)).status).toBe(303);
  const second = await latest();
  expect(second.version_no).toBe(first.version_no + 1);
  const changed = await (await get(realApp, spacePath, memberCookie)).text();
  expect(changed).toContain(FIRST_SLICE.requestedBy);
  expect(changed).toContain(FIRST_SLICE.previousPlace);
  expect(changed).not.toContain(FIRST_SLICE.reportText);
  expect(changed).toContain("不可");
  expect(changed).not.toContain(FIRST_SLICE.amountNotPublished);
  expect(changed).not.toContain(FIRST_SLICE.phoneHelper);
  const newPaper = await (await get(realApp, paperPath(second), cookie)).text();
  expect(newPaper).toContain(FIRST_SLICE.requestedBy);
  expect(newPaper).toContain(FIRST_SLICE.previousPlace);
  expect(newPaper).not.toContain(FIRST_SLICE.phoneHelper);
  expect(await (await get(realApp, paperPath(first), cookie)).text()).toBe(originalPaper);
  expect(await (await get(realApp, `${admin}/publish/${id}`, cookie)).text()).not.toContain("今の表を配り直せます。");
  const otherWard = await seedWard(env.DB);
  expect((await getSpaceMaterials(env.DB, otherWard.wardId, id, null)).tablesPublished).toBe(false);

  // 保存を始める前の配布は、今の表で補わない。
  await env.DB.prepare("UPDATE document_versions SET tables_snapshot = NULL WHERE ward_id = ? AND project_id = ? AND version_id = ?")
    .bind(ward.wardId, id, first.version_id).run();
  const oldPaper = await (await get(realApp, paperPath(first), cookie)).text();
  expect(oldPaper).toContain("配った時の表の記録がありません。");
  expect(oldPaper).not.toContain(FIRST_SLICE.requestedBy);

  // 記録の画面でも、配った後に直した当番を混ぜない。
  await change("duties", { slot: FIRST_SLICE.helperTime, assignee: FIRST_SLICE.firstOfficer });
  await addAnswer(env.DB, ward.wardId, {
    projectId: id, household: FIRST_SLICE.firstHousehold, district: FIRST_SLICE.district,
    peopleCount: 2, source: "phone", helperName: FIRST_SLICE.phoneHelper, helperTimes: FIRST_SLICE.helperTime,
  });
  await env.DB.prepare(`INSERT INTO project_help_offers (offer_id, ward_id, project_id, name, times, created_at)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), ward.wardId, id, FIRST_SLICE.sheetHelper, FIRST_SLICE.helperTime, new Date().toISOString()).run();
  expect((await postForm(realApp, `${admin}/close/${id}/finalize`, {}, cookie)).status).toBe(303);
  expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM project_help_offers WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, id).first()).toEqual({ count: 0 });
  const archive = await (await get(realApp, `${admin}/archive/${id}`, cookie)).text();
  expect(archive).toContain(FIRST_SLICE.requestedBy);
  expect(archive).toContain(FIRST_SLICE.previousPlace);
  expect(archive).not.toContain(FIRST_SLICE.firstOfficer);
  expect(archive).toContain("手伝いだけの申し込み（閉じた時）: 1 人");
  expect(archive).toContain("参加人数 2 人 / 手伝いの申し出 1 件");
  expect(archive).not.toContain(FIRST_SLICE.sheetHelper);
  expect((await get(realApp, spacePath, memberCookie)).status).toBe(403);
});
