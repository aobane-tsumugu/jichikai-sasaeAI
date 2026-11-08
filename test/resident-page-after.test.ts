import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { createProject } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";

async function publish(wardSlug: string, wardId: string, projectId: string, documentKind: "announcement" | "report", cookie: string) {
  const doc = await env.DB.prepare(`SELECT d.document_id, v.version_id, v.version_no FROM documents d JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = ? ORDER BY v.version_no DESC LIMIT 1`).bind(wardId, projectId, documentKind).first<{ document_id: string; version_id: string; version_no: number }>();
  const res = await postForm(realApp, `/${wardSlug}/admin/publish/${projectId}/send`, { documentId: doc!.document_id, versionId: doc!.version_id, versionNo: String(doc!.version_no), recipientScope: "member_households", lineDelivery: "skip" }, cookie);
  expect(res.status).toBe(303);
}

it("自治会の連絡先が空の時は、出ている案内の連絡先で補い、終わった行事は報告を先に出す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId });
  await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, { kind: "announcement", title: "案内", scope: "public", basedOn: 0,
    body: JSON.stringify({ text: "秋の収穫祭を行います。", items: [{ key: "public_contact", content: "収穫祭の係 000-0000-0000" }] }) });
  await publish(ward.slug, ward.wardId, project.projectId, "announcement", cookie);
  const top = await (await get(realApp, `/${ward.slug}/`)).text();
  expect(top).toContain("収穫祭の係 000-0000-0000");
  expect(top).not.toContain("連絡先が分からないときは、班長か役員にお知らせください。");
  expect(await (await get(realApp, `/${ward.slug}/privacy`)).text()).toContain("収穫祭の係 000-0000-0000");
  expect(await (await get(realApp, `/${ward.slug}/line`)).text()).toContain("収穫祭の係 000-0000-0000");
  // 役員のトップも、住民向けのページに実際に出ている連絡先を書く（「班長か役員に」とだけ出ているとは書かない）。
  const adminTop = await (await get(realApp, `/${ward.slug}/admin/`, cookie)).text();
  expect(adminTop).toContain("住民向けのページには、案内に書いた連絡先「収穫祭の係 000-0000-0000」を出しています。");
  expect(adminTop).not.toContain("とだけ出ていて");

  await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, { kind: "report", title: "報告", scope: "public", basedOn: 0,
    body: JSON.stringify({ text: "秋の収穫祭には、80人が来てくれました。", items: [] }) });
  await publish(ward.slug, ward.wardId, project.projectId, "report", cookie);
  const page = await (await get(realApp, `/${ward.slug}/p/${project.projectId}`)).text();
  expect(page).toMatch(/<h1>秋の収穫祭の報告<\/h1>/);
  expect(page.indexOf("80人が来てくれました")).toBeLessThan(page.indexOf("<h2>前に出した案内</h2>"));
  expect(page).not.toContain("<h2>くわしい案内</h2>");
});

it("紙を印刷する画面は、見出しに準備の名前を入れ、配る紙が無い時は案内の下書きへの道を出す。記入欄は自治会のLINEにも送れると書く", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "防災訓練", year: 2026, accountId: account.accountId });
  const root = `/${ward.slug}/admin`;
  const list = await (await get(realApp, `${root}/print/${project.projectId}`, cookie)).text();
  expect(list).toContain("<h1>防災訓練の紙を印刷する</h1>");
  expect(list).toContain("防災訓練の案内はまだ書いていないので、配る紙はまだありません。");
  expect(list).toContain(`href="${root}/projects/${project.projectId}/draft/announcement">案内の下書きを書く</a>`);
  const meeting = await (await get(realApp, `${root}/print/${project.projectId}/paper/meeting`, cookie)).text();
  expect(meeting).toContain("自治会のLINEに送ってください。");
  expect(meeting).toContain("に印刷しました");
});

it("元の資料の画面は、AIが読み取った文と表を出し、「前の画面で直せます」と書かない", async () => {
  const { receive } = await import("../src/intake/receive");
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "年末の見回り", year: 2026, accountId: account.accountId });
  const got = await receive(env, { wardId: ward.wardId, projectId: project.projectId, via: "admin", parts: [
    { kind: "file", filename: "見回りの当番表.pdf", mediaType: "application/pdf", bytes: new TextEncoder().encode("%PDF-1.4 fictional rota") },
  ] });
  const originalId = got.received[0]!.originalId;
  const body = { document_kind: "rota", original_years: [], summary: "去年の見回りの当番表。", text_blocks: [{ original_id: originalId, locator: "1行目", text: "2025年度 年末の見回り 当番表" }], fields: [],
    tables: [{ name: "見回りの当番", original_id: originalId, locator: "見回りの当番", columns: [], rows: [{ cells: ["12月26日（金）", "1班", "佐藤、田中"], locator: "3行目", confidence: "high" }] }], decisions: [], unreadable: [] };
  await env.DB.prepare("INSERT INTO readings (reading_id, ward_id, job_id, source, pack_version, model, body, created_at) VALUES (?, ?, ?, 'direct', 'test@1', 'fixture', ?, ?)")
    .bind(crypto.randomUUID(), ward.wardId, got.jobId, JSON.stringify(body), new Date().toISOString()).run();
  const page = await (await get(realApp, `/${ward.slug}/admin/intake/originals/${originalId}`, cookie)).text();
  expect(page).toContain("<summary>AIが読み取った文</summary>");
  expect(page).toContain("<td>12月26日（金）</td><td>1班</td><td>佐藤、田中</td>");
  expect(page).not.toContain("前の画面で直せます");
  expect(page).toContain("年末の見回りの届いた資料と今年の内容</a>で直せます。");
});
