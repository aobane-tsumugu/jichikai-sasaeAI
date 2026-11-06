import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { getEditableDocument, saveAIDraft } from "../src/project/actions";
import { applyChange, createProject, getProjectState } from "../src/project/api";
import { reconcileDocumentBody } from "../src/project/document-body";
import type { ItemKey } from "../src/project/model";
import { get, postForm, realApp } from "./helpers";

it.each([
  { caseName: "別々の会場を順に置き換える", place: "架空会場(A)", rain: "架空会場(B)", nextPlace: "架空会場(B)", nextRain: "架空会場(C)" },
  { caseName: "同じ会場から雨のときだけ変える", place: "架空公民館", rain: "架空公民館", nextPlace: "架空公民館", nextRain: "架空体育館" },
  { caseName: "同じ会場を別々の会場に変える", place: "架空公民館", rain: "架空公民館", nextPlace: "架空集会所", nextRain: "架空体育館" },
  { caseName: "会場名の含まれる別館を保つ", place: "架空公民館", rain: "架空公民館別館", nextPlace: "架空体育館", nextRain: "架空公民館別館" },
])("$caseNameとき、別の会場を書き換えず保存・配布する", async ({ place, rain, nextPlace, nextRain }) => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の行事", year: 2026, accountId: account.accountId,
  });
  for (const [itemKey, value] of [["place", place], ["rain_plan", rain]] as const) {
    await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "item", itemKey, value, source: { kind: "person", accountId: account.accountId },
      confidence: "high", packVersion: "replacement-test@1",
    });
  }
  const before = `場所: ${place}\n\n雨のとき: ${rain}`;
  expect(await saveAIDraft(env.DB, ward.wardId, project.projectId, "announcement", "replacement-test@1", {
    title: "架空の案内", text: before, items: [
      { key: "place", content: place },
      { key: "rain_plan", content: rain },
    ],
  })).toBe(true);
  const root = `/${ward.slug}/admin`;
  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  if (!state) throw new Error("架空の行事がありません。");
  expect((await postForm(realApp, `${root}/projects/${project.projectId}/draft/announcement/save`, {
    // ブラウザの通常のフォーム送信と同じ改行形式にする。
    title: "架空の案内", scope: "public", based_on: String(state.project.stateVersion), text: before.replace(/\n/g, "\r\n"),
    item_place: nextPlace, item_rain_plan: nextRain,
  }, cookie)).status).toBe(303);

  const saved = await getEditableDocument(env.DB, ward.wardId, project.projectId, "announcement");
  if (!saved) throw new Error("保存した案内がありません。");
  expect(JSON.parse(saved.body)).toMatchObject({
    text: `場所: ${nextPlace}\r\n\r\n雨のとき: ${nextRain}`,
    items: expect.arrayContaining([
      { key: "place", content: nextPlace }, { key: "rain_plan", content: nextRain },
    ]),
  });
  const after = await getProjectState(env.DB, ward.wardId, project.projectId);
  expect(after?.items.find((item) => item.key === "place")?.current?.content).toBe(nextPlace);
  expect(after?.items.find((item) => item.key === "rain_plan")?.current?.content).toBe(nextRain);

  const version = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
    WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1`)
    .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!version) throw new Error("配る案内がありません。");
  expect((await postForm(realApp, `${root}/publish/${project.projectId}/send`, {
    documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "skip",
  }, cookie)).status).toBe(303);
  for (const path of [
    `/${ward.slug}/p/${project.projectId}`,
    `${root}/print/${project.projectId}/${version.document_id}/${version.version_no}/announcement`,
  ]) {
    const html = await (await get(realApp, path, cookie)).text();
    expect(html).toContain(`場所: ${nextPlace}`);
    expect(html).toContain(`雨のとき: ${nextRain}`);
    expect(html).not.toContain(`場所: ${nextRain}`);
  }
});

it("同じ会場名のどちらを指すか分からない本文は変えず、直した項目だけを既存の案内に渡す", () => {
  const previous = { text: "架空公民館で開きます。雨でも架空公民館を使います。", items: [
    { key: "place" as const, content: "架空公民館" }, { key: "rain_plan" as const, content: "架空公民館" },
  ] };
  const checks: ItemKey[] = [];
  const result = reconcileDocumentBody(previous, { text: previous.text, items: [
    { key: "place", content: "架空公民館" }, { key: "rain_plan", content: "架空体育館" },
  ] }, checks);
  expect(result.text).toBe(previous.text);
  expect(result.items[1]?.content).toBe("架空体育館");
  expect(checks).toEqual(["rain_plan"]);
});

it("同じ元の会場があっても、手で直した本文の会場と説明をそのまま保つ", () => {
  const previous = { text: "場所: 架空公民館\n雨のとき: 架空公民館", items: [
    { key: "place" as const, content: "架空公民館" }, { key: "rain_plan" as const, content: "架空公民館" },
  ] };
  const text = "場所: 架空公民館\n雨のとき: 架空体育館\n入口は東側です。";
  const checks: ItemKey[] = [];
  const result = reconcileDocumentBody(previous, { text, items: [
    { key: "place", content: "架空公民館" }, { key: "rain_plan", content: "架空体育館" },
  ] }, checks);
  expect(result.text).toBe(text);
  expect(result.items).toHaveLength(2);
  expect(checks).toEqual([]);
});
