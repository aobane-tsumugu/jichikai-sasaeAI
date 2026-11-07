import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { searchArchive } from "../src/archive/search";
import { seedAdmin } from "../src/core/testing";
import { saveDocument } from "../src/project/actions";
import { projectDirectory } from "../src/intake/project-port";
import { photoMatchCandidates } from "../src/line/photo-context";
import { createProject, getProjectSummary, listProjects } from "../src/project/api";
import { getOrCreateWardNotices } from "../src/project/state";
import { get, postForm, realApp } from "./helpers";

it("U91: 準備がない自治会で連絡事項を作って送り、同じ年の入れ物を使い続ける", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const year = Number(new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 4));
  const picker = await get(realApp, `${root}/messages/new`, cookie);
  expect(picker.status).toBe(200);
  const html = await picker.text();
  expect(html).toContain("連絡事項");
  expect(html).toContain("どの準備でもない");
  expect(html).toContain(`action="${root}/messages"`);
  expect(html).not.toContain("住民へのメッセージは、準備ごとに作ります");
  // 開いただけでは入れ物を作らず、連絡事項以外を選んでも作らない。
  const refused = await postForm(realApp, `${root}/messages`, { kind: "announcement", projectId: "ward-notices" }, cookie);
  expect(refused.status).toBe(400);
  expect(await refused.text()).toContain("連絡事項を選んでください");
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE ward_id = ?").bind(ward.wardId).first<{ n: number }>())?.n).toBe(0);

  const start = await postForm(realApp, `${root}/messages`, { kind: "notice", projectId: "ward-notices" }, cookie);
  expect(start.status).toBe(303);
  const bucket = await env.DB.prepare("SELECT project_id, title, year, closed_at FROM projects WHERE ward_id = ? AND is_ward_notices = 1")
    .bind(ward.wardId).first<{ project_id: string; title: string; year: number; closed_at: string | null }>();
  expect(bucket).toMatchObject({ title: "自治会からの連絡", year, closed_at: null });
  const id = bucket!.project_id;
  const draftPath = start.headers.get("location")!;
  expect(draftPath).toContain(`${root}/projects/${id}/draft/notice?edit=1`);
  const draft = await (await get(realApp, draftPath, cookie)).text();
  expect(draft).toContain('name="after" value="send">住民に送る</button>');
  expect(draft).not.toContain("雨の変更を知らせる</h1>");

  const send = async (title: string, text: string) => {
    const project = await getProjectSummary(env.DB, ward.wardId, id);
    const response = await postForm(realApp, `${root}/projects/${id}/draft/notice/save`, {
      title, text, scope: "public", based_on: String(project!.stateVersion),
      after: "send", lineDelivery: "skip", flyer_choice: "none",
    }, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toContain(`${root}/publish/${id}`);
  };
  await send("架空のごみの出し方のお知らせ", "架空のごみの出し方が変わります。指定の袋を使ってください。");
  const publicPage = await (await get(realApp, `/${ward.slug}/p/${id}`)).text();
  expect(publicPage).toContain("自治会からの連絡");
  expect(publicPage).toContain("指定の袋を使ってください");
  expect(await (await get(realApp, `/${ward.slug}/`)).text()).toContain("自治会からの連絡");
  const hits = await searchArchive(env.DB, ward.wardId, { query: "指定の袋" });
  expect(hits).toHaveLength(1);
  expect(hits[0]).toMatchObject({ project_id: id, title: "自治会からの連絡", year });

  // 一覧を読む実際の画面と資料の候補に入れ物は出ない。
  for (const path of ["/", "/year", "/projects/today", "/projects", "/close/activity", "/archive", "/answers"]) {
    const page = await get(realApp, `${root}${path}`, cookie);
    expect(page.status, path).toBe(200);
    expect(await page.text(), path).not.toContain("自治会からの連絡");
  }
  expect((await listProjects(env.DB, ward.wardId, { includeClosed: true })).some((project) => project.projectId === id)).toBe(false);
  expect((await projectDirectory().listOpen(env.DB, ward.wardId)).some((project) => project.projectId === id)).toBe(false);
  expect((await photoMatchCandidates(env.DB, ward.wardId)).some((project) => project.id === id)).toBe(false);
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM project_map_tasks WHERE ward_id = ? AND project_id = ?").bind(ward.wardId, id).first<{ n: number }>())?.n).toBe(0);
  // 保存したURLや直接のPOSTでも、終わりにする処理を始めない。
  expect((await get(realApp, `${root}/close/${id}`, cookie)).headers.get("location")).toBe(`${root}/messages/new`);
  for (const action of ["prepare", "finalize"]) {
    const response = await postForm(realApp, `${root}/close/${id}/${action}`, {}, cookie);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${root}/messages/new`);
  }
  expect((await getProjectSummary(env.DB, ward.wardId, id))?.closedAt).toBeNull();

  const again = await postForm(realApp, `${root}/messages`, { kind: "notice", projectId: "ward-notices" }, cookie);
  expect(again.headers.get("location")).toContain(`/projects/${id}/draft/notice?edit=1`);
  await send("架空の鍵の預け先のお知らせ", "架空の集会所の鍵の預け先が変わりました。利用する前に役員に聞いてください。");
  expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE ward_id = ? AND year = ? AND is_ward_notices = 1")
    .bind(ward.wardId, year).first<{ n: number }>())?.n).toBe(1);
  const nextPage = await (await get(realApp, `/${ward.slug}/p/${id}`)).text();
  expect(nextPage).toContain("鍵の預け先が変わりました");
  expect(nextPage).toContain("指定の袋を使ってください");
  expect((await searchArchive(env.DB, ward.wardId, { query: "鍵の預け先" }))[0]?.project_id).toBe(id);

  const nextYear = await getOrCreateWardNotices(env.DB, ward.wardId, year + 1, account.accountId);
  expect(nextYear.projectId).not.toBe(id);
  expect((await getProjectSummary(env.DB, ward.wardId, id))?.closedAt).toBeNull();
  expect(await (await get(realApp, `/${ward.slug}/p/${id}`)).text()).toContain("指定の袋を使ってください");
});

it("U91: 検索にも残す連絡事項を一度だけ知らせ、古い下書きは知らせない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await getOrCreateWardNotices(env.DB, ward.wardId, 2026, account.accountId);
  for (const text of ["架空の変更前の連絡です。", "架空の変更後の連絡です。"]) {
    expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
      kind: "notice", title: "架空の連絡事項", scope: "public", basedOn: project.stateVersion,
      body: JSON.stringify({ text, items: [] }),
    })).toBe(true);
  }
  const versions = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
    WHERE ward_id = ? AND project_id = ? ORDER BY version_no`)
    .bind(ward.wardId, project.projectId).all<{ document_id: string; version_id: string; version_no: number }>();
  expect(versions.results).toHaveLength(2);
  const send = (version: (typeof versions.results)[number]) => postForm(realApp,
    `/${ward.slug}/admin/publish/${project.projectId}/send`, {
      documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "skip",
    }, cookie);
  const records = () => env.DB.prepare(`SELECT version_id, line_status FROM publication_records
    WHERE ward_id = ? AND project_id = ?`).bind(ward.wardId, project.projectId)
    .all<{ version_id: string; line_status: string }>();
  const entries = () => env.DB.prepare(`SELECT content FROM archive_search_entries WHERE ward_id = ? AND project_id = ?`)
    .bind(ward.wardId, project.projectId).all<{ content: string }>();

  expect((await send(versions.results[0]!)).status).toBe(409);
  expect((await records()).results).toHaveLength(0);
  expect((await entries()).results).toHaveLength(0);
  const latest = versions.results[1]!;
  expect((await send(latest)).status).toBe(303);
  expect((await records()).results).toEqual([{ version_id: latest.version_id, line_status: "not_sent" }]);
  const indexed = (await entries()).results;
  expect(indexed).toHaveLength(1);
  expect(indexed[0]!.content).toContain("架空の変更後の連絡です。");
  expect((await send(latest)).status).toBe(404);
  expect((await records()).results).toEqual([{ version_id: latest.version_id, line_status: "not_sent" }]);
  expect((await entries()).results).toEqual(indexed);
});

it("U91: 同時作成でも自治会と年ごとに一つだけ持ち、通常の準備は一覧に残す", async () => {
  const local = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const normal = await createProject(env.DB, local.ward.wardId, { kind: "event", title: "架空の秋の清掃", year: 2026 });
  const [first, second] = await Promise.all([
    getOrCreateWardNotices(env.DB, local.ward.wardId, 2026, local.account.accountId),
    getOrCreateWardNotices(env.DB, local.ward.wardId, 2026, local.account.accountId),
  ]);
  expect(second.projectId).toBe(first.projectId);
  const foreign = await getOrCreateWardNotices(env.DB, other.ward.wardId, 2026, other.account.accountId);
  expect(foreign.projectId).not.toBe(first.projectId);
  expect((await listProjects(env.DB, local.ward.wardId)).map((project) => project.projectId)).toEqual([normal.projectId]);
  expect((await projectDirectory().listOpen(env.DB, local.ward.wardId)).map((project) => project.projectId)).toEqual([normal.projectId]);
  expect((await photoMatchCandidates(env.DB, local.ward.wardId)).map((project) => project.id)).toEqual([normal.projectId]);
  expect(await getProjectSummary(env.DB, other.ward.wardId, first.projectId)).toBeNull();
});
