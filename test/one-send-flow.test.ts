import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { createProject, getProjectSummary } from "../src/project/api";
import { get, postForm, realApp, sendLatest } from "./helpers";

const published = async (wardId: string, projectId: string) => (await env.DB.prepare("SELECT COUNT(*) AS n FROM publication_records WHERE ward_id = ? AND project_id = ?").bind(wardId, projectId).first<{ n: number }>())?.n ?? 0;

it("L-319: 下書きの「送る」はそのまま送らず、送る前の確かめの画面で、住民向けのページ、LINE、紙を一度に見せてから送る", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId, eventDay: "2026-01-10" });
  const draft = await (await get(realApp, `${root}/projects/${project.projectId}/draft/notice?edit=1`, cookie)).text();
  expect(draft).toContain('name="after" value="send">送る</button>');
  expect(draft).not.toContain('name="lineDelivery"');
  const stateVersion = (await getProjectSummary(env.DB, ward.wardId, project.projectId))!.stateVersion;
  const sent = await postForm(realApp, `${root}/projects/${project.projectId}/draft/notice/save`, {
    title: "持ち物のお知らせ", text: "マイバッグを持ってきてください。", scope: "public", based_on: String(stateVersion), after: "send", flyer_choice: "none",
  }, cookie);
  expect(sent.status).toBe(303);
  expect(sent.headers.get("location")).toContain(`${root}/publish/${project.projectId}/confirm?`);
  expect(await published(ward.wardId, project.projectId)).toBe(0);
  const confirm = await (await get(realApp, sent.headers.get("location")!, cookie)).text();
  expect(confirm).toContain("住民向けのページに載ります。");
  expect(confirm).toContain("自治会のLINE");
  expect(confirm).toContain("紙を");
  expect(confirm).toContain(">住民に知らせる</button>");
  expect((await sendLatest(ward.slug, ward.wardId, project.projectId, "notice", cookie)).status).toBe(303);
  expect(await published(ward.wardId, project.projectId)).toBe(1);
});

it("L-319: 終わりにする画面は報告を配らず、報告はほかの連絡と同じ確かめの画面から、LINE の決まりも同じで送る", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId, eventDay: "2026-01-10" });
  expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, { kind: "report", title: "実施報告", scope: "public", basedOn: 0,
    body: JSON.stringify({ text: "80人が来てくれました。", items: [] }) })).toBe(true);
  const close = await (await get(realApp, `${root}/close/${project.projectId}`, cookie)).text();
  expect(close).not.toContain('id="report-public"');
  expect(close).toContain("報告を見て送る</a>");
  expect(close).toContain("住民への報告は送らずに終わります");
  // 報告の確かめの画面にも、ほかの連絡と同じく LINE の行が出る（報告は LINE に送れる種類）。
  const report = await env.DB.prepare("SELECT document_id FROM documents WHERE ward_id = ? AND project_id = ? AND kind = 'report'").bind(ward.wardId, project.projectId).first<{ document_id: string }>();
  const confirm = await (await get(realApp, `${root}/publish/${project.projectId}/confirm?documentId=${report!.document_id}`, cookie)).text();
  expect(confirm).toContain("自治会のLINE");
  // 送らずに終わりにしても、報告は配られない。
  expect((await postForm(realApp, `${root}/close/${project.projectId}/finalize`, {}, cookie)).status).toBe(303);
  expect(await published(ward.wardId, project.projectId)).toBe(0);
  expect(await (await get(realApp, `${root}/close/${project.projectId}`, cookie)).text()).toContain("住民への報告は送っていません。");
});
