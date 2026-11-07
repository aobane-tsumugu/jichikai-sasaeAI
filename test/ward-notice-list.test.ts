import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { createProject, type DocumentKind } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

it("区の一覧は知らせのある行事の古い日時と場所を足さず、別の行事と取り下げ後の案内を保つ", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}`;
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の会場変更のある会", year: 2099, accountId: account.accountId });
  const other = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の会場変更のない会", year: 2099, accountId: account.accountId });
  const oldPlace = "架空の変更前の会館";
  const oldDate = "2099年10月11日9時";
  const otherPlace = "架空の変更のない広場";
  const otherDate = "2099年10月12日10時";
  const publish = async (target: typeof project, kind: DocumentKind, place: string, dateTime: string) => {
    expect(await saveDocument(env.DB, ward.wardId, target.projectId, account.accountId, {
      kind, title: "架空の配布文書", scope: "public", basedOn: target.stateVersion,
      body: JSON.stringify({ text: kind === "notice" ? "会場を架空の新しい集会室へ変えました。" : "架空の案内です。",
        items: [{ key: "place", content: place }, { key: "date_time", content: dateTime }] }),
    })).toBe(true);
    const row = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM document_versions v
      JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
      WHERE v.ward_id = ? AND v.project_id = ? AND d.kind = ? ORDER BY v.version_no DESC LIMIT 1`)
      .bind(ward.wardId, target.projectId, kind).first<{ document_id: string; version_id: string; version_no: number }>();
    if (!row) throw new Error("架空の配布文書がありません。");
    expect((await postForm(realApp, `${root}/admin/publish/${target.projectId}/send`, {
      documentId: row.document_id, versionId: row.version_id, versionNo: String(row.version_no), lineDelivery: "skip",
    }, cookie)).status).toBe(303);
    return row.document_id;
  };
  const home = async () => {
    const response = await get(realApp, `${root}/`);
    expect(response.status).toBe(200);
    return response.text();
  };
  await publish(project, "announcement", oldPlace, oldDate);
  await publish(other, "announcement", otherPlace, otherDate);
  let html = await home();
  expect(html).toContain(oldPlace);
  expect(html).toContain(oldDate);
  const noticeId = await publish(project, "notice", oldPlace, oldDate);
  html = await home();
  expect(html).not.toContain(oldPlace);
  expect(html).not.toContain(oldDate);
  expect(html).toContain(otherPlace);
  expect(html).toContain(otherDate);
  expect(html).toContain(`href="${root}/p/${project.projectId}"`);
  expect(html).toContain(project.title);
  expect(html).toContain("に載せました");

  const record = await env.DB.prepare(`SELECT publication_id FROM publication_records
    WHERE ward_id = ? AND project_id = ? AND document_id = ? AND unpublished_at IS NULL`)
    .bind(ward.wardId, project.projectId, noticeId).first<{ publication_id: string }>();
  if (!record) throw new Error("架空の知らせの配布記録がありません。");
  expect((await postForm(realApp, `${root}/admin/publish/${project.projectId}/lower/${record.publication_id}`, {}, cookie)).status).toBe(303);
  html = await home();
  expect(html).toContain(oldPlace);
  expect(html).toContain(oldDate);
  expect(html).toContain(otherPlace);
  expect(html).toContain(otherDate);
});
