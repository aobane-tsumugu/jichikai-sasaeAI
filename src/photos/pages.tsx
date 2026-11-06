import { Hono } from "hono";
import type { AdminEnv, WardEnv } from "../env";
import { AdminPage, adminResult } from "../core/admin-ui";
import { adminPath } from "../core/auth";
import { WardBucket } from "../core/storage";
import { Notice } from "../core/ui";
import { photosAvailable } from "./policy";
import { listDraftPhotos, queueReportPhoto } from "./drafts";
import { checkedMaskedPng, checkedMasks } from "./server";
import { publicPhotoResponse } from "./public";
import { EDITOR_SCRIPT } from "./editor";
import type { PreparedPhoto } from "./server";

// PR #62のspaceに残る旧入口は空のまま保ち、写真の入口を二重に登録しない。
export const photoAdmin = new Hono<AdminEnv>();
export const reportPhotoAdmin = new Hono<AdminEnv>();
export const photoPublic = new Hono<WardEnv>();
photoPublic.get("/photos/:projectId/:photoId", (c) => publicPhotoResponse(c.env, c.var.ward.wardId, c.req.param("projectId"), c.req.param("photoId")));

reportPhotoAdmin.get("/photos/:projectId", async (c) => {
  const { ward, account } = c.var;
  const projectId = c.req.param("projectId");
  const project = await c.env.DB.prepare("SELECT title, closed_at FROM projects WHERE ward_id = ? AND project_id = ? AND kind = 'event'")
    .bind(ward.wardId, projectId).first<{ title: string; closed_at: string | null }>();
  if (!project || !await photosAvailable(c.env, ward.wardId)) return c.notFound();
  const photos = await c.env.DB.prepare(`SELECT o.original_id, o.filename FROM originals o
    JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id WHERE o.ward_id = ? AND j.project_id = ?
      AND o.kind = 'photo' AND o.withdrawn_at IS NULL AND j.withdrawn_at IS NULL AND o.r2_path IS NOT NULL
      AND o.media_type IN ('image/jpeg', 'image/png') ORDER BY o.received_at, o.original_id`)
    .bind(ward.wardId, projectId).all<{ original_id: string; filename: string }>();
  const drafts = await listDraftPhotos(c.env, ward.wardId, projectId);
  const base = adminPath(ward, `/photos/${projectId}`);
  c.header("Cache-Control", "private, no-store");
  return c.html(<AdminPage ward={ward} account={account} title="報告の写真を選ぶ" back={{ href: adminPath(ward, `/projects/${projectId}/draft/report`), label: "報告の下書きへ" }}>
    <h1>報告の写真を選ぶ</h1><p class="lead">届いた写真から4枚まで選べます。顔はSasaeAIが隠します。待たずに下書きへ戻れます。</p>
    {c.req.query("saved") ? <Notice>写真の準備を始めました。画面を閉じても続きます。</Notice> : null}
    {drafts.some((p) => p.state === "processing") ? <p><a class="button secondary" href={base}>写真の準備が済んだか見る</a></p> : null}
    {photos.results.map((photo, index) => {
      const draft = drafts.find((d) => d.original_id === photo.original_id);
      const prepared = draft?.state === "ready" && draft.prepared ? JSON.parse(draft.prepared) as PreparedPhoto : null;
      return <section class="panel"><h2>写真{index + 1}</h2>
        {prepared ? <form method="post" action={`${base}/${photo.original_id}/edit`}>
          <p>写真を押すと隠す範囲を足せます。枠を押すと外せます。指でなぞると広く隠せます。直したところは下のボタンで反映します。直さなくても配れます。</p>
          <div data-photo-editor style="position:relative;max-width:640px;touch-action:none">
            <img style="display:block;width:100%;height:auto" draggable="false" src={`${base}/${photo.original_id}/preview?revision=${draft?.revision}`} alt={`報告に使う写真${index + 1}`} />
            <input type="hidden" name="masks" value={JSON.stringify(prepared.masks)} />
          </div>
          <input type="hidden" name="revision" value={draft?.revision} />
          <label><input type="checkbox" name="unmasked" value="yes" checked={draft?.mode === "none"} />この写真は顔を隠さない</label>
          <p>顔を隠さないときは、写っている人の了承を取りましたか。</p>
          {!project.closed_at ? <button class="secondary">この写真を直す</button> : null}
        </form> : <>
          <img style="display:block;max-width:100%;max-height:320px" loading="lazy" src={`${base}/${photo.original_id}/source`} alt={`届いた写真${index + 1}`} />
          {draft ? <p>{draft.state === "processing" ? "顔を隠しています。今配ると、この写真は載りません。" : "この写真は載りません。もう一度選ぶと準備し直せます。"}</p> : null}
          {!project.closed_at ? <form method="post" action={`${base}/${photo.original_id}/select`}><button class="secondary">{draft ? "もう一度選ぶ" : "報告に使う"}</button></form> : null}
        </>}
        {draft && !project.closed_at ? <form method="post" action={`${base}/${photo.original_id}/remove`}><button class="secondary">報告から外す</button></form> : null}
      </section>;
    })}
    {!photos.results.length ? <p>この行事には写真がまだ届いていません。</p> : null}
    <a class="button" href={adminPath(ward, `/projects/${projectId}/draft/report`)}>報告の下書きへ戻る</a>
    <script dangerouslySetInnerHTML={{ __html: EDITOR_SCRIPT }} />
  </AdminPage>);
});

