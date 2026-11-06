import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Bundle } from "../core/bundle";
import { WardBucket } from "../core/storage";
import { Hint, Layout } from "../core/ui";
import type { AdminEnv, WardEnv } from "../env";
import { receiveOriginal } from "../intake/api";
import { articleParagraphs } from "../publish";
import { createInvite, enterWithPassphrase, exchangeInvite, findMember, getSpace, getSpaceMaterials, makePassphrase, openSpace, closeSpace, type SpaceCredential } from "./api";
import { MaterialsTable } from "./materials";

const admin = new Hono<AdminEnv>();
const pub = new Hono<WardEnv>();

admin.get("/space/:projectId", async (c) => {
  const projectId = c.req.param("projectId");
  const project = await c.env.DB.prepare("SELECT title FROM projects WHERE ward_id = ? AND project_id = ?")
    .bind(c.var.ward.wardId, projectId).first<{ title: string }>();
  if (!project) return c.notFound();
  const space = await getSpace(c.env.DB, c.var.ward.wardId, projectId);
  c.header("Cache-Control", "private, no-store");
  return c.html(
    <Layout title={`プロジェクトの空間 - ${project.title}`} siteName={c.var.ward.name} noindex adminHomeHref={adminPath(c.var.ward.slug, "/")}>
      <h1>{project.title} の空間 <Hint text="実行委員や班長が入る場所を用意する画面です。合言葉は用意してあります。そのまま開くか、書き換えて使えます。" /></h1>
      <p>実行委員や班長に、当番表や出欠を見てもらう場所です。</p>
      <p>状態: {space?.closed_at ? "閉じています" : space ? "開いています" : "まだ開いていません"}</p>
      {c.req.query("opened") === "1" ? <p role="status">空間を開きました。開く時に表示した合言葉と、下の空間のリンクを実行委員に伝えてください。</p> : null}
      <details open={!space || Boolean(space.closed_at)}><summary>{space && !space.closed_at ? "合言葉を変えて開き直す" : "合言葉を使って空間を開く"}</summary><form method="post" action={adminPath(c.var.ward.slug, `/space/${encodeURIComponent(projectId)}/open`)} class="panel">
        <p>{space && !space.closed_at ? "合言葉を変えて開き直す時に使います。" : "この合言葉を使えます。好きな言葉に書き換えることもできます。"}</p>
        <label for="passphrase">{space && !space.closed_at ? "開き直す時の新しい合言葉" : "合言葉"}</label><input id="passphrase" name="passphrase" type="text" value={makePassphrase()} minLength={6} maxLength={120} required autocomplete="off" />
        <p>開く前に合言葉を控えて、実行委員に伝えてください。</p>
        <button type="submit">空間を開く</button> <Hint text="入力した合言葉で空間を開き、それまでの招待や入室の情報は使えなくします。" />
      </form></details>
      {space && !space.closed_at ? <>
        <form method="post" action={adminPath(c.var.ward.slug, `/space/${encodeURIComponent(projectId)}/invite`)} class="panel">
          <h2>一人ずつ招待する</h2><label for="invite-role">入る人</label><select id="invite-role" name="role"><option value="member">実行委員</option><option value="leader">班長</option></select>
          <label for="invite-district">班（班長だけ）</label><input id="invite-district" name="district" type="text" maxLength={80} />
          <button type="submit">招待リンクを作る</button> <Hint text="選んだ実行委員か班長が、一度だけ使って空間に入れるリンクを作ります。" />
        </form>
        <form method="post" action={adminPath(c.var.ward.slug, `/space/${encodeURIComponent(projectId)}/leader`)} class="panel">
          <h2>班長の専用URL</h2><label for="leader-district">班</label><input id="leader-district" name="district" type="text" maxLength={80} required />
          <button type="submit">専用URLを作る</button> <Hint text="指定した班の出欠を見るための専用URLを作ります。" />
        </form>
        <form method="post" action={adminPath(c.var.ward.slug, `/space/${encodeURIComponent(projectId)}/close`)}><button class="danger" type="submit">空間を閉じる</button> <Hint text="実行委員や班長がこの空間を開けなくなります。" /></form>
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
  return c.redirect(adminPath(c.var.ward.slug, `/space/${encodeURIComponent(c.req.param("projectId"))}?opened=1`), 303);
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
    return c.html(<Layout title="招待リンク" siteName={c.var.ward.name} noindex adminHomeHref={adminPath(c.var.ward.slug, "/")}><h1>招待リンク <Hint text="空間に入るための招待リンクです。表示されたURLを、招待したい一人にだけ渡してください。" /></h1><p>一度使うと無効になります。相手にだけ渡してください。</p><p class="secret">{url}</p><p><a href={adminPath(c.var.ward.slug, `/space/${encodeURIComponent(c.req.param("projectId"))}`)}>空間の管理に戻る</a></p></Layout>);
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
    return c.html(<Layout title="班長の専用URL" siteName={c.var.ward.name} noindex adminHomeHref={adminPath(c.var.ward.slug, "/")}><h1>{district}の班長の専用URL <Hint text="指定した班の出欠を見られるURLです。該当する班長にだけ渡してください。" /></h1><p>このURLを知っている人だけが使えます。該当する班長にだけ渡してください。</p><p class="secret">{url}</p><p><a href={adminPath(c.var.ward.slug, `/space/${encodeURIComponent(c.req.param("projectId"))}`)}>空間の管理に戻る</a></p></Layout>);
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
  if (!credential) return c.html(<Layout title="入れませんでした" siteName={await spaceSiteName(c)}><h1>入れませんでした</h1><p>もう一度入れてください。分からないときは役員に聞いてください</p><p><a href={`/${c.var.ward.slug}/space/${c.req.param("projectId")}`}>もう一度入力する</a></p></Layout>, 403);
  setSpaceCookie(c, credential);
  return c.redirect(`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(credential.projectId)}`, 303);
});

pub.get("/space/:projectId/send-error", async (c) => c.html(<Layout title="送れませんでした" siteName={await spaceSiteName(c)}><p>送れませんでした。もう一度お願いします</p></Layout>, 400));

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

pub.post("/space/:projectId/send", (c) => sendMaterial(c, "general"));
pub.post("/space/:projectId/send-answer", (c) => sendMaterial(c, "answer_sheet"));

async function sendMaterial(c: Context<WardEnv>, readKind: "general" | "answer_sheet") {
  const projectId = c.req.param("projectId");
  if (!projectId) return c.notFound();
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
      readKind,
      parts: [{ kind: "photo", filename: file.name, mediaType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }],
    });
    return c.redirect(`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(projectId)}?sent=${readKind === "answer_sheet" ? "answer" : "paper"}`, 303);
  } catch {
    return c.redirect(`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(projectId)}/send-error`, 303);
  }
}

