import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { replaceRoster } from "../src/answers/api";
import { seedAdmin } from "../src/core/testing";
import { createProject, getProjectState } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("名簿を減らして当番を作り直すと未編集の余分な行が外れ、役員の入力と配った表は残る", async () => {
  // 名簿、行事と担当はすべて試験用の架空のもの。
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const roster = [1, 2, 3, 4].map((number) => ({ household: `架空の世帯${number}`, district: "1班" }));
  await replaceRoster(env.DB, ward.wardId, roster, { household: 0, district: 1 });
  const project = await createProject(env.DB, ward.wardId, {
    kind: "duty", title: "架空の清掃当番", year: 2026, accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin`;
  const draft = `${root}/projects/${project.projectId}/draft/duty_roster`;
  expect((await postForm(realApp, `${draft}/start`, {}, cookie)).status).toBe(303);
  const initial = await getProjectState(env.DB, ward.wardId, project.projectId);
  const rows = initial!.tables.duties.filter((row) => row.scope === "current");
  expect(rows.map((row) => row.data.assignee)).toEqual(roster.map((entry) => entry.household));
  const edited = rows[3]!;
  expect((await postForm(realApp, `${root}/projects/${project.projectId}/draft/duty-row/${edited.rowId}`, {
    slot: "夜の確認", task: "架空の持ち場", assignee: roster[3]!.household, attendance: "no_change",
  }, cookie)).status).toBe(303);
  const before = await getProjectState(env.DB, ward.wardId, project.projectId);
  expect((await postForm(realApp, `${draft}/save`, {
    title: "架空の当番表", scope: "space", text: "試験用の架空の当番です。", based_on: String(before!.project.stateVersion),
  }, cookie)).status).toBe(303);
  const version = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
    WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1`)
    .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!version) throw new Error("架空の当番表の下書きがありません。");
  expect((await postForm(realApp, `${root}/publish/${project.projectId}/space`, {
    documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no),
  }, cookie)).status).toBe(303);
  const published = () => env.DB.prepare("SELECT tables_snapshot FROM document_versions WHERE ward_id = ? AND version_id = ?")
    .bind(ward.wardId, version.version_id).first<string>("tables_snapshot");
  const publishedBefore = await published();
  expect(publishedBefore).toContain(roster[2]!.household);

  const other = await createProject(env.DB, ward.wardId, {
    kind: "duty", title: "別の架空の当番", year: 2026, accountId: account.accountId,
  });
  expect((await postForm(realApp, `${root}/projects/${other.projectId}/draft/duty_roster/start`, {}, cookie)).status).toBe(303);
  const otherBefore = await getProjectState(env.DB, ward.wardId, other.projectId);
  await replaceRoster(env.DB, ward.wardId, roster.slice(0, 2), { household: 0, district: 1 });
  expect((await postForm(realApp, `${draft}/start`, {}, cookie)).status).toBe(303);
  const refreshed = await getProjectState(env.DB, ward.wardId, project.projectId);
  const current = refreshed!.tables.duties.filter((row) => row.scope === "current");
  expect(current.map((row) => row.data.assignee)).toEqual([roster[0]!.household, roster[1]!.household, roster[3]!.household]);
  expect(current.find((row) => row.rowId === edited.rowId)?.data).toEqual(before!.tables.duties.find((row) => row.rowId === edited.rowId)?.data);
  expect((await getProjectState(env.DB, ward.wardId, other.projectId))?.tables.duties).toEqual(otherBefore?.tables.duties);
  expect(await published()).toBe(publishedBefore);
  const html = await (await get(realApp, draft, cookie)).text();
  expect(html).not.toContain(roster[2]!.household);
  expect(html).toContain("夜の確認");

  // 名簿へ戻した世帯は一度だけ入り、残した役員の行は書き換えない。
  await replaceRoster(env.DB, ward.wardId, roster.slice(0, 3), { household: 0, district: 1 });
  expect((await postForm(realApp, `${draft}/start`, {}, cookie)).status).toBe(303);
  const restored = await getProjectState(env.DB, ward.wardId, project.projectId);
  expect(restored!.tables.duties.filter((row) => row.scope === "current").map((row) => row.data.assignee).sort())
    .toEqual(roster.map((entry) => entry.household));
});
