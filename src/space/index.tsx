import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Bundle } from "../core/bundle";
import { WardBucket } from "../core/storage";
import { Layout } from "../core/ui";
import type { AdminEnv, WardEnv } from "../env";
import { receiveOriginal } from "../intake/api";
import { createInvite, enterWithPassphrase, exchangeInvite, findMember, getSpace, getSpaceMaterials, openSpace, closeSpace, type SpaceCredential } from "./api";

const admin = new Hono<AdminEnv>();
const pub = new Hono<WardEnv>();

admin.get("/space/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const project = await c.env.DB.prepare("SELECT title FROM projects WHERE ward_id = ? AND project_id = ?")
    .bind(c.var.ward.wardId, projectId).first<{ title: string }>();
  if (!project) return c.notFound();
  const space = await getSpace(c.env.DB, c.var.ward.wardId, projectId);
  return c.html(
    <Layout title={`プロジェクトの空間 - ${project.title}`} siteName={c.var.ward.name} noindex adminHomeHref={adminPath(c.var.ward.slug, "/")}>
      <h1>{project.title} の空間</h1>
      <p>状態: {space?.closed_at ? "閉じています" : space ? "開いています" : "まだ開いていません"}</p>
      <form method="post" action={adminPath(c.var.ward.slug, `/space/${encodeURIComponent(projectId)}/open`)} class="panel">
        <label for="passphrase">合言葉</label><input id="passphrase" name="passphrase" type="text" minLength={6} maxLength={120} required />
        <button type="submit">空間を開く</button>
      </form>
      {space && !space.closed_at ? <>
        <form method="post" action={adminPath(c.var.ward.slug, `/space/${encodeURIComponent(projectId)}/invite`)} class="panel">
          <h2>一人ずつ招待する</h2><label for="invite-role">入る人</label><select id="invite-role" name="role"><option value="member">実行委員</option><option value="leader">班長</option></select>
          <label for="invite-district">班（班長だけ）</label><input id="invite-district" name="district" type="text" maxLength={80} />
          <button type="submit">招待リンクを作る</button>
        </form>
        <form method="post" action={adminPath(c.var.ward.slug, `/space/${encodeURIComponent(projectId)}/leader`)} class="panel">
          <h2>班長の専用URL</h2><label for="leader-district">班</label><input id="leader-district" name="district" type="text" maxLength={80} required />
          <button type="submit">専用URLを作る</button>
        </form>
        <form method="post" action={adminPath(c.var.ward.slug, `/space/${encodeURIComponent(projectId)}/close`)}><button class="danger" type="submit">空間を閉じる</button></form>
        <p><a href={`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(projectId)}`}>空間を開く</a></p>
      </> : null}
    </Layout>,
  );
});

admin.post("/space/:projectId/open", async (c) => {
  const form = await c.req.parseBody();
  const passphrase = typeof form.passphrase === "string" ? form.passphrase.trim() : "";
  if (passphrase.length < 6 || passphrase.length > 120) return c.text("合言葉は 6 文字以上で入力してください。", 400);
  try {
    await openSpace(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), passphrase, c.var.account.accountId);
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "空間を開けませんでした。", 400);
  }
  return c.redirect(adminPath(c.var.ward.slug, `/space/${encodeURIComponent(c.req.param("projectId"))}`), 303);
});

admin.post("/space/:projectId/close", async (c) => {
  await closeSpace(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), c.var.account.accountId);
  return c.redirect(adminPath(c.var.ward.slug, `/space/${encodeURIComponent(c.req.param("projectId"))}`), 303);
});

admin.post("/space/:projectId/invite", async (c) => {
  const form = await c.req.parseBody();
  const role = form.role === "leader" ? "leader" : "member";
  const district = role === "leader" && typeof form.district === "string" ? form.district.trim() : null;
  if (role === "leader" && !district) return c.text("班を入力してください。", 400);
  try {
    const token = await createInvite(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), role, district, c.var.account.accountId);
      const url = `${new URL(c.req.url).origin}/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(c.req.param("projectId"))}/join/${token}`;
    return c.html(<Layout title="招待リンク" siteName={c.var.ward.name} noindex><h1>招待リンク</h1><p>一度使うと無効になります。相手にだけ渡してください。</p><p class="secret">{url}</p><p><a href={adminPath(c.var.ward.slug, `/space/${encodeURIComponent(c.req.param("projectId"))}`)}>空間の管理に戻る</a></p></Layout>);
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "招待を作れませんでした。", 400);
  }
});

