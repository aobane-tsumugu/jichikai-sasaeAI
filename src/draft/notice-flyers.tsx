import type { Context, Hono } from "hono";
import type { AdminEnv, Env } from "../env";
import { adminPath } from "../core/auth";
import { WardBucket } from "../core/storage";
import { PHOTO_SCRIPT } from "../intake/photo-script";
import { imageDimensions } from "../intake/photo";
import { officerGroupId } from "../line/api";
import { formatJst } from "../core/time";

export interface NoticeFlyer {
  version_id: string;
  flyer_id: string | null;
  r2_path: string | null;
  preview_r2_path: string | null;
}
interface MaterialPhoto { original_id: string; filename: string; r2_path: string; media_type: string; received_at: string; project_title: string | null }

/**
 * 画像に選べる写真。役員の画面から送った写真と、役員のLINEグループに届いた写真を、準備を問わず並べる（L-311）。
 * チラシかどうか、配る物かどうかはAIに当てさせない。問い合わせとして入った物と、住民から個別に届いた写真は含めない。
 */
export async function flyerMaterials(env: Env, wardId: string, projectId: string): Promise<MaterialPhoto[]> {
  const group = await officerGroupId(env, wardId);
  const rows = await env.DB.prepare(`SELECT o.original_id, o.filename, o.r2_path, o.media_type, o.received_at, p.title AS project_title
    FROM originals o JOIN jobs j ON j.ward_id = o.ward_id AND j.job_id = o.job_id
    LEFT JOIN projects p ON p.ward_id = j.ward_id AND p.project_id = j.project_id
    WHERE o.ward_id = ? AND o.withdrawn_at IS NULL AND o.r2_path IS NOT NULL
      AND o.media_type IN ('image/jpeg', 'image/png') AND j.withdrawn_at IS NULL
      -- 住民に出る画像の候補。どの準備の資料にも入っていない写真（年賀状や予約票など）は出さない（前提 21）。
      AND j.project_id IS NOT NULL
      AND (j.via = 'admin' OR EXISTS (
        SELECT 1 FROM line_inbox_items i LEFT JOIN line_bundle_decisions d
          ON d.ward_id = i.ward_id AND d.bundle_id = i.bundle_id
        WHERE i.ward_id = o.ward_id AND i.job_id = o.job_id AND i.source_type = 'group' AND i.source_id = ?
          AND COALESCE(d.action, 'material') NOT IN ('inquiry', 'unrelated')))
    ORDER BY COALESCE(j.project_id = ?, 0) DESC, o.received_at DESC, o.original_id LIMIT 40`).bind(wardId, group ?? "", projectId).all<MaterialPhoto>();
  return rows.results;
}

export async function draftFlyer(db: D1Database, wardId: string, projectId: string, kind: string): Promise<NoticeFlyer | null> {
  return db.prepare(`SELECT f.* FROM notice_flyers f JOIN document_versions v
      ON v.ward_id = f.ward_id AND v.version_id = f.version_id
    JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
    WHERE f.ward_id = ? AND f.project_id = ? AND d.kind = ? AND v.published_at IS NULL
      AND v.version_no = (SELECT MAX(v2.version_no) FROM document_versions v2
        WHERE v2.ward_id = v.ward_id AND v2.document_id = v.document_id)`)
    .bind(wardId, projectId, kind).first<NoticeFlyer>();
}

export async function previousFlyer(db: D1Database, wardId: string, projectId: string, kind: string): Promise<boolean> {
  const previous = await db.prepare(`SELECT f.flyer_id FROM publication_records r LEFT JOIN notice_flyers f
      ON f.ward_id = r.ward_id AND f.version_id = r.version_id
    JOIN documents d ON d.ward_id = r.ward_id AND d.document_id = r.document_id
    WHERE r.ward_id = ? AND r.project_id = ? AND (d.kind = ? OR (? = 'notice' AND d.kind = 'announcement'))
    ORDER BY r.published_at DESC, r.rowid DESC LIMIT 1`)
    .bind(wardId, projectId, kind, kind).first<{ flyer_id: string | null }>();
  return !!previous?.flyer_id;
}

export async function flyerPanelState(env: Env, wardId: string, projectId: string, kind: string) {
  const [current, previous, materials] = await Promise.all([
    draftFlyer(env.DB, wardId, projectId, kind), previousFlyer(env.DB, wardId, projectId, kind), flyerMaterials(env, wardId, projectId),
  ]);
  return { current, previous, materials };
}

