import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { WardBucket } from "../src/core/storage";
import { createProject } from "../src/project/api";
import { getProjectSummary } from "../src/project/api";
import { broadcastLineText } from "../src/line/api";
import { saveDocument } from "../src/project/actions";
import { draftFlyer, flyerMaterials, readFlyerInput, saveFlyer } from "../src/draft/notice-flyers";
import { getNoticeFlyer, noticeFlyerPath, noticeLineText } from "../src/publish/notice-flyers";
import { WARD_TABLE_POLICY } from "../src/archive/snapshot";
import { get, postForm, realApp, withEnv } from "./helpers";
import { NOTICE_FLYER as fixture, noticeFlyerJpeg } from "./fixtures/notice-flyer";

type Version = { document_id: string; version_id: string; version_no: number };
async function latest(wardId: string, projectId: string, kind = "announcement"): Promise<Version> {
  const row = await env.DB.prepare(`SELECT v.document_id, v.version_id, v.version_no FROM document_versions v
    JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
    WHERE v.ward_id = ? AND v.project_id = ? AND d.kind = ? ORDER BY v.version_no DESC LIMIT 1`)
    .bind(wardId, projectId, kind).first<Version>();
  if (!row) throw new Error("架空の下書きが保存されていません");
  return row;
}
function form(basedOn: number, choice = "attach") {
  const data = new FormData();
  for (const [key, value] of Object.entries({ title: fixture.title, text: fixture.text, scope: "public", based_on: String(basedOn),
    item_date_time: fixture.date, item_place: fixture.place, flyer_choice: choice })) data.set(key, value);
  if (choice === "attach") {
    data.set("flyer_file", new File([noticeFlyerJpeg()], "flyer.jpg", { type: "image/jpeg" }));
    data.set("flyer_prepared", "jpeg");
  }
  return data;
}
async function upload(path: string, data: FormData, cookie: string) {
  return realApp.request(path, { method: "POST", headers: { origin: "http://localhost", cookie }, body: data }, env);
}

