import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { listHelpOffers } from "../src/answers/help";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("行事を開き直して閉じても手伝いの件数を保ち、名前を消して新しい申し込みの件数だけ足す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の記録確認会", year: 2026, accountId: account.accountId,
  });
  const base = `/${ward.slug}`;
  const closePath = `${base}/admin/close/${project.projectId}`;
  const names = ["架空 受付役", "架空 片付け役", "架空 追加の担当"];
  expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "recruitment", title: "手伝いの募集", scope: "public", basedOn: project.stateVersion,
    body: JSON.stringify({ text: "架空の会の手伝いを募集します。", items: [{ key: "helper_slots", content: "10時〜11時" }] }),
  })).toBe(true);
  const version = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM document_versions v
    JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
    WHERE v.ward_id = ? AND v.project_id = ? AND d.kind = 'recruitment'`)
    .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  if (!version) throw new Error("架空の募集がありません。");
  expect((await postForm(realApp, `${base}/admin/publish/${project.projectId}/send`, {
    documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "skip",
  }, cookie)).status).toBe(303);
  const offer = async (name: string) => {
    expect((await postForm(realApp, `${base}/help/${project.projectId}`, { helper_name: name, helper_times: "10時〜11時" })).status).toBe(200);
  };
  const close = async () => {
    expect((await postForm(realApp, `${closePath}/finalize`, {}, cookie)).status).toBe(303);
  };
  const reopen = async () => {
    expect((await postForm(realApp, `${closePath}/reopen`, {}, cookie)).status).toBe(303);
  };
  const record = async (count: number) => {
    expect(await listHelpOffers(env.DB, ward.wardId, project.projectId)).toEqual([]);
    const page = await get(realApp, `${base}/admin/archive/${project.projectId}`, cookie);
    expect(page.status).toBe(200);
    const html = await page.text();
    expect(/手伝いだけの申し込み（終わりにしたとき）: (\d+)人/.exec(html)?.[1]).toBe(String(count));
    for (const name of names) expect(html).not.toContain(name);
  };

  await offer(names[0]!);
  await offer(names[1]!);
  await close();
  await record(2);
  await reopen();
  await close();
  await record(2);
  await reopen();
  await offer(names[2]!);
  await close();
  await record(3);
  await close();
  await record(3);
});
