import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { createProject, getProjectState } from "../src/project/api";
import { articleParagraphs } from "../src/publish";
import { get, postForm, realApp } from "./helpers";

const docOf = (wardId: string, projectId: string, kind: string) => env.DB.prepare("SELECT d.document_id, v.version_id, v.version_no, v.body FROM documents d JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = ? ORDER BY v.version_no DESC LIMIT 1")
  .bind(wardId, projectId, kind).first<{ document_id: string; version_id: string; version_no: number; body: string }>();

it("実行委員向けの文書の紙に、ページと同じ本文を出す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の行事", year: 2026, accountId: account.accountId });
  const id = project.projectId;
  for (const [kind, title, text] of [["procedure", "進め方", "架空の手順を書いた文"], ["notice", "担当へのお知らせ", "架空の担当への知らせの文"], ["duty_roster", "当番表", "架空の当番の説明の文"]] as const) {
    await saveDocument(env.DB, ward.wardId, id, account.accountId, { kind, title, scope: "space", basedOn: (await getProjectState(env.DB, ward.wardId, id))!.project.stateVersion, body: JSON.stringify({ text, items: [] }) });
    const doc = await docOf(ward.wardId, id, kind);
    expect((await postForm(realApp, `${root}/publish/${id}/space`, { documentId: doc!.document_id, versionId: doc!.version_id, versionNo: String(doc!.version_no) }, cookie)).status).toBe(303);
    const paper = await (await get(realApp, `${root}/print/${id}/${doc!.document_id}/${doc!.version_no}/duty`, cookie)).text();
    expect(paper).toContain(text);
    expect(paper.includes("当番表と配置図")).toBe(kind === "duty_roster");
  }
});

it("知らせは本文に書かれた場所を正にして、古い項目を足し戻さない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "架空の行事", year: 2026, accountId: account.accountId });
  const id = project.projectId;
  const old = JSON.stringify({ text: "架空の行事は屋内へ変更します。", items: [{ key: "place", content: "公民館前の広場" }] });
  expect(articleParagraphs(old, undefined, "notice")).toEqual(["架空の行事は屋内へ変更します。"]);
  expect(articleParagraphs(old).join("\n")).toContain("公民館前の広場");
  expect(articleParagraphs(JSON.stringify({ text: "", items: [{ key: "place", content: "公民館前の広場" }] }), undefined, "notice").join("\n")).toContain("公民館前の広場");

  await saveDocument(env.DB, ward.wardId, id, account.accountId, { kind: "notice", title: "知らせ", scope: "public", basedOn: 0, body: JSON.stringify({ text: "雨のため変更します。", items: [{ key: "place", content: "公民館前の広場" }] }) });
  await saveDocument(env.DB, ward.wardId, id, account.accountId, { kind: "notice", title: "知らせ", scope: "public", basedOn: 0, body: JSON.stringify({ text: "雨のため屋内へ変更します。", items: [{ key: "place", content: "公民館前の広場" }] }) });
  const doc = await docOf(ward.wardId, id, "notice");
  expect(JSON.parse(doc!.body).items).toEqual([]);
  const paper = await (await get(realApp, `/${ward.slug}/admin/print/${id}/${doc!.document_id}/${doc!.version_no}/preview`, cookie)).text();
  expect(paper).toContain("雨のため屋内へ変更します。");
  expect(paper).not.toContain("公民館前の広場");
});