admin.post("/space/:projectId/leader", async (c) => {
  const form = await c.req.parseBody();
  const district = typeof form.district === "string" ? form.district.trim() : "";
  if (!district) return c.text("班を入力してください。", 400);
  try {
    const token = await createInvite(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), "leader", district, c.var.account.accountId, true);
    const url = `${new URL(c.req.url).origin}/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(c.req.param("projectId"))}/person/${token}`;
    return c.html(<Layout title="班長の専用URL" siteName={c.var.ward.name} noindex><h1>{district}の班長の専用URL</h1><p>このURLを知っている人だけが使えます。該当する班長にだけ渡してください。</p><p class="secret">{url}</p><p><a href={adminPath(c.var.ward.slug, `/space/${encodeURIComponent(c.req.param("projectId"))}`)}>空間の管理に戻る</a></p></Layout>);
  } catch (error) {
    return c.text(error instanceof Error ? error.message : "専用URLを作れませんでした。", 400);
  }
});

pub.get("/space/:projectId", async (c) => renderSpace(c, null));

pub.get("/space/:projectId/join/:token", async (c) => {
  const credential = await exchangeInvite(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), c.req.param("token"));
  if (!credential) return closedNotice(c);
  setSpaceCookie(c, credential);
  return c.redirect(`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(credential.projectId)}`, 303);
});

pub.get("/space/:projectId/person/:token", async (c) => {
  const credential = await findMember(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), c.req.param("token"));
  if (!credential) return closedNotice(c);
  setSpaceCookie(c, credential);
  return c.redirect(`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(credential.projectId)}`, 303);
});

pub.post("/space/:projectId/enter", async (c) => {
  const form = await c.req.parseBody();
  const passphrase = typeof form.passphrase === "string" ? form.passphrase : "";
  const credential = await enterWithPassphrase(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), passphrase);
  if (!credential) return c.html(<Layout title="入れませんでした" siteName={c.var.ward.name}><h1>合言葉を確認してください</h1><p><a href={`/${c.var.ward.slug}/space/${c.req.param("projectId")}`}>もう一度入力する</a></p></Layout>, 403);
  setSpaceCookie(c, credential);
  return c.redirect(`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(credential.projectId)}`, 303);
});

pub.get("/space/:projectId/send-error", (c) => c.html(<Layout title="送れませんでした" siteName={c.var.ward.name}><p>送れませんでした。もう一度お願いします</p></Layout>, 400));