async function renderSpace(c: Context<WardEnv>, direct: string | null) {
  const projectId = c.req.param("projectId");
  if (!projectId) return c.notFound();
  const project = await c.env.DB.prepare("SELECT title, closed_at FROM projects WHERE ward_id = ? AND project_id = ?").bind(c.var.ward.wardId, projectId).first<{ title: string; closed_at: string | null }>();
  if (!project) return c.notFound();
  if (project.closed_at) return closedNotice(c);
  const state = await getSpace(c.env.DB, c.var.ward.wardId, projectId);
  if (!state || state.closed_at) return closedNotice(c);
  const fromCookie = await cookieMember(c, projectId);
  const credential = direct ? await findMember(c.env.DB, c.var.ward.wardId, projectId, direct) : fromCookie;
  if (!credential) return c.html(<Layout title={`入る - ${project.title}`} siteName={`${c.var.ward.name} ${project.title}`}><h1>{project.title} の空間 <Hint text="実行委員や班長が資料を見る場所です。役員から届いた合言葉を入れてください。" /></h1><form method="post" action={`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(projectId)}/enter`}><label for="passphrase">合言葉</label><input id="passphrase" name="passphrase" type="password" required /><button type="submit">入る</button></form></Layout>);
  if (direct) setSpaceCookie(c, credential);
  const data = await getSpaceMaterials(c.env.DB, c.var.ward.wardId, projectId, credential.role === "leader" ? credential.district : null);
  return c.html(
    <Layout title={`プロジェクトの空間 - ${project.title}`} siteName={`${c.var.ward.name} ${project.title}`}>
      <h1>{project.title} の空間 <Hint text="このプロジェクトの出欠や配られた資料を見る場所です。必要な資料を開き、書き込みのある紙は写真で送れます。" /></h1>
      {credential.role === "leader" && credential.district ? <p>{credential.district}の班長向け</p> : null}
      {c.req.query("sent") === "answer" ? <p role="status">回答票を受け取りました。読み取った内容は、役員画面と同じ回答の集計に入ります。</p> : c.req.query("sent") === "paper" ? <p role="status">紙を受け取りました。役員が配り直すまで、配った文書は変わりません。</p> : null}
      <h2>出欠</h2>
      {data.attendance.length ? <div class="panel"><table><thead><tr><th>班</th><th>世帯</th><th>人数</th></tr></thead><tbody>{data.attendance.map((row) => <tr><td>{row.district}</td><td>{row.household}</td><td>{row.people_count}</td></tr>)}</tbody></table></div> : <p>回答はまだありません。</p>}
      <h2>協賛先と打診</h2>{data.tablesRecorded ? <MaterialsTable table="sponsors" items={data.items} /> : <p>{data.tablesPublished ? "配った時の表の記録がありません。役員に聞いてください。" : "まだ配っていません。"}</p>}
      <h2>当番表と配置図 <Hint text="配った時の当番表と配置図です。役員が配り直すまで変わりません。" /></h2>
      {data.tablesRecorded ? <><MaterialsTable table="duties" items={data.items} /><MaterialsTable table="layout" items={data.items} /></>
        : <p>{data.tablesPublished ? "配った時の表の記録がありません。役員に聞いてください。" : "まだ配っていません。"}</p>}
      <h2>配った文書 <Hint text="役員が実行委員と班長に配った文書です。役員が作り直している途中の文書は出ません。" /></h2>
      {data.documents.length ? data.documents.map((doc) => <section class="panel"><h3>{doc.title}</h3>{articleParagraphs(doc.body).map((text, index) => <p key={index} style="white-space:pre-wrap;overflow-wrap:anywhere">{text}</p>)}</section>) : <p>文書はまだ配っていません。</p>}
      <h2>写真と入った物</h2>{data.originals.map((file) => <p><a href={`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(projectId)}/file/${encodeURIComponent(file.original_id)}`}>{file.filename}</a></p>)}
      <h2>回答票を撮って送る <Hint text="集まった回答票を撮って送ると、役員画面と同じ回答の集計に入ります。一枚の写真に複数の回答票が写っていても送れます。" /></h2>
      <form class="panel" method="post" action={`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(projectId)}/send-answer`} enctype="multipart/form-data"><label for="answer-file">回答票の写真またはPDF</label><input id="answer-file" name="file" type="file" accept="image/*,.pdf" capture="environment" required /><p><button type="submit">回答票を送る</button></p></form>
      <h2>当番表や当日の紙を撮って送る <Hint text="書き込みのある当番表、配置図、当日の紙などを送れます。配った文書は、役員が配り直すまで変わりません。" /></h2>
      <form class="panel" method="post" action={`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(projectId)}/send`} enctype="multipart/form-data"><label for="file">写真またはPDF</label><input id="file" name="file" type="file" accept="image/*,.pdf" capture="environment" required /><p><button type="submit">当番表や当日の紙を送る</button></p></form>
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

async function spaceSiteName(c: Context<WardEnv>): Promise<string> {
  const project = await c.env.DB.prepare("SELECT title FROM projects WHERE ward_id = ? AND project_id = ?")
    .bind(c.var.ward.wardId, c.req.param("projectId")).first<{ title: string }>();
  return project ? c.var.ward.name + " " + project.title : c.var.ward.name;
}

async function closedNotice(c: Context<WardEnv>) {
  return c.html(<Layout title="閉じました" siteName={await spaceSiteName(c)}><p>閉じました。役員に聞いてください</p></Layout>, 403);
}

export const space: Bundle = { admin, pub };

function adminPath(wardSlug: string, path: string): string {
  return `/${encodeURIComponent(wardSlug)}/admin${path}`;
}