reportPhotoAdmin.get("/photos/:projectId/:originalId/source", async (c) => {
  if (!await photosAvailable(c.env, c.var.ward.wardId)) return c.notFound();
  const row = await c.env.DB.prepare(`SELECT o.r2_path, o.media_type FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
    WHERE o.ward_id = ? AND o.original_id = ? AND j.project_id = ? AND o.kind = 'photo'
      AND o.withdrawn_at IS NULL AND j.withdrawn_at IS NULL AND o.media_type IN ('image/jpeg', 'image/png')`)
    .bind(c.var.ward.wardId, c.req.param("originalId"), c.req.param("projectId")).first<{ r2_path: string | null; media_type: string }>();
  if (!row?.r2_path) return c.notFound();
  const obj = await new WardBucket(c.env.ORIGINALS, c.var.ward.wardId).get(row.r2_path);
  if (!obj) return c.notFound();
  return new Response(obj.body, { headers: { "content-type": row.media_type, "cache-control": "private, no-store", "x-content-type-options": "nosniff" } });
});

reportPhotoAdmin.get("/photos/:projectId/:originalId/preview", async (c) => {
  if (!await photosAvailable(c.env, c.var.ward.wardId)) return c.notFound();
  const row = (await listDraftPhotos(c.env, c.var.ward.wardId, c.req.param("projectId")))
    .find((p) => p.original_id === c.req.param("originalId") && p.revision === c.req.query("revision"));
  if (row?.state !== "ready" || !row.prepared) return c.notFound();
  const photo = JSON.parse(row.prepared) as PreparedPhoto;
  return new Response(checkedMaskedPng(photo.png, photo.width, photo.height), { headers: { "content-type": "image/png", "cache-control": "private, no-store" } });
});

reportPhotoAdmin.post("/photos/:projectId/:originalId/:action", async (c) => {
  const { ward } = c.var;
  const projectId = c.req.param("projectId"), originalId = c.req.param("originalId"), action = c.req.param("action");
  const back = { href: adminPath(ward, `/photos/${projectId}`), label: "写真に戻る" };
  const project = await c.env.DB.prepare("SELECT project_id FROM projects WHERE ward_id = ? AND project_id = ? AND kind = 'event' AND closed_at IS NULL")
    .bind(ward.wardId, projectId).first();
  if (!project || !await photosAvailable(c.env, ward.wardId)) return c.notFound();
  if (action === "remove") {
    await c.env.DB.prepare("DELETE FROM report_photo_drafts WHERE ward_id = ? AND project_id = ? AND original_id = ?").bind(ward.wardId, projectId, originalId).run();
    return c.redirect(back.href, 303);
  }
  if (action !== "select" && action !== "edit") return c.notFound();
  try {
    const form = await c.req.formData();
    let wasUnmasked = false;
    if (action === "edit") {
      const row = (await listDraftPhotos(c.env, ward.wardId, projectId)).find((p) => p.original_id === originalId && p.revision === form.get("revision") && p.state === "ready");
      if (!row) return adminResult(c, "写真が変わりました。開き直してから直してください。", 409, back, "写真に戻れます。");
      wasUnmasked = row.mode === "none";
    }
    const masks = action === "select" ? [] : checkedMasks(JSON.parse(String(form.get("masks"))));
    const mode = action === "select" ? "auto" : form.get("unmasked") === "yes" ? "none" : wasUnmasked && !masks.length ? "auto" : "manual";
    await queueReportPhoto(c.env, ward.wardId, projectId, originalId, { mode, masks }, c.executionCtx);
    return c.redirect(`${back.href}?saved=1`, 303);
  } catch {
    return adminResult(c, "写真を準備できませんでした。報告は写真なしでも配れます。", 400, back, "もう一度写真を選べます。");
  }
});

