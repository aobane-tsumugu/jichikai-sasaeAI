import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE } from "../fixtures/first-slice";
import { seedAdmin } from "../src/core/testing";
import { createProject } from "../src/project/api";
import { get, postForm, realApp, withEnv } from "./helpers";

it("入口の四つから進み、市の通知を知らせに保存して通常の配る画面から紙とWebに出せる", async () => {
  // 外部には接続せず、送信前に LINE を呼んでいないことも確かめる。
  const request = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
  vi.stubGlobal("fetch", request);
  try {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    const bindings = withEnv({ LINE_CHANNEL_ACCESS_TOKEN: "fixture-line-token" });
    const root = `/${ward.slug}/admin`;
    const home = await get(realApp, `${root}/`, cookie, bindings);
    expect(home.status).toBe(200);
    const homeHtml = await home.text();
    expect(homeHtml).toContain("去年の資料を送ってください");
    expect(homeHtml).toContain(`href="${root}/intake">去年の資料を送る</a>`);
    expect(homeHtml).toContain(`href="${root}/projects">資料がないので、種類を選んで始める</a>`);

    const project = await createProject(env.DB, ward.wardId, {
      kind: "city_request", title: FIRST_SLICE.draftTitle, year: FIRST_SLICE.eventYear, accountId: account.accountId,
    });
    const cityPath = `${root}/requests/city/${project.projectId}`;
    const cityPage = await get(realApp, cityPath, cookie, bindings);
    expect(cityPage.status).toBe(200);
    const cityHtml = await cityPage.text();
    expect(cityHtml).toContain("配る画面へ進む");
    expect(cityHtml).not.toContain("公式LINEで配る");
    // 古い画面から operation=send を送っても、その場では送らない。
    const prepared = await postForm(realApp, cityPath, {
      operation: "send", noticeBody: FIRST_SLICE.publicAnnouncement,
      submittedWhat: FIRST_SLICE.draftTitle, submittedTo: FIRST_SLICE.wardName, submittedOn: "2026-11-05",
    }, cookie, bindings);
    expect(prepared.status).toBe(303);
    const publishPath = `${root}/publish/${project.projectId}`;
    expect(prepared.headers.get("location")).toBe(publishPath);
    expect(request).not.toHaveBeenCalled();
    const version = await env.DB.prepare(`SELECT d.document_id, d.kind, d.scope, d.stale_since_version,
        v.version_id, v.version_no, v.body, v.published_at, v.based_on_state_version, p.state_version
      FROM documents d JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
      JOIN projects p ON p.ward_id = d.ward_id AND p.project_id = d.project_id
      WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = 'notice'`)
      .bind(ward.wardId, project.projectId).first<{
        document_id: string; kind: string; scope: string; stale_since_version: number | null;
        version_id: string; version_no: number; body: string; published_at: string | null;
        based_on_state_version: number; state_version: number;
      }>();
    expect(version).toMatchObject({ kind: "notice", scope: "public", published_at: null, stale_since_version: null });
    if (!version) throw new Error("知らせが保存されていません");
    expect(JSON.parse(version.body)).toMatchObject({ text: FIRST_SLICE.publicAnnouncement });
    expect(version.based_on_state_version).toBe(version.state_version);
    const before = await env.DB.prepare("SELECT COUNT(*) AS n FROM publication_records WHERE ward_id = ? AND project_id = ?")
      .bind(ward.wardId, project.projectId).first<{ n: number }>();
    expect(before?.n).toBe(0);
    const publishPage = await get(realApp, publishPath, cookie, bindings);
    expect(publishPage.status).toBe(200);
    expect(await publishPage.text()).toContain("配る内容を見る");
    const form = {
      documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "skip",
    };
    const confirmation = await postForm(realApp, `${publishPath}/confirm`, form, cookie, bindings);
    expect(confirmation.status).toBe(200);
    expect(await confirmation.text()).toContain(FIRST_SLICE.publicAnnouncement);
    expect((await postForm(realApp, `${publishPath}/send`, form, cookie, bindings)).status).toBe(303);
    const record = await env.DB.prepare("SELECT line_status FROM publication_records WHERE ward_id = ? AND project_id = ? AND document_id = ?")
      .bind(ward.wardId, project.projectId, version.document_id).first<{ line_status: string }>();
    expect(record?.line_status).toBe("not_sent");
    const publicPage = await get(realApp, `/${ward.slug}/p/${project.projectId}`);
    expect(publicPage.status).toBe(200);
    expect(await publicPage.text()).toContain(FIRST_SLICE.publicAnnouncement);
    const printPage = await get(realApp, `${root}/print/${project.projectId}/${version.document_id}/${version.version_no}/announcement`, cookie, bindings);
    expect(printPage.status).toBe(200);
    expect(await printPage.text()).toContain(FIRST_SLICE.publicAnnouncement);
    expect(request.mock.calls.every(([input]) => !String(input).includes("/message/broadcast"))).toBe(true);
  } finally {
    vi.unstubAllGlobals();
  }
});
