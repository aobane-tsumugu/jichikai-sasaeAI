import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { FIRST_SLICE as fixture } from "../fixtures/first-slice";
import * as ai from "../src/ai/api";
import { seedAdmin } from "../src/core/testing";
import { getDraftPack } from "../src/draft/packs";
import type { Env } from "../src/env";
import { receive } from "../src/intake/receive";
import { listDraftPhotos } from "../src/photos/drafts";
import { listPublicPhotos } from "../src/photos/public";
import { PHOTO_MODEL_SHA256, PHOTO_PROFILE, saveWardPhotoPolicy } from "../src/photos/policy";
import { photoHash } from "../src/photos/server";
import { getEditableDocument, saveAIDraft, saveDocument } from "../src/project/actions";
import { createProject, getProjectSummary } from "../src/project/api";
import { get, postForm, realApp } from "./helpers";
import { fictionalStoredPhoto } from "./fixtures/phone-photo";
import { MASKED_PNG } from "./fixtures/report-photo";

it("写真付き報告を閉じて残し、直しても写真を引き継ぎ、五つの種類は既存の指示と範囲で閉じる", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const root = `/${ward.slug}/admin`;
  const project = await createProject(env.DB, ward.wardId, {
    kind: "event", title: fixture.draftTitle, year: fixture.eventYear, accountId: account.accountId,
  });
  const projectId = project.projectId;
  const stored = fictionalStoredPhoto();
  const masked = Uint8Array.from(atob(MASKED_PNG), c => c.charCodeAt(0));
  const input = await receive(env, { wardId: ward.wardId, projectId, via: "admin", parts: [
    { kind: "file", filename: "架空の写真.jpg", mediaType: "image/jpeg", bytes: stored, sourceHash: "b".repeat(64) },
  ] });
  const originalId = input.received[0]!.originalId;
  let faceCalls = 0;
  const bindings = Object.create(env, { FACE_MASK: { value: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async (request: Request) => {
      faceCalls++;
      expect(new Uint8Array(await request.arrayBuffer())).toEqual(stored);
      return Response.json({ state: "masked", source_sha256: await photoHash(stored),
        masked_sha256: await photoHash(masked), model_sha256: PHOTO_MODEL_SHA256, profile: PHOTO_PROFILE,
        width: 128, height: 128, png_base64: MASKED_PNG, faces: 1,
        masks: [{ x: 0.1, y: 0.1, width: 0.2, height: 0.2 }],
      });
    } }),
  } } }) as Env;
  await saveWardPhotoPolicy(env.DB, ward.wardId, { enabled: true, authorApprovedAt: new Date().toISOString(),
    qualityReportSha256: "a".repeat(64), providerId: "fictional-close-provider" });
  const ctx = createExecutionContext();
  const selected = await realApp.fetch(new Request(`http://localhost${root}/photos/${projectId}/${originalId}/select`, {
    method: "POST", headers: { cookie, origin: "http://localhost", "content-type": "application/x-www-form-urlencoded" }, body: "",
  }), bindings, ctx);
  expect(selected.status).toBe(303);
  await waitOnExecutionContext(ctx);
  const photos = await listDraftPhotos(bindings, ward.wardId, projectId);
  expect(photos[0]?.state).toBe("ready");
  expect(await saveDocument(env.DB, ward.wardId, projectId, account.accountId, {
    kind: "report", title: fixture.draftTitle, scope: "public", basedOn: 0,
    body: JSON.stringify({ text: fixture.reportText, items: [{ key: "content", content: fixture.reportText }] }),
  })).toBe(true);
  const document = await env.DB.prepare(`SELECT document_id, version_id, version_no FROM document_versions
    WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1`)
    .bind(ward.wardId, projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  expect(document).not.toBeNull();
  expect((await postForm(realApp, `${root}/publish/${projectId}/send`, {
    documentId: document!.document_id, versionId: document!.version_id, versionNo: String(document!.version_no),
    lineDelivery: "skip", distribution: "", photoRevision: photos[0]!.revision,
  }, cookie, bindings)).status).toBe(303);
  const before = await getEditableDocument(env.DB, ward.wardId, projectId, "report");
  const publishedPhotos = await listPublicPhotos(bindings, ward.wardId, projectId);
  expect(publishedPhotos).toHaveLength(1);
  const url = `/${ward.slug}/photos/${projectId}/${publishedPhotos[0]!.photo_id}`;
  const close = `${root}/close/${projectId}`;
  expect(await (await get(realApp, close, cookie, bindings)).text()).toContain(url);
  expect((await postForm(realApp, `${close}/finalize`, { body: fixture.reportText }, cookie, bindings)).status).toBe(303);
  expect((await getProjectSummary(env.DB, ward.wardId, projectId))?.closedAt).toBeTruthy();
  expect(await getEditableDocument(env.DB, ward.wardId, projectId, "report")).toEqual(before);
  expect(await listPublicPhotos(bindings, ward.wardId, projectId)).toEqual(publishedPhotos);
  expect(new Uint8Array(await (await get(realApp, url, undefined, bindings)).arrayBuffer())).toEqual(masked);
  expect(await (await get(realApp, `/${ward.slug}/p/${projectId}`, undefined, bindings)).text()).toContain(url);
  expect(await (await get(realApp, `${root}/print/${projectId}/${document!.document_id}/${document!.version_no}/announcement`, cookie, bindings)).text()).toContain(url);

  // 本文を直して閉じ直しても、確認済みの写真を再処理せず引き継ぐ。
  expect((await postForm(realApp, `${close}/reopen`, {}, cookie, bindings)).status).toBe(303);
  const edited = `${fixture.reportText}\n${fixture.nextYearChange}`;
  expect((await postForm(realApp, `${close}/finalize`, { body: edited }, cookie, bindings)).status).toBe(303);
  const carried = await listPublicPhotos(bindings, ward.wardId, projectId);
  expect(carried).toHaveLength(1);
  expect(carried[0]!.version_no).toBe(document!.version_no + 1);
  const carriedUrl = `/${ward.slug}/photos/${projectId}/${carried[0]!.photo_id}`;
  expect(new Uint8Array(await (await get(realApp, carriedUrl, undefined, bindings)).arrayBuffer())).toEqual(masked);
  const after = await getEditableDocument(env.DB, ward.wardId, projectId, "report");
  expect(JSON.parse(after!.body)).toMatchObject({ text: edited, publicPhotoInputs: JSON.parse(before!.body).publicPhotoInputs });
  expect(faceCalls).toBe(1);

  const started: ai.StartTaskInput[] = [];
  const fake = vi.spyOn(ai, "startTask").mockImplementation(async (target, _ctx, task) => {
    started.push(task);
    if (task.task === "report") {
      const summary = await getProjectSummary(target.DB, task.wardId, task.projectId);
      if (!summary) throw new Error("架空の仕事がありません");
      const pack = getDraftPack("report", summary.kind);
      expect(task.instruction).toContain(pack.instruction);
      expect(task.instruction).toContain(`範囲: ${pack.scope}`);
      expect(task.instruction).toContain(`pack_versionを${pack.version}`);
      expect(task.instruction).not.toContain("住民に向けた公開の報告だけを書きます");
      expect(await saveAIDraft(target.DB, task.wardId, task.projectId, "report", pack.version, {
        title: pack.title, scope: pack.scope, text: fixture.reportText,
        items: [{ key: "content", content: fixture.reportText }], based_on_state_version: summary.stateVersion,
      })).toBe(true);
    }
    return "fictional-close-job";
  });
  try {
    for (const [kind, expected, scope] of [
      ["general_meeting", "総会の議事録を作ります", "staff"],
      ["board_meeting", "役員会の議事録を作ります", "staff"],
      ["duty", "作業の報告を作ります", "public"],
      ["city_request", "市へ提出する回答の下書きを作ります", "staff"],
      ["request", "提出する要望書の下書きを作ります", "staff"],
    ] as const) {
      const work = await createProject(env.DB, ward.wardId, { kind, title: fixture.draftTitle,
        year: fixture.eventYear, accountId: account.accountId });
      const path = `${root}/close/${work.projectId}`;
      expect((await postForm(realApp, `${path}/prepare`, {}, cookie)).status).toBe(303);
      expect(started.find(task => task.projectId === work.projectId && task.task === "report")?.instruction).toContain(expected);
      const page = await (await get(realApp, path, cookie)).text();
      expect(page).toContain(fixture.reportText);
      if (scope === "staff") {
        expect(page).toContain(`${getDraftPack("report", kind).title}（役員だけ）`);
        expect(page).not.toContain('id="report-public"');
        expect(page).not.toContain("報告が住民向けのページに載ります");
      }
      // 下書きは追加の保存操作なしでも閉じた記録へ残る。
      expect((await postForm(realApp, `${path}/finalize`, {}, cookie)).status).toBe(303);
      expect((await getProjectSummary(env.DB, ward.wardId, work.projectId))?.closedAt).toBeTruthy();
      expect(await getEditableDocument(env.DB, ward.wardId, work.projectId, "report")).toMatchObject({ scope });
      const published = await env.DB.prepare("SELECT COUNT(*) AS n FROM publication_records WHERE ward_id = ? AND project_id = ?")
        .bind(ward.wardId, work.projectId).first<number>("n");
      expect(published).toBe(scope === "public" ? 1 : 0);
    }
    expect(started.filter(task => task.task === "report")).toHaveLength(5);
    expect(started.filter(task => task.task === "map_draft")).toHaveLength(5);
  } finally { fake.mockRestore(); }
});
