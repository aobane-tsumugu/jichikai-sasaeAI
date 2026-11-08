import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { createProject, applyChange } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { replaceRoster, getRoster, listAnswers, listUnansweredByDistrict, getAnswerTotals } from "../src/answers/api";
import { checkPublicDraft } from "../src/check";
import { SETTING_KEYS } from "../src/settings/keys";
import { getPublicContact, getSquads, setSetting } from "../src/settings/store";
import { get, postForm, realApp } from "./helpers";

describe("知らせる画面と住民向けのページ", () => {
  it("班・名簿・公開用の連絡先が空の一年目でも、確認結果を読んで配れる", async () => {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId });
    expect(await getSquads(env.DB, ward.wardId)).toEqual([]);
    expect(await getRoster(env.DB, ward.wardId)).toEqual([]);
    expect(await getPublicContact(env.DB, ward.wardId)).toBe("");
    await applyChange(env.DB, ward.wardId, project.projectId, {
      kind: "row", table: "sponsors", data: { name: "協賛先A", amount: 6500 },
      source: { kind: "person", accountId: account.accountId }, confidence: "high", packVersion: "publish-test@1",
    });
    const body = JSON.stringify({ text: "協賛先Aから6500円の協賛があります", items: [
      { key: "date_time", content: "2026年11月14日10時" }, { key: "place", content: "試しの公民館" },
    ] });
    await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
      kind: "announcement", title: "案内", scope: "public", body, basedOn: project.stateVersion + 1,
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
      recipientScope: "all_households", allCopies: "1", lineDelivery: "skip", distribution: "",
    }, cookie);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("協賛の金額と同じ数字があります");
    const sent = await postForm(realApp, `/${ward.slug}/admin/publish/${project.projectId}/send`, {
      documentId: version!.document_id,
      versionId: version!.version_id,
      versionNo: String(version!.version_no),
      stateVersion: String(version!.state_version),
      recipientScope: "all_households", allCopies: "1", lineDelivery: "skip", distribution: "",
    }, cookie);
    expect(sent.status).toBe(303);
  });

  it("公開用の連絡先に載せたメールは混入として知らせない", async () => {
    const { ward, account } = await seedAdmin(env.DB);
    const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId });
    await setSetting(env.DB, ward.wardId, SETTING_KEYS.publicContact, "fixture@example.test", account.accountId);
    const body = JSON.stringify({ text: "連絡先fixture@example.test", items: [{ key: "public_contact", content: "fixture@example.test" }] });
    await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
      kind: "announcement", title: "案内", scope: "public", body, basedOn: project.stateVersion,
    });
    expect(await checkPublicDraft(env.DB, ward.wardId, project.projectId, "announcement", body)).toEqual([]);
  });
});

describe("名簿の取り込み", () => {
  it("54世帯のCSVを画面の送信形式で保存できる", async () => {
    const { ward, cookie } = await seedAdmin(env.DB);
    const csv = ["番号,班,世帯名,氏名", ...Array.from({ length: 54 }, (_, index) =>
      `${index + 1},${Math.floor(index / 18) + 1}班,世帯${index + 1},試しの氏名${index + 1}`,
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
    const donePath = `/${ward.slug}/admin/answers/roster?done=1`;
    expect(await response.json()).toEqual({ ok: true, message: "名簿を読み込みました。", redirectTo: donePath });
    expect(await getRoster(env.DB, ward.wardId)).toHaveLength(54);
    const done = await get(realApp, donePath, cookie);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("54世帯、3班の名簿を入れました");
  });

  it("JSONの行を受け取り、54世帯を自治会ごとに保存できる", async () => {
    const { ward, cookie } = await seedAdmin(env.DB);
    const rows = [["番号", "班", "世帯名"], ...Array.from({ length: 54 }, (_, index) => [
      String(index + 1), `${Math.floor(index / 18) + 1}班`, `世帯${index + 1}`,
    ])];
    const response = await realApp.request(`/${ward.slug}/admin/answers/roster`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", origin: "http://localhost", cookie },
      body: JSON.stringify({ rows_json: JSON.stringify(rows), household_column: 2, district_column: 1 }),
    }, env);
    expect(response.status).toBe(200);
    const donePath = `/${ward.slug}/admin/answers/roster?done=1`;
    expect(await response.json()).toEqual({ ok: true, message: "名簿を読み込みました。", redirectTo: donePath });
    const roster = await getRoster(env.DB, ward.wardId);
    expect(roster).toHaveLength(54);
    expect(new Set(roster.map((entry) => entry.district))).toEqual(new Set(["1班", "2班", "3班"]));
    const done = await get(realApp, donePath, cookie);
    expect(done.status).toBe(200);
    expect(await done.text()).toContain("54世帯、3班の名簿を入れました");
  });
});

describe("答えの入口と一覧", () => {
  it("Webと電話の返事を数え、名簿からまだ答えていないを出す", async () => {
    const { ward, account, cookie } = await seedAdmin(env.DB);
    const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "秋の収穫祭", year: 2026, accountId: account.accountId });
    await replaceRoster(env.DB, ward.wardId, [
      { household: "一世帯", district: "一班" },
      { household: "二世帯", district: "一班" },
    ], { household: 0, district: 1 });
    expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
      kind: "announcement", title: "案内", scope: "public", basedOn: project.stateVersion,
      body: JSON.stringify({ text: "試しの秋の収穫祭に参加する人数を答えてください。", items: [
        { key: "date_time", content: "2026年11月14日10時" }, { key: "place", content: "試しの公民館" },
      ] }),
    })).toBe(true);
    const version = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no, p.state_version
      FROM document_versions v JOIN projects p ON p.ward_id = v.ward_id AND p.project_id = v.project_id
      WHERE v.ward_id = ? AND v.project_id = ? ORDER BY v.version_no DESC LIMIT 1`)
      .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number; state_version: number }>();
    expect(version).not.toBeNull();
    expect((await postForm(realApp, `/${ward.slug}/admin/publish/${project.projectId}/send`, {
      documentId: version!.document_id, versionId: version!.version_id, versionNo: String(version!.version_no),
      stateVersion: String(version!.state_version), lineDelivery: "skip",
    }, cookie)).status).toBe(303);
    const publicPage = await get(realApp, `/${ward.slug}/answer/${project.projectId}`);
    expect(publicPage.status).toBe(200);
    const web = await postForm(realApp, `/${ward.slug}/answer/${project.projectId}`, {
      household: "一世帯", district: "一班", children_count: "1", adults_count: "2", seniors_count: "0", helper_name: "", helper_times: "",
    });
    expect(web.status).toBe(200);
    const phone = await postForm(realApp, `/${ward.slug}/admin/answers/${project.projectId}/phone`, {
      household: "電話世帯", district: "一班", children_count: "0", adults_count: "2", seniors_count: "0", helper_name: "手伝い希望者", helper_times: "受付",
    }, cookie);
    expect(phone.status).toBe(303);
    const answers = await listAnswers(env.DB, ward.wardId, project.projectId);
    expect(answers.map((answer) => answer.source).sort()).toEqual(["phone", "web"]);
    expect(await getAnswerTotals(env.DB, ward.wardId, project.projectId)).toEqual({ people: 5, helperRequests: 1 });
    expect(await listUnansweredByDistrict(env.DB, ward.wardId, project.projectId)).toEqual([
      { district: "一班", households: ["二世帯"] },
    ]);
    const adminPage = await get(realApp, `/${ward.slug}/admin/answers/${project.projectId}`, cookie);
    expect(adminPage.status).toBe(200);
    expect(await adminPage.text()).toContain("まだ返事のない世帯");
  });
});
