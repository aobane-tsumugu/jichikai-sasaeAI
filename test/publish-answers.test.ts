import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject, applyChange } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { replaceRoster, getRoster, listAnswers, listUnansweredByDistrict, getAnswerTotals } from "../src/answers/api";
import { checkPublicDraft } from "../src/check";
import { SETTING_KEYS } from "../src/settings/keys";
import { setSetting } from "../src/settings/store";
import { get, postForm, realApp } from "./helpers";

describe("配る画面と区のページ", () => {
  it("混入の検査結果を確認画面に出し、公開用の連絡先が空でも配れる", async () => {
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
    const response = await postForm(realApp, `/${ward.slug}/admin/publish/${project.projectId}/confirm`, {
      documentId: version!.document_id,
      versionId: version!.version_id,
      versionNo: String(version!.version_no),
      recipientScope: "member_households",
      distribution: "",
    }, cookie);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("協賛の金額と同じ数字があります");
    const sent = await postForm(realApp, `/${ward.slug}/admin/publish/${project.projectId}/send`, {
      documentId: version!.document_id,
      versionId: version!.version_id,
      versionNo: String(version!.version_no),
      stateVersion: String(version!.state_version),
      recipientScope: "member_households",
      distribution: "",
    }, cookie);
    expect(sent.status).toBe(303);
  });

  it("公開用の連絡先に載せたメールは混入として知らせない", async () => {
    const { ward, account } = await seedAdmin(env.DB);
    const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭（架空）", year: 2026, accountId: account.accountId });
    await setSetting(env.DB, ward.wardId, SETTING_KEYS.publicContact, "fixture@example.test", account.accountId);
    const body = JSON.stringify({ text: "連絡先 fixture@example.test", items: [] });
    await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
      kind: "announcement", title: "架空の案内", scope: "public", body, basedOn: project.stateVersion,
    });
    expect(await checkPublicDraft(env.DB, ward.wardId, project.projectId, "announcement", body)).toEqual([]);
  });
});

describe("名簿の取り込み", () => {
  it("54 世帯の CSV を画面の送信形式で保存できる", async () => {
    const { ward, cookie } = await seedAdmin(env.DB);
    const csv = ["番号,班,世帯名,氏名", ...Array.from({ length: 54 }, (_, index) =>
      `${index + 1},${Math.floor(index / 18) + 1}班,架空世帯 ${index + 1},架空の氏名 ${index + 1}`,
    )].join("\n");
    const form = new FormData();
    form.set("part", new File([csv], "加入世帯_2026秋.csv", { type: "text/csv" }));
    form.set("text", "");
    const response = await realApp.request(`/${ward.slug}/admin/answers/roster`, {
      method: "POST",
      headers: { accept: "application/json", origin: "http://localhost", cookie },
      body: form,
    }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: "名簿を読み込みました。" });
    expect(await getRoster(env.DB, ward.wardId)).toHaveLength(54);
  });

  it("JSON の行を受け取り、54 世帯を区ごとに保存できる", async () => {
    const { ward, cookie } = await seedAdmin(env.DB);
    const rows = [["番号", "班", "世帯名"], ...Array.from({ length: 54 }, (_, index) => [
      String(index + 1), `${Math.floor(index / 18) + 1}班`, `架空世帯 ${index + 1}`,
    ])];
    const response = await realApp.request(`/${ward.slug}/admin/answers/roster`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", origin: "http://localhost", cookie },
      body: JSON.stringify({ rows_json: JSON.stringify(rows), household_column: 2, district_column: 1 }),
    }, env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, message: "名簿を読み込みました。" });
    const roster = await getRoster(env.DB, ward.wardId);
    expect(roster).toHaveLength(54);
    expect(new Set(roster.map((entry) => entry.district))).toEqual(new Set(["1班", "2班", "3班"]));
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
    expect(await adminPage.text()).toContain("まだ答えていない世帯");
  });
});
