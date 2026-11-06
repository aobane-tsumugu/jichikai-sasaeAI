import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { getEditableDocument, saveAIDraft } from "../src/project/actions";
import { createProject, getProjectState } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("場所と雨会場を同ときに直しても、片方の変更で別の会場を書き換えず保存・配布する", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の行事", year: 2026, accountId: account.accountId,
  });
  const before = "場所: 架空会場(A)\n\n雨のとき: 架空会場(B)";
  expect(await saveAIDraft(env.DB, ward.wardId, project.projectId, "announcement", "replacement-test@1", {
    title: "架空の案内", text: before, items: [
      { key: "place", content: "架空会場(A)" },
      { key: "rain_plan", content: "架空会場(B)" },
    ],
  })).toBe(true);
  const root = `/${ward.slug}/admin`;
  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  if (!state) throw new Error("架空の行事がありません。");
  expect((await postForm(realApp, `${root}/projects/${project.projectId}/draft/announcement/save`, {
    // ブラウザの通常のフォーム送信と同じ改行形式にする。
    title: "架空の案内", scope: "public", based_on: String(state.project.stateVersion), text: before.replace(/\n/g, "\r\n"),
    item_place: "架空会場(B)", item_rain_plan: "架空会場(C)",
  }, cookie)).status).toBe(303);

  const saved = await getEditableDocument(env.DB, ward.wardId, project.projectId, "announcement");
  if (!saved) throw new Error("保存した案内がありません。");
  expect(JSON.parse(saved.body)).toMatchObject({
    text: "場所: 架空会場(B)\r\n\r\n雨のとき: 架空会場(C)",
    items: expect.arrayContaining([
      { key: "place", content: "架空会場(B)" }, { key: "rain_plan", content: "架空会場(C)" },
    ]),
  });
  const after = await getProjectState(env.DB, ward.wardId, project.projectId);
  expect(after?.items.find((item) => item.key === "place")?.current?.content).toBe("架空会場(B)");
  expect(after?.items.find((item) => item.key === "rain_plan")?.current?.content).toBe("架空会場(C)");

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
    expect(html).toContain("場所: 架空会場(B)");
    expect(html).toContain("雨のとき: 架空会場(C)");
    expect(html).not.toContain("場所: 架空会場(C)");
  }
});
