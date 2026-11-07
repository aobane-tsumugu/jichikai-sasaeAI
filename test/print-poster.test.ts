import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { seedAdmin } from "../src/core/testing";
import { applyChange, createProject } from "../src/project/api";
import { saveAIDraft, saveDocument } from "../src/project/actions";
import { get, postForm, realApp } from "./helpers";

it("印刷の一覧から貼れる一枚を開き、未配布の変更を混ぜず知らせ直した日時・場所を使う", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "秋の収穫祭（架空）", year: 2026, accountId: account.accountId,
  });
  const root = `/${ward.slug}/admin`;
  const save = async (dateTime: string, place: string, title = "秋の収穫祭（架空）") => {
    expect(await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
      kind: "announcement", title, scope: "public", basedOn: 0,
      body: JSON.stringify({ text: "案内の長い本文は一枚に出さない", items: [
        { key: "date_time", content: dateTime }, { key: "place", content: place },
        { key: "belongings", content: "持ち物も一枚には出さない" },
      ] }),
    })).toBe(true);
    const version = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
      WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1`)
      .bind(ward.wardId, project.projectId).first<{ document_id: string; version_id: string; version_no: number }>();
    if (!version) throw new Error("印刷する下書きがありません。");
    return version;
  };
  const path = (version: { document_id: string; version_no: number }) =>
    `${root}/print/${project.projectId}/${version.document_id}/${version.version_no}`;
  const publish = async (version: { document_id: string; version_id: string; version_no: number }) => {
    expect((await postForm(realApp, `${root}/publish/${project.projectId}/send`, {
      documentId: version.document_id, versionId: version.version_id,
      versionNo: String(version.version_no), lineDelivery: "skip",
    }, cookie)).status).toBe(303);
  };

  const first = await save("2026年11月14日10時〜12時", "架空の広場");
  expect((await get(realApp, `${path(first)}/poster`, cookie)).status).toBe(404);
  await publish(first);
  const chooser = await (await get(realApp, path(first), cookie)).text();
  expect(chooser).toContain(`href="${path(first)}/poster"`);
  expect(chooser).toContain("貼れる一枚");
  const original = await (await get(realApp, `${path(first)}/poster`, cookie)).text();
  expect(original).toContain("秋の収穫祭（架空）");
  expect(original).toContain("2026年11月14日10時〜12時");
  expect(original).toContain("架空の広場");
  expect(original).toContain(`href="${env.PUBLIC_BASE_URL}/${ward.slug}/"`);
  expect(original).toContain("住民向けのページを開くQR");
  expect(original).toContain("<svg");
  expect(original).not.toContain("案内の長い本文は一枚に出さない");
  expect(original).not.toContain("持ち物も一枚には出さない");

  await applyChange(env.DB, ward.wardId, project.projectId, {
    kind: "item", itemKey: "place", value: "まだ配っていない会場",
    source: { kind: "person", accountId: account.accountId }, confidence: "high", packVersion: "poster-test@1",
  });
  expect(await saveAIDraft(env.DB, ward.wardId, project.projectId, "announcement", "poster-test@1", {
    title: "まだ配っていないAIの題", text: "架空のAIの下書き", items: [],
  })).toBe(true);
  expect(await (await get(realApp, `${path(first)}/poster`, cookie)).text()).toBe(original);
  // 紙と区のページと記録で、配った物の題を揃える
  const wardPage = await (await get(realApp, `/${ward.slug}/`)).text();
  expect(wardPage).toContain("秋の収穫祭（架空）");
  expect(wardPage).not.toContain("まだ配っていないAIの題");
  for (const suffix of ["", "/preview", "/announcement"]) {
    const printed = await (await get(realApp, `${path(first)}${suffix}`, cookie)).text();
    expect(printed).toContain("秋の収穫祭（架空）");
    expect(printed).not.toContain("まだ配っていないAIの題");
  }
  const second = await save("2026年11月15日13時〜15時", "架空の公民館", "雨の収穫祭（架空）");
  expect((await get(realApp, `${path(second)}/poster`, cookie)).status).toBe(404);
  expect(await (await get(realApp, `${path(first)}/poster`, cookie)).text()).toBe(original);
  await publish(second);
  const updated = await (await get(realApp, `${path(second)}/poster`, cookie)).text();
  expect(updated).toContain("雨の収穫祭（架空）");
  expect(updated).toContain("2026年11月15日13時〜15時");
  expect(updated).toContain("架空の公民館");
  expect(updated).not.toContain("まだ配っていない会場");
  expect(updated).not.toContain("架空の広場");
  expect(await (await get(realApp, `${path(first)}/poster`, cookie)).text()).toBe(original);

  // 閉じた後の記録も、配った時の題で残す
  expect(await saveAIDraft(env.DB, ward.wardId, project.projectId, "announcement", "poster-test@1", {
    title: "閉じる前のAIの題", text: "架空のAIの下書き", items: [],
  })).toBe(true);
  await env.DB.prepare("UPDATE projects SET closed_at = ? WHERE ward_id = ? AND project_id = ?")
    .bind(new Date().toISOString(), ward.wardId, project.projectId).run();
  const record = await (await get(realApp, `${root}/archive/${project.projectId}`, cookie)).text();
  expect(record).toContain("雨の収穫祭（架空）");
  expect(record).not.toContain("閉じる前のAIの題");
});

it("実行委員と班長のページ向けに配った文書は貼れる一枚の対象にしない", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の行事", year: 2026, accountId: account.accountId,
  });
  await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "duty_roster", title: "役員内の当番表", scope: "space", basedOn: 0,
    body: JSON.stringify({ text: "外へ貼らない担当の名前", items: [] }),
  });
  const version = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
    WHERE ward_id = ? AND project_id = ?`).bind(ward.wardId, project.projectId)
    .first<{ document_id: string; version_id: string; version_no: number }>();
  if (!version) throw new Error("実行委員と班長のページに配る下書きがありません。");
  expect((await postForm(realApp, `/${ward.slug}/admin/publish/${project.projectId}/space`, {
    documentId: version.document_id, versionId: version.version_id, versionNo: String(version.version_no),
  }, cookie)).status).toBe(303);
  const path = `/${ward.slug}/admin/print/${project.projectId}/${version.document_id}/${version.version_no}`;
  expect(await (await get(realApp, path, cookie)).text()).not.toContain("貼れる一枚");
  expect((await get(realApp, `${path}/poster`, cookie)).status).toBe(404);
});