it("架空の下書きにチラシを付けて知らせ、文と画像を一度で送り、雨の変更では画像を引き継がない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const other = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "広場で遊ぶ日（架空）", year: 2027, accountId: account.accountId });
  const admin = `/${ward.slug}/admin`;
  const draft = `${admin}/projects/${project.projectId}/draft`;
  const save = await upload(`${draft}/announcement/save`, form(project.stateVersion), cookie);
  expect(save.status).toBe(303);
  const version = await latest(ward.wardId, project.projectId);
  const flyer = await getNoticeFlyer(env.DB, ward.wardId, version.version_id);
  if (!flyer?.flyer_id || !flyer.r2_path) throw new Error("架空のチラシがありません");
  const path = noticeFlyerPath(ward.slug, version.version_id, flyer.flyer_id);
  expect((await get(realApp, path)).status).toBe(404);
  expect((await get(realApp, `${admin}/projects/${project.projectId}/flyer/${version.version_id}`, cookie)).status).toBe(200);
  expect((await get(realApp, `${admin}/projects/${project.projectId}/flyer/${version.version_id}`)).status).not.toBe(200);
  const confirm = await postForm(realApp, `${admin}/publish/${project.projectId}/confirm`, {
    documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "skip",
  }, cookie);
  expect(confirm.status).toBe(200);
  expect(await confirm.text()).toContain(`/flyer/${version.version_id}`);

  await env.DB.prepare(`INSERT INTO line_channels (ward_id, destination, channel_secret_binding, access_token_binding)
    VALUES (?, ?, 'LINE_CHANNEL_SECRET', 'LINE_CHANNEL_ACCESS_TOKEN')`).bind(ward.wardId, crypto.randomUUID()).run();
  const runtime = withEnv({ PUBLIC_BASE_URL: "https://example.invalid", LINE_CHANNEL_ACCESS_TOKEN: "fictional-notice-flyer-token" });
  type Message = { type: "text"; text: string } | { type: "image"; originalContentUrl: string; previewImageUrl: string };
  const sent: Array<{ messages: Message[] }> = [];
  const fakeLine: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("/insight/followers?")) return Response.json({ status: "ready", followers: 3 });
    if (url.endsWith("/message/quota")) return Response.json({ type: "limited", value: 1000 });
    if (url.endsWith("/message/quota/consumption")) return Response.json({ totalUsage: 0 });
    if (url.endsWith("/message/broadcast")) { sent.push(JSON.parse(String(init?.body)) as { messages: Message[] }); return Response.json({}); }
    throw new Error("この試験にない外部への呼び出しです");
  };
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(fakeLine);
  try {
    const publish = () => postForm(realApp, `${admin}/publish/${project.projectId}/send`, {
      documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no), lineDelivery: "send",
    }, cookie, runtime);
    expect((await publish()).status).toBe(303);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.messages).toEqual([
      { type: "text", text: `${project.title} ${fixture.title}\n${fixture.date}\n${fixture.place}\nhttps://example.invalid/${ward.slug}/answer/${project.projectId}` },
      { type: "image", originalContentUrl: `https://example.invalid${path}`,
        previewImageUrl: `https://example.invalid${noticeFlyerPath(ward.slug, version.version_id, flyer.flyer_id, true)}` },
    ]);
    expect((await publish()).status).toBe(404);
    expect(sent).toHaveLength(1);
  } finally { network.mockRestore(); }

  const publicPage = await get(realApp, `/${ward.slug}/p/${project.projectId}`);
  const html = await publicPage.text();
  expect(html).toContain(`src="${path}"`);
  expect(html).toContain(`alt="${fixture.title}"`);
  expect(html).toContain(fixture.date);
  const image = await get(realApp, path);
  expect(image.status).toBe(200);
  expect(image.headers.get("content-type")).toBe("image/jpeg");
  expect(new Uint8Array(await image.arrayBuffer())).toEqual(noticeFlyerJpeg());
  expect((await get(realApp, noticeFlyerPath(ward.slug, version.version_id, flyer.flyer_id, true))).status).toBe(200);
  expect((await get(realApp, noticeFlyerPath(other.ward.slug, version.version_id, flyer.flyer_id))).status).toBe(404);
  expect((await get(realApp, noticeFlyerPath(ward.slug, "draft", flyer.flyer_id))).status).toBe(404);
  expect((await get(realApp, `/${ward.slug}/${flyer.r2_path}`)).status).toBe(404);
  const paper = await get(realApp, `${admin}/print/${project.projectId}/${version.document_id}/${version.version_no}/announcement`, cookie);
  expect(paper.status).toBe(200);
  expect(await paper.text()).not.toContain("/flyers/");

  const rain = await get(realApp, `${draft}/notice`, cookie);
  expect(await rain.text()).toContain("前の知らせにはチラシの画像が付いていました。付け直しますか");
  const rainFields = { templateId: "rain", eventName: project.title, place: "架空の雨の日会館", dateTime: fixture.date, lineDelivery: "skip" };
  const undecided = await postForm(realApp, `${draft}/rain-notice`, rainFields, cookie);
  expect(await undecided.text()).toContain("付け直すか、付けないかを選んでください");
  const rainSend = await postForm(realApp, `${draft}/rain-notice`, { ...rainFields, flyer_choice: "none" }, cookie);
  expect(rainSend.status).toBe(303);
  const notice = await latest(ward.wardId, project.projectId, "notice");
  expect((await getNoticeFlyer(env.DB, ward.wardId, notice.version_id))?.flyer_id).toBeNull();
  const changed = await (await get(realApp, `/${ward.slug}/p/${project.projectId}`)).text();
  expect(changed).toContain(rainFields.place);
  expect(changed).not.toContain(`src="${path}"`);
  expect(await draftFlyer(env.DB, ward.wardId, project.projectId, "announcement")).toBeNull();
  expect(await (await get(realApp, `${draft}/announcement`, cookie)).text()).toContain("付け直しますか");
  const state = await getProjectSummary(env.DB, ward.wardId, project.projectId);
  if (!state) throw new Error("架空の準備がありません");
  expect((await upload(`${draft}/announcement/save`, form(state.stateVersion), cookie)).status).toBe(303);
  const replaced = await latest(ward.wardId, project.projectId);
  const replacement = await getNoticeFlyer(env.DB, ward.wardId, replaced.version_id);
  expect(replacement?.flyer_id).not.toBe(flyer.flyer_id);
  expect((await get(realApp, noticeFlyerPath(ward.slug, replaced.version_id, replacement!.flyer_id!))).status).toBe(404);
  expect((await getNoticeFlyer(env.DB, ward.wardId, version.version_id))?.flyer_id).toBe(flyer.flyer_id);
  expect((await env.DB.prepare("SELECT line_status FROM publication_records WHERE ward_id = ? AND version_id = ?")
    .bind(ward.wardId, version.version_id).first<{ line_status: string }>())?.line_status).toBe("sent");
  const record = await env.DB.prepare("SELECT publication_id FROM publication_records WHERE ward_id = ? AND version_id = ?")
    .bind(ward.wardId, version.version_id).first<{ publication_id: string }>();
  if (!record) throw new Error("架空の知らせの記録がありません");
  expect((await postForm(realApp, `${admin}/publish/${project.projectId}/lower/${record.publication_id}`, {}, cookie)).status).toBe(303);
  expect((await get(realApp, path)).status).toBe(404);
});

