import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject, applyChange } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { replaceRoster, listAnswers, listUnansweredByDistrict, getAnswerTotals } from "../src/answers/api";
import { get, postForm, realApp } from "./helpers";

describe("配る画面と区のページ", () => {
  it("公開の案に協賛の額が混ざる時は配布を止め、役員画面から確認できる", async () => {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭（架空）", year: 2026, accountId: account.accountId });
    await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "row", table: "sponsors", data: { name: "協賛先A（架空）", amount: 6500 },
      source: { kind: "person", accountId: account.accountId }, confidence: "high", packVersion: "publish-test@1",
    });
    const body = JSON.stringify({ text: "当日は6500円の協賛があります", items: [] });
    await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
      kind: "announcement", title: "架空の案内", scope: "public", body, basedOn: project.stateVersion + 1,
    });
    const version = await env.DB.prepare(`SELECT d.document_id, v.version_id, v.version_no, p.state_version
      FROM documents d JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
      JOIN projects p ON p.ward_id = d.ward_id AND p.project_id = d.project_id
      WHERE d.ward_id = ? AND d.project_id = ? AND d.kind = 'announcement'`)
      .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number; state_version: number }>();
    expect(version).not.toBeNull();
    const response = await postForm(realApp, `/${ward.slug}/admin/publish/${project.projectId}/send`, {
      documentId: version!.document_id,
      versionId: version!.version_id,
      versionNo: String(version!.version_no),
      stateVersion: String(version!.state_version),
      recipientScope: "member_households",
      distribution: "",
    }, cookie);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("協賛の額");
    const page = await get(realApp, `/${ward.slug}/admin/publish/${project.projectId}`, cookie);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("配る内容を確認する");
  });
});

describe("回答の入口と一覧", () => {
  it("Web と電話の回答を数え、名簿から未回答を出す", async () => {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭（架空）", year: 2026, accountId: account.accountId });
    await replaceRoster(env.DB, ward.wardId, [
      { household: "一世帯（架空）", district: "一班" },
      { household: "二世帯（架空）", district: "一班" },
    ], { household: 0, district: 1 });
    const publicPage = await get(realApp, `/${ward.slug}/answer/${project.projectId}`);
    expect(publicPage.status).toBe(200);
    const web = await postForm(realApp, `/${ward.slug}/answer/${project.projectId}`, {
      household: "一世帯（架空）", district: "一班", people_count: "3", helper_name: "", helper_times: "",
    });
    expect(web.status).toBe(200);
    const phone = await postForm(realApp, `/${ward.slug}/admin/answers/${project.projectId}/phone`, {
      household: "電話世帯（架空）", district: "一班", people_count: "2", helper_name: "手伝い希望者（架空）", helper_times: "受付",
    }, cookie);
    expect(phone.status).toBe(303);
    const answers = await listAnswers(env.DB, ward.wardId, project.projectId);
    expect(answers.map((answer) => answer.source).sort()).toEqual(["phone", "web"]);
    expect(await getAnswerTotals(env.DB, ward.wardId, project.projectId)).toEqual({ people: 5, helperRequests: 1 });
    expect(await listUnansweredByDistrict(env.DB, ward.wardId, project.projectId)).toEqual([
      { district: "一班", households: ["二世帯（架空）"] },
    ]);
    const adminPage = await get(realApp, `/${ward.slug}/admin/answers/${project.projectId}`, cookie);
    expect(adminPage.status).toBe(200);
    expect(await adminPage.text()).toContain("未回答（班ごと）");
  });
});