export function FlyerPanel({ c, projectId, state }: {
  c: Context<AdminEnv>; projectId: string; state: Awaited<ReturnType<typeof flyerPanelState>>;
}) {
  const { current, previous, materials } = state;
  const ask = previous && !current;
  return <fieldset><legend>画像を付ける</legend>
    <p>チラシや写真を一枚付けられます。付けると、住民向けのページと自治会のLINEで、文のあとに画像が出ます。印刷する紙には付きません。</p>
    {ask ? <p>前の知らせにはチラシの画像が付いていました。付け直しますか？</p> : null}
    {current?.flyer_id ? <><img src={adminPath(c.var.ward, `/projects/${projectId}/flyer/${current.version_id}`)} alt="付けたチラシ" style="max-width:100%;height:auto" />
      <label><input type="radio" name="flyer_choice" value="keep" checked />付けた画像を使う</label></> : null}
    <label><input type="radio" name="flyer_choice" value="none" checked={!ask && !current?.flyer_id} required={ask} />{current?.flyer_id ? "画像を外す" : "画像を付けない"}</label>
    <label><input type="radio" name="flyer_choice" value="attach" required={ask} />{ask ? "画像を付け直す" : "画像を付ける"}</label>
    <label>スマホやパソコンの画像<input type="file" name="flyer_file" accept="image/*" /></label>
    {materials.length ? <label>届いた写真から選ぶ（役員の画面と、役員のLINEグループに届いたもの）<select name="flyer_material"><option value="">写真を選んでください</option>
      {materials.map((photo) => <option value={photo.original_id}>{formatJst(photo.received_at)}　{photo.project_title ?? "自治会の資料"}　{photo.filename || "写真"}</option>)}</select></label> : null}
    <p class="help-text">写真、JPEG、PNGを使えます。WordやPDFは付けられません。保存しただけでは住民には見えません。</p>
    <p role="status" data-flyer-status="" aria-live="polite"></p>
    <script dangerouslySetInnerHTML={{ __html: PHOTO_SCRIPT }} />
    <script dangerouslySetInnerHTML={{ __html: FLYER_SCRIPT }} />
  </fieldset>;
}

// PHOTO_SCRIPTの変換ができなかった場合は原本を送らず、ここで選び直せるようにする。
export const FLYER_SCRIPT = String.raw`(() => {
  const form = document.currentScript.closest('form');
  if (!form) return;
  form.querySelectorAll('[name="flyer_file"], [name="flyer_material"]').forEach(input => input.addEventListener('change', () => {
    form.querySelector('[name="flyer_choice"][value="attach"]').checked = true;
  }));
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (form.dataset.sending === '1') return;
    form.dataset.sending = '1';
    const status = form.querySelector('[data-flyer-status]');
    status.textContent = '保存しています…';
    const data = new FormData(form);
    if (event.submitter && event.submitter.name) data.set(event.submitter.name, event.submitter.value);
    try {
      if (data.get('flyer_choice') === 'attach') {
        let file = data.get('flyer_file');
        const material = data.get('flyer_material');
        if (file && file.size && material) throw new Error('送る画像か資料の写真の、どちらか一枚を選んでください。');
        if ((!file || !file.size) && material) {
          const base = form.action.replace(/\/draft\/.*$/, '');
          const response = await fetch(base + '/flyer-material/' + encodeURIComponent(material), { credentials: 'same-origin' });
          if (!response.ok) throw new Error('写真を読めませんでした。選び直してください。');
          const blob = await response.blob();
          file = new File([blob], 'flyer', { type: blob.type });
        }
        if (!file || !file.size || !/^image\//i.test(file.type)) throw new Error('チラシの画像を一枚選んでください。');
        const prepared = await window.__sendPhoto.preparePhoto(file);
        if (!prepared.sourceHash || prepared.file.type !== 'image/jpeg') throw new Error('画像を整えられませんでした。JPEGかPNGの画像を選び直してください。');
        data.set('flyer_file', prepared.file, 'flyer.jpg');
        data.set('flyer_prepared', 'jpeg');
        // LINEの小さい見本は1MBまで。必要な画像だけ縮めた写しを作る。
        if (prepared.file.size > 1024 * 1024) {
          const url = URL.createObjectURL(prepared.file);
          try {
            const img = await new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = reject; image.src = url; });
            const canvas = document.createElement('canvas');
            const scale = Math.min(1, 640 / Math.max(img.width, img.height));
            canvas.width = Math.max(1, Math.round(img.width * scale)); canvas.height = Math.max(1, Math.round(img.height * scale));
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            const preview = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8));
            canvas.width = 0; canvas.height = 0;
            if (!preview || preview.size > 1024 * 1024) throw new Error('画像を整えられませんでした。小さな画像を選び直してください。');
            data.set('flyer_preview', preview, 'preview.jpg');
          } finally { URL.revokeObjectURL(url); }
        }
      } else { data.delete('flyer_file'); data.delete('flyer_material'); }
      const response = await fetch(form.action, { method: 'POST', body: data, credentials: 'same-origin' });
      if (response.redirected) { location.assign(response.url); return; }
      if (response.headers.get('content-type')?.includes('text/html')) {
        document.open(); document.write(await response.text()); document.close(); return;
      }
      throw new Error('保存できませんでした。もう一度お試しください。');
    } catch (error) { status.textContent = error.message || '保存できませんでした。電波を確かめて、もう一度お試しください。'; }
    form.dataset.sending = '';
  });
})();`;