it("届いたものから選べるのは役員グループの自分たちの資料で、原本のURLは公開しない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "資料の確認（架空）", year: 2027, accountId: account.accountId });
  const group = "fictional-notice-officer-group";
  await env.DB.prepare("INSERT INTO ward_settings (ward_id, key, value) VALUES (?, 'line.officer_group', ?)").bind(ward.wardId, group).run();
  const originals: Record<string, string> = {};
  for (const action of ["material", "reference", "inquiry", "confirm_purpose", "confirm_share", "resident"]) {
    const job = crypto.randomUUID(), original = crypto.randomUUID(), bundle = crypto.randomUUID(), now = new Date().toISOString();
    originals[action] = original;
    const path = `originals/${original}.jpg`;
    await new WardBucket(env.ORIGINALS, ward.wardId).put(path, noticeFlyerJpeg());
    await env.DB.prepare(`INSERT INTO jobs (ward_id, job_id, project_id, via, created_at, updated_at) VALUES (?, ?, ?, 'line_group', ?, ?)`)
      .bind(ward.wardId, job, project.projectId, now, now).run();
    await env.DB.prepare(`INSERT INTO originals (ward_id, original_id, job_id, position, kind, content_hash, media_type, filename, byte_size, r2_path, received_at)
      VALUES (?, ?, ?, 1, 'photo', ?, 'image/jpeg', ?, ?, ?, ?)`)
      .bind(ward.wardId, original, job, original, `${action}（架空）.jpg`, noticeFlyerJpeg().byteLength, path, now).run();
    await env.DB.prepare(`INSERT INTO line_inbox_items (ward_id, item_id, event_id, sender_id, original_kind, received_at, job_id, bundle_id, source_type, source_id)
      VALUES (?, ?, ?, 'fictional-sender', 'image', ?, ?, ?, ?, ?)`)
      .bind(ward.wardId, crypto.randomUUID(), crypto.randomUUID(), now, job, bundle, action === "resident" ? "user" : "group", action === "resident" ? "fictional-resident" : group).run();
    await env.DB.prepare(`INSERT INTO line_bundle_decisions (ward_id, bundle_id, summary, action, project_id, decided_by, created_at, updated_at, decided_at)
      VALUES (?, ?, '架空の写真', ?, ?, 'officer', ?, ?, ?)`)
      .bind(ward.wardId, bundle, action === "resident" ? "material" : action, project.projectId, now, now, now).run();
  }
  const materials = await flyerMaterials(env, ward.wardId, project.projectId);
  expect(materials.map((photo) => photo.original_id)).toEqual([originals.material]);
  const source = `/${ward.slug}/admin/projects/${project.projectId}/flyer-material/${originals.material}`;
  expect((await get(realApp, source, cookie)).status).toBe(200);
  expect((await get(realApp, source)).status).not.toBe(200);
  expect((await get(realApp, `/${ward.slug}/originals/${originals.material}.jpg`)).status).toBe(404);
  expect((await get(realApp, source.replace(originals.material!, originals.reference!), cookie)).status).toBe(404);
  const data = form(project.stateVersion); data.set("flyer_material", originals.material!);
  expect((await upload(`/${ward.slug}/admin/projects/${project.projectId}/draft/announcement/save`, data, cookie)).status).toBe(303);
  const version = await latest(ward.wardId, project.projectId);
  const flyer = await getNoticeFlyer(env.DB, ward.wardId, version.version_id);
  expect(flyer?.r2_path).toMatch(/^notice-flyers\//);
  expect(flyer?.r2_path).not.toContain(originals.material);
  const remove = form((await getProjectSummary(env.DB, ward.wardId, project.projectId))!.stateVersion, "none");
  expect((await upload(`/${ward.slug}/admin/projects/${project.projectId}/draft/announcement/save`, remove, cookie)).status).toBe(303);
  expect((await draftFlyer(env.DB, ward.wardId, project.projectId, "announcement"))?.flyer_id).toBeNull();
});