pub.get("/space/:projectId/file/:originalId", async (c) => {
  const projectId = c.req.param("projectId");
  const credential = await cookieMember(c, projectId);
  if (!credential) return closedNotice(c);
  const file = await c.env.DB.prepare(
    `SELECT o.r2_path, o.filename, o.media_type FROM originals o JOIN jobs j
     ON j.ward_id = o.ward_id AND j.job_id = o.job_id
     WHERE o.ward_id = ? AND o.original_id = ? AND j.project_id = ? AND j.via = 'space' AND o.withdrawn_at IS NULL AND j.withdrawn_at IS NULL`,
  ).bind(c.var.ward.wardId, c.req.param("originalId"), projectId).first<{ r2_path: string | null; filename: string; media_type: string }>();
  if (!file?.r2_path) return c.notFound();
  const object = await new WardBucket(c.env.ORIGINALS, c.var.ward.wardId).get(file.r2_path);
  if (!object) return c.notFound();
  return c.body(object.body, 200, {
    "Content-Type": file.media_type,
    "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
});

pub.post("/space/:projectId/send", async (c) => {
  const projectId = c.req.param("projectId");
  const credential = await cookieMember(c, projectId);
  if (!credential) return c.redirect(`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(projectId)}/send-error`, 303);
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.redirect(`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(projectId)}/send-error`, 303);
  try {
    await receiveOriginal(c.env, c.executionCtx, {
      wardId: c.var.ward.wardId,
      projectId,
      via: "space",
      parts: [{ kind: "photo", filename: file.name, mediaType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }],
    });
    return c.redirect(`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(projectId)}`, 303);
  } catch {
    return c.redirect(`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(projectId)}/send-error`, 303);
  }
});

async function renderSpace(c: Context<WardEnv>, direct: string | null) {
  const projectId = c.req.param("projectId");
  if (!projectId) return c.notFound();
  const project = await c.env.DB.prepare("SELECT title FROM projects WHERE ward_id = ? AND project_id = ?").bind(c.var.ward.wardId, projectId).first<{ title: string }>();
  if (!project) return c.notFound();
  const state = await getSpace(c.env.DB, c.var.ward.wardId, projectId);
  if (!state || state.closed_at) return closedNotice(c);
  const fromCookie = await cookieMember(c, projectId);
  const credential = direct ? await findMember(c.env.DB, c.var.ward.wardId, projectId, direct) : fromCookie;
  if (!credential) return c.html(<Layout title={`入る - ${project.title}`} siteName={c.var.ward.name}><h1>{project.title} の空間</h1><form method="post" action={`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(projectId)}/enter`}><label for="passphrase">合言葉</label><input id="passphrase" name="passphrase" type="password" required /><button type="submit">入る</button></form></Layout>);
  if (direct) setSpaceCookie(c, credential);
  const data = await getSpaceMaterials(c.env.DB, c.var.ward.wardId, projectId, credential.role === "leader" ? credential.district : null);
  return c.html(
    <Layout title={`プロジェクトの空間 - ${project.title}`} siteName={c.var.ward.name}>
      <h1>{project.title} の空間</h1>
      {credential.role === "leader" && credential.district ? <p>{credential.district}の班長向け</p> : null}
      <h2>出欠</h2>
      {data.attendance.length ? <div class="panel"><table><thead><tr><th>班</th><th>世帯</th><th>人数</th></tr></thead><tbody>{data.attendance.map((row) => <tr><td>{row.district}</td><td>{row.household}</td><td>{row.people_count}</td></tr>)}</tbody></table></div> : <p>回答はまだありません。</p>}
      <h2>協賛先と打診</h2>{data.items.filter((item) => item.kind === "sponsors").map((item) => <pre class="panel">{JSON.stringify(item.data, null, 2)}</pre>)}
      <h2>当番表と配置図</h2>{data.items.filter((item) => item.kind === "duties" || item.kind === "layout").map((item) => <pre class="panel">{JSON.stringify(item.data, null, 2)}</pre>)}
      <h2>当日の紙など</h2>{data.documents.map((doc) => <details class="panel"><summary>{doc.title}</summary><pre>{doc.body}</pre></details>)}
      <h2>写真と入った物</h2>{data.originals.map((file) => <p><a href={`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(projectId)}/file/${encodeURIComponent(file.original_id)}`}>{file.filename}</a></p>)}
      <h2>撮って送る</h2><form method="post" action={`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(projectId)}/send`} enctype="multipart/form-data"><label for="file">写真またはファイル</label><input id="file" name="file" type="file" accept="image/*,.pdf" capture="environment" required /><button type="submit">送る</button></form>
    </Layout>,
  );
}

async function cookieMember(c: Context<WardEnv>, projectId: string): Promise<SpaceCredential | null> {
  const token = getCookie(c, `space_${projectId}`);
  return token ? findMember(c.env.DB, c.var.ward.wardId, projectId, token) : null;
}

function setSpaceCookie(c: Context<WardEnv>, credential: SpaceCredential): void {
  setCookie(c, `space_${credential.projectId}`, credential.token, { path: `/${c.var.ward.slug}/space/${credential.projectId}`, httpOnly: true, secure: new URL(c.req.url).protocol === "https:", sameSite: "Lax", maxAge: 30 * 24 * 60 * 60 });
}

function closedNotice(c: Context<WardEnv>) {
  return c.html(<Layout title="閉じました" siteName={c.var.ward.name}><p>閉じました。役員に聞いてください</p></Layout>, 403);
}

export const space: Bundle = { admin, pub };

function adminPath(wardSlug: string, path: string): string {
  return `/${encodeURIComponent(wardSlug)}/admin${path}`;
}
