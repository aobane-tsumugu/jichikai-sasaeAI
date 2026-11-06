import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { listHelpOffers } from "../src/answers/help";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { createProject, getProjectState } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("次の下書きを役員向けにしても配った募集で申し込め、区のページから下げると受付を終える", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の行事", year: 2026, accountId: account.accountId,
  });
  const base = `/${ward.slug}`;
  const helpPath = `${base}/help/${project.projectId}`;
  const publishedTime = "10時〜11時";
  const privateTime = "13時〜14時";
  expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "recruitment", title: "架空の手伝い募集", scope: "public", basedOn: project.stateVersion,
    body: JSON.stringify({ text: "配った架空の手伝い募集", items: [{ key: "helper_slots", content: publishedTime }] }),
  })).toBe(true);
  const version = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
    WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1`)
    .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!version) throw new Error("配る募集がありません。");
  expect((await postForm(realApp, `${base}/admin/publish/${project.projectId}/send`, {
    documentId: version.document_id, versionId: version.version_id,
    versionNo: String(version.version_no), lineDelivery: "skip",
  }, cookie)).status).toBe(303);

  const state = await getProjectState(env.DB, ward.wardId, project.projectId);
  if (!state) throw new Error("架空の行事がありません。");
  expect((await postForm(realApp, `${base}/admin/projects/${project.projectId}/draft/recruitment/save`, {
    title: "まだ配っていない役員向けの募集", scope: "staff", based_on: String(state.project.stateVersion),
    text: "役員だけで作り直している内容", item_helper_slots: privateTime,
  }, cookie)).status).toBe(303);
  const form = await (await get(realApp, helpPath)).text();
  expect(form).toContain("配った架空の手伝い募集");
  expect(form).toContain(`value="${publishedTime}"`);
  expect(form).not.toContain("役員だけで作り直している内容");
  expect(form).not.toContain(privateTime);
  expect(await (await get(realApp, `${base}/`)).text()).toContain(`href="${base}/help"`);
  const offered = await postForm(realApp, helpPath, { helper_name: "架空の手伝いさん", helper_times: publishedTime });
  expect(offered.status).toBe(200);
  expect(await offered.text()).toContain("申し込みを受け付けました");
  expect(await listHelpOffers(env.DB, ward.wardId, project.projectId)).toEqual([
    expect.objectContaining({ name: "架空の手伝いさん", times: publishedTime }),
  ]);

  const publicationId = await env.DB.prepare("SELECT publication_id FROM publication_records WHERE ward_id = ? AND version_id = ?")
    .bind(ward.wardId, version.version_id).first<string>("publication_id");
  if (!publicationId) throw new Error("配った募集の記録がありません。");
  expect((await postForm(realApp, `${base}/admin/publish/${project.projectId}/lower/${publicationId}`, {}, cookie)).status).toBe(303);
  expect(await (await get(realApp, helpPath)).text()).toContain("手伝いの受付は終わりました。");
  expect((await postForm(realApp, helpPath, { helper_name: "受付あとの架空の申し出", helper_times: publishedTime })).status).toBe(400);
  expect(await listHelpOffers(env.DB, ward.wardId, project.projectId)).toHaveLength(1);
});