it("Word・PDF・整えていない画像を拒み、画像をAIや保存済みの知らせから自動で選ばない", async () => {
  const { ward, account } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "画像の受付（架空）", year: 2027, accountId: account.accountId });
  for (const type of ["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]) {
    const data = form(project.stateVersion); data.set("flyer_file", new File(["架空の文書"], "flyer.jpg", { type }));
    expect(typeof await readFlyerInput(env, ward.wardId, project.projectId, "announcement", data)).toBe("string");
  }
  const unprepared = form(project.stateVersion); unprepared.delete("flyer_prepared");
  expect(typeof await readFlyerInput(env, ward.wardId, project.projectId, "announcement", unprepared)).toBe("string");
  expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "announcement", title: fixture.title, scope: "public", basedOn: project.stateVersion,
    body: JSON.stringify({ text: fixture.text, items: [{ key: "date_time", content: fixture.date }] }),
  })).toBe(true);
  const version = await latest(ward.wardId, project.projectId);
  expect(await getNoticeFlyer(env.DB, ward.wardId, version.version_id)).toBeNull();
  const input = await readFlyerInput(env, ward.wardId, project.projectId, "announcement", form(project.stateVersion));
  if (typeof input === "string") throw new Error(input);
  await saveFlyer(env, ward.wardId, project.projectId, version.version_id, input);
  const flyer = await getNoticeFlyer(env.DB, ward.wardId, version.version_id);
  await env.DB.prepare("UPDATE document_versions SET published_at = ? WHERE ward_id = ? AND version_id = ?")
    .bind(new Date().toISOString(), ward.wardId, version.version_id).run();
  await expect(saveFlyer(env, ward.wardId, project.projectId, version.version_id, input)).rejects.toThrow();
  expect((await getNoticeFlyer(env.DB, ward.wardId, version.version_id))?.flyer_id).toBe(flyer?.flyer_id);
  expect(WARD_TABLE_POLICY.find((entry) => entry.table === "notice_flyers")).toEqual({ table: "notice_flyers", snapshot: true, export: true, deletion: { cascade: "projects" } });
  const request: typeof fetch = async () => { throw new Error("HTTPの画像で送信してはいけません"); };
  await expect(broadcastLineText("fictional-token", "架空の知らせ", request, { originalContentUrl: "http://example.invalid/image.jpg", previewImageUrl: "https://example.invalid/preview.jpg" })).rejects.toThrow("HTTPS");
  const summary = noticeLineText(fixture.title, JSON.stringify({ text: "日時: 新しい日時\n場所: 新しい会場\n連絡先: 出さない連絡先", items: [{ key: "place", content: "古い会場" }] }), "https://example.invalid/answer");
  expect(summary).toBe(`${fixture.title}\n新しい日時\n新しい会場\nhttps://example.invalid/answer`);
  expect(noticeLineText(fixture.title, JSON.stringify({ text: "架空の遊ぶ日の案内です。", items: [
    { key: "date_time", content: fixture.date }, { key: "place", content: fixture.place },
  ] }), "https://example.invalid/answer")).toBe(`${fixture.title}\n${fixture.date}\n${fixture.place}\nhttps://example.invalid/answer`);
});