it("題が文書の種類だけの紙には行事名を出し、貼れる一枚に雨のときの場所も載せる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: "架空の秋祭り", year: 2026, accountId: account.accountId,
  });
  await saveDocument(env.DB, ward.wardId, project.projectId, account.accountId, {
    kind: "announcement", title: "案内", scope: "public", basedOn: 0,
    body: JSON.stringify({ text: "架空の本文", items: [
      { key: "date_time", content: "2026年11月14日" }, { key: "place", content: "架空の広場" },
      { key: "rain_plan", content: "架空の公民館" },
    ] }),
  });
  const version = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
    WHERE ward_id = ? AND project_id = ?`).bind(ward.wardId, project.projectId)
    .first<{ document_id: string; version_id: string; version_no: number }>();
  if (!version) throw new Error("下書きがありません。");
  const root = `/${ward.slug}/admin`;
  expect((await postForm(realApp, `${root}/publish/${project.projectId}/send`, {
    documentId: version.document_id, versionId: version.version_id,
    versionNo: String(version.version_no), lineDelivery: "skip",
  }, cookie)).status).toBe(303);
  const path = `${root}/print/${project.projectId}/${version.document_id}/${version.version_no}`;
  const poster = await (await get(realApp, `${path}/poster`, cookie)).text();
  expect(poster).toContain("<h1>架空の秋祭りのご案内</h1>");
  expect(poster).toContain("雨のとき");
  expect(poster).toContain("架空の公民館");
  expect(await (await get(realApp, `${path}/announcement`, cookie)).text()).toContain("<h1>架空の秋祭りのご案内</h1>");
  expect(await (await get(realApp, `${path}/preview`, cookie)).text()).toContain("<h1>架空の秋祭りのご案内</h1>");
});