type FlyerInput = { current: NoticeFlyer | null; image: ArrayBuffer | null; preview: ArrayBuffer | null };
async function jpeg(file: File | string | null, max: number): Promise<ArrayBuffer | null> {
  if (!file || typeof file === "string" || !file.size || file.size > max || file.type !== "image/jpeg") return null;
  const bytes = await file.arrayBuffer();
  const view = new Uint8Array(bytes);
  const size = imageDimensions(view);
  return size && size.width <= 2400 && size.height <= 2400 && view[0] === 0xff && view[1] === 0xd8 && view[2] === 0xff && view[view.length - 2] === 0xff && view[view.length - 1] === 0xd9 ? bytes : null;
}

/** ファイル名だけを信じて文書を画像として公開しない。AIにはこの保存の入口を渡さない。 */
export async function readFlyerInput(env: Env, wardId: string, projectId: string, kind: string, form: FormData): Promise<FlyerInput | string> {
  const current = await draftFlyer(env.DB, wardId, projectId, kind);
  const choice = String(form.get("flyer_choice") ?? "");
  if (!choice && !current && await previousFlyer(env.DB, wardId, projectId, kind)) return "前の知らせにはチラシの画像が付いていました。付け直すか、付けないかを選んでください。";
  if (choice === "keep" && !current?.flyer_id) return "チラシの画像を選び直してください。";
  if (choice === "keep" || (!choice && current)) return { current, image: null, preview: null };
  if (!choice || choice === "none") return { current: null, image: null, preview: null };
  if (choice !== "attach" || form.get("flyer_prepared") !== "jpeg") return "画像を整えられませんでした。JPEGかPNGの画像を選び直してください。";
  const material = String(form.get("flyer_material") ?? "");
  if (material && !(await flyerMaterials(env, wardId, projectId)).some((photo) => photo.original_id === material)) return "届いた写真から選び直してください。";
  const image = await jpeg(form.get("flyer_file"), 5 * 1024 * 1024);
  if (!image) return "JPEGの画像を5MB以内に整えてから、もう一度保存してください。";
  const preview = image.byteLength <= 1024 * 1024 ? image : await jpeg(form.get("flyer_preview"), 1024 * 1024);
  if (!preview) return "小さい見本の画像を作れませんでした。画像を選び直してください。";
  return { current: null, image, preview };
}

export async function saveFlyer(env: Env, wardId: string, projectId: string, versionId: string, input: FlyerInput): Promise<void> {
  let flyer = input.current;
  const bucket = new WardBucket(env.ORIGINALS, wardId);
  const uploaded: string[] = [];
  try {
    if (input.image && input.preview) {
      const id = crypto.randomUUID();
      const path = `notice-flyers/${id}.jpg`;
      const previewPath = input.preview === input.image ? path : `notice-flyers/${id}-preview.jpg`;
      await bucket.put(path, input.image, { httpMetadata: { contentType: "image/jpeg" } }); uploaded.push(path);
      if (previewPath !== path) { await bucket.put(previewPath, input.preview, { httpMetadata: { contentType: "image/jpeg" } }); uploaded.push(previewPath); }
      flyer = { version_id: versionId, flyer_id: id, r2_path: path, preview_r2_path: previewPath };
    }
    const result = await env.DB.prepare(`INSERT INTO notice_flyers (ward_id, project_id, version_id, flyer_id, r2_path, preview_r2_path)
      SELECT ?, ?, v.version_id, ?, ?, ? FROM document_versions v
      WHERE v.ward_id = ? AND v.project_id = ? AND v.version_id = ? AND v.published_at IS NULL`)
      .bind(wardId, projectId, flyer?.flyer_id ?? null, flyer?.r2_path ?? null, flyer?.preview_r2_path ?? null, wardId, projectId, versionId).run();
    if (result.meta.changes !== 1) throw new Error("チラシの画像を保存できませんでした");
  } catch (error) {
    for (const path of uploaded) await bucket.delete(path);
    throw error;
  }
}

export function mountFlyerRoutes(admin: Hono<AdminEnv>) {
  admin.get("/projects/:projectId/flyer-material/:originalId", async (c) => {
    const photo = (await flyerMaterials(c.env, c.var.ward.wardId, c.req.param("projectId")))
      .find((row) => row.original_id === c.req.param("originalId"));
    if (!photo) return c.notFound();
    const object = await new WardBucket(c.env.ORIGINALS, c.var.ward.wardId).get(photo.r2_path);
    if (!object || object.size > 25 * 1024 * 1024) return c.notFound();
    return new Response(object.body, { headers: { "Content-Type": photo.media_type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
  });
  admin.get("/projects/:projectId/flyer/:versionId", async (c) => {
    const flyer = await c.env.DB.prepare(`SELECT r2_path FROM notice_flyers WHERE ward_id = ? AND project_id = ? AND version_id = ?`)
      .bind(c.var.ward.wardId, c.req.param("projectId"), c.req.param("versionId")).first<{ r2_path: string | null }>();
    if (!flyer?.r2_path) return c.notFound();
    const object = await new WardBucket(c.env.ORIGINALS, c.var.ward.wardId).get(flyer.r2_path);
    return object ? new Response(object.body, { headers: { "Content-Type": "image/jpeg", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } }) : c.notFound();
  });
}
