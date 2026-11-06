import { env } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { expect, it } from "vitest";
import type { Env } from "../src/env";
import { seedAdmin } from "../src/core/testing";
import { receive } from "../src/intake/receive";
import { createProject } from "../src/project/api";
import { saveDocument } from "../src/project/actions";
import { listDraftPhotos } from "../src/photos/drafts";
import { PHOTO_MODEL_SHA256, PHOTO_PROFILE, saveWardPhotoPolicy } from "../src/photos/policy";
import { photoHash, type MaskBox } from "../src/photos/server";
import { listPublicPhotos } from "../src/photos/public";
import { get, postForm, realApp } from "./helpers";
import { SOURCE_PNG, MASKED_PNG } from "./fixtures/report-photo";

it("報告の写真を選び、提供側で隠し、足す・外す・隠さないを直して配る。失敗と時間切れは写真だけ外す", async () => {
  const { ward, account, cookie } = await seedAdmin(env.DB);
  const project = await createProject(env.DB, ward.wardId, { kind: "event", title: "写真の報告（架空）", year: 2026, accountId: account.accountId });
  const projectId = project.projectId;
  const original = Uint8Array.from(atob(SOURCE_PNG), (c) => c.charCodeAt(0));
  const masked = Uint8Array.from(atob(MASKED_PNG), (c) => c.charCodeAt(0));
  const received = await receive(env, { wardId: ward.wardId, projectId, via: "admin", parts: [
    { kind: "photo", filename: "自作の画素.png", mediaType: "image/png", bytes: original },
  ] });
  const originalId = received.received[0]!.originalId;
  let fail = false;
  let releaseFirst: (() => void) | undefined;
  const firstResponse = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstCall = true;
  const calls: { mode: string; masks: MaskBox[] }[] = [];
  const initial: MaskBox = { x: 0.1, y: 0.1, width: 0.2, height: 0.2 };
  const bindings = Object.create(env, { FACE_MASK: { value: {
    idFromName: (name: string) => name,
    get: () => ({ fetch: async (request: Request) => {
      if (firstCall) { firstCall = false; await firstResponse; }
      if (fail) return new Response(null, { status: 503 });
      let mode = "auto", masks = [initial];
      if (request.headers.get("content-type") === "application/json") {
        const edit = await request.json() as { mode: string; masks: MaskBox[]; image_base64: string };
        expect(edit.image_base64).toBe(SOURCE_PNG);
        mode = edit.mode; masks = mode === "none" ? [] : edit.masks;
      } else expect(new Uint8Array(await request.arrayBuffer())).toEqual(original);
      calls.push({ mode, masks });
      const png = mode === "none" ? SOURCE_PNG : MASKED_PNG;
      return Response.json({ state: "masked", source_sha256: await photoHash(original),
        masked_sha256: await photoHash(mode === "none" ? original : masked), model_sha256: PHOTO_MODEL_SHA256,
        profile: PHOTO_PROFILE, width: 128, height: 128, png_base64: png, faces: masks.length, masks });
    } }),
  } } }) as Env;
  const root = `/${ward.slug}/admin/photos/${projectId}`;
  expect((await get(realApp, root, cookie, bindings)).status).toBe(404);
  await saveWardPhotoPolicy(env.DB, ward.wardId, { enabled: true, authorApprovedAt: new Date().toISOString(), qualityReportSha256: "a".repeat(64), providerId: "test-provider" });
  async function act(action: string, fields: Record<string, string> = {}) {
    const ctx = createExecutionContext();
    const response = await realApp.fetch(new Request(`http://localhost${root}/${originalId}/${action}`, {
      method: "POST", headers: { origin: "http://localhost", cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields),
    }), bindings, ctx);
    expect(response.status).toBe(303);
    if (releaseFirst) {
      expect((await listDraftPhotos(bindings, ward.wardId, projectId))[0]!.state).toBe("processing");
      releaseFirst();
      releaseFirst = undefined;
    }
    await waitOnExecutionContext(ctx);
    return (await listDraftPhotos(bindings, ward.wardId, projectId))[0]!;
  }
  let draft = await act("select");
  expect(draft.state).toBe("ready");
  expect(calls[0]).toEqual({ mode: "auto", masks: [initial] });
  const added = { x: 0.5, y: 0.5, width: 0.2, height: 0.2 };
  draft = await act("edit", { revision: draft.revision, masks: JSON.stringify([initial, added]) });
  expect(JSON.parse(draft.masks)).toEqual([initial, added]);
  draft = await act("edit", { revision: draft.revision, masks: JSON.stringify([added]) });
  expect(JSON.parse(draft.masks)).toEqual([added]);
  draft = await act("edit", { revision: draft.revision, masks: draft.masks, unmasked: "yes" });
  expect(draft.mode).toBe("none");
  expect(calls.at(-1)).toEqual({ mode: "none", masks: [] });
  expect(await (await get(realApp, root, cookie, bindings)).text()).toContain("写っている人の了承を取りましたか");
  await saveDocument(env.DB, ward.wardId, projectId, account.accountId, {
    kind: "report", title: "架空の報告", scope: "public", body: JSON.stringify({ text: "楽しい行事でした。", items: [] }), basedOn: 0,
  });
  const version = await env.DB.prepare("SELECT document_id, version_id, version_no FROM document_versions WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, projectId).first<{ document_id: string; version_id: string; version_no: number }>();
  expect(version).not.toBeNull();
  const publish = `/${ward.slug}/admin/publish/${projectId}`;
  const fields = { documentId: version!.document_id, versionId: version!.version_id, versionNo: String(version!.version_no), lineDelivery: "skip", distribution: "" };
  // 最後は既定の隠す写真で配り、公開と紙が同じ写しを指すことも確かめる。
  draft = await act("edit", { revision: draft.revision, masks: draft.masks });
  expect(draft.mode).toBe("auto");
  const confirm = await get(realApp, `${publish}/confirm?kind=report`, cookie, bindings);
  expect(await confirm.text()).toContain(`name="photoRevision" value="${draft.revision}"`);
  expect((await postForm(realApp, `${publish}/send`, { ...fields, photoRevision: draft.revision }, cookie, bindings)).status).toBe(303);
  const published = await listPublicPhotos(bindings, ward.wardId, projectId);
  expect(published).toHaveLength(1);
  const url = `/${ward.slug}/photos/${projectId}/${published[0]!.photo_id}`;
  const photoResponse = await get(realApp, url, undefined, bindings);
  expect(new Uint8Array(await photoResponse.arrayBuffer())).toEqual(masked);
  expect(await (await get(realApp, `/${ward.slug}/p/${projectId}`, undefined, bindings)).text()).toContain(url);
  expect(await (await get(realApp, `/${ward.slug}/admin/print/${projectId}/${version!.document_id}/${version!.version_no}/announcement`, cookie, bindings)).text()).toContain(url);
  expect((await get(realApp, `${root}/${originalId}/source`, undefined, bindings)).status).not.toBe(200);
  fail = true;
  draft = await act("select");
  expect(draft.state).toBe("failed");
  await env.DB.prepare("UPDATE report_photo_drafts SET state = 'processing', updated_at = ? WHERE ward_id = ? AND project_id = ? AND original_id = ?")
    .bind("2000-01-01T00:00:00.000Z", ward.wardId, projectId, originalId).run();
  expect((await listDraftPhotos(bindings, ward.wardId, projectId))[0]!.state).toBe("failed");
  await saveDocument(env.DB, ward.wardId, projectId, account.accountId, {
    kind: "report", title: "架空の報告", scope: "public", body: JSON.stringify({ text: "写真なしで配る報告です。", items: [] }), basedOn: 0,
  });
  const next = await env.DB.prepare("SELECT document_id, version_id, version_no FROM document_versions WHERE ward_id = ? AND project_id = ? ORDER BY version_no DESC LIMIT 1")
    .bind(ward.wardId, projectId).first<typeof version>();
  expect(next).not.toBeNull();
  expect(await (await get(realApp, `${publish}/confirm?kind=report`, cookie, bindings)).text()).toContain("この写真は載りません");
  expect((await postForm(realApp, `${publish}/send`, { ...fields, versionId: next!.version_id, versionNo: String(next!.version_no), photoRevision: draft.revision }, cookie, bindings)).status).toBe(303);
  expect(await listPublicPhotos(bindings, ward.wardId, projectId)).toHaveLength(0);
  expect((await get(realApp, url, undefined, bindings)).status).toBe(404);
  expect(new Uint8Array(await (await get(realApp, `${root}/${originalId}/source`, cookie, bindings)).arrayBuffer())).toEqual(original);
});
