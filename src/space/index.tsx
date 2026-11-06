import { getAnswerDeadline, getRoster, listAnswers } from "../answers/api";
import { countText } from "../answers/counts";
import { countMeetingAnswers } from "../answers/meeting-store";
import { isMeetingStatus, MeetingCounts, meetingText, meetingTotalsText } from "../answers/meeting";
import type { ProjectKind } from "../project/model";
import { residentContext } from "../answers/resident";
import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Bundle } from "../core/bundle";
import { WardBucket } from "../core/storage";
import { Layout, Notice } from "../core/ui";
import { AdminPage } from "../core/admin-ui";
import { getPublicContact } from "../settings/store";
import { formatJstDate } from "../core/time";
import { PrintDocument, Sheet, PrintQr } from "../print/a4";
import { qrSvg } from "../print";
import { receiveSpacePaper } from "./receive-paper";
import type { AdminEnv, WardEnv } from "../env";
import { receiveOriginal } from "../intake/api";
import { PhotoCheckNotice, photoChecks } from "../intake/photo-check";
import { articleParagraphs } from "../publish";
import { createInvite, enterWithPassphrase, exchangeInvite, findMember, getSpace, getSpaceMaterials, makePassphrase, openSpace, closeSpace, type SpaceCredential } from "./api";
import { MaterialsTable } from "./materials";

const admin = new Hono<AdminEnv>();
const pub = new Hono<WardEnv>();

async function renderAdminSpace(c: Context<AdminEnv>, passphrase?: string) {
  const projectId = c.req.param("projectId")!;
  const { ward, account } = c.var;
  const project = await c.env.DB.prepare("SELECT title, closed_at FROM projects WHERE ward_id = ? AND project_id = ?")
    .bind(ward.wardId, projectId).first<{ title: string; closed_at: string | null }>();
  if (!project) return c.notFound();
  const space = await getSpace(c.env.DB, ward.wardId, projectId);
  const opened = Boolean(space && !space.closed_at && !project.closed_at);
  const published = await c.env.DB.prepare(`SELECT document_id, version_no FROM document_versions
    WHERE ward_id = ? AND project_id = ? AND scope = 'public' AND published_at IS NOT NULL
    ORDER BY published_at DESC, rowid DESC LIMIT 1`).bind(ward.wardId, projectId).first<{ document_id: string; version_no: number }>();
  const base = adminPath(ward.slug, `/space/${encodeURIComponent(projectId)}`);
  c.header("Cache-Control", "private, no-store");
  return c.html(<AdminPage ward={ward} account={account} title="実行委員と班長のページ" back={{ href: adminPath(ward.slug, `/projects/${projectId}/map`), label: `${project.title}の段取りへ` }}>
    <h1>実行委員と班長のページ</h1><p class="lead">実行委員と班長が、配られたものを見て、紙を撮って送るページです。区のページとは別で、住民には見えません。</p>
    {opened ? <>
      <div class="notice done" role="status"><strong>開いています</strong><p>紙の案内を配ると、班長は班長への一枚のQRコードから入れます。</p></div>
      <section class="next"><strong>次は</strong>{published ? <><p>班長への一枚を印刷して、案内といっしょに渡してください。</p><a class="button" href={adminPath(ward.slug, `/print/${projectId}/${published.document_id}/${published.version_no}/leader`)}>班長への一枚を印刷する</a></> : <><p>案内を配ると、班長への一枚を印刷できます。</p><a class="button" href={adminPath(ward.slug, `/publish/${projectId}`)}>配る内容を見る</a></>}</section>
      <h2>実行委員に伝えること</h2>{passphrase ? <dl class="facts"><dt>合言葉</dt><dd>{passphrase}</dd></dl> : <p>合言葉は開くときに表示します。分からないときは、下の「合言葉を変える」から作り直せます。</p>}
      <p class="muted">この合言葉と入口を、LINEや電話で実行委員に伝えてください。</p><a class="quiet" href={`/${encodeURIComponent(ward.slug)}/space/${encodeURIComponent(projectId)}`}>実行委員のページの入口</a>
      <p>入口のQRコードです。スマホで読み取ると、合言葉を入れる画面が開きます。</p><div class="qrbox" dangerouslySetInnerHTML={{ __html: qrSvg(`${new URL(c.req.url).origin}/${encodeURIComponent(ward.slug)}/space/${encodeURIComponent(projectId)}`) }} />
      <details class="fold"><summary>一人用の入口を作る</summary><div><p>合言葉を使わずに入れる入口です。一度だけ使えます。</p><form method="post" action={`${base}/invite`}><input type="hidden" name="role" value="member" /><button class="secondary" type="submit">入口を作る</button></form></div></details>
      <details class="fold"><summary>合言葉を変える</summary><div><form method="post" action={`${base}/open`}><label for="passphrase">新しい合言葉</label><input id="passphrase" name="passphrase" type="text" value={makePassphrase()} minlength={6} maxlength={120} required autocomplete="off" /><button class="secondary" type="submit">変えてもう一度開く</button><p class="muted">今の合言葉と、作った入口は使えなくなります。合言葉を変えると、配った班長への一枚も作り直しです。</p></form></div></details>
      <details class="fold"><summary>このページを閉じる</summary><div><p>実行委員と班長が開けなくなります。役員はあとでもう一度開けます。</p><form method="post" action={`${base}/close`}><button class="secondary" type="submit">閉じる</button></form></div></details>
    </> : <>
      <Notice>{project.closed_at ? "この行事は閉じています。" : space?.closed_at ? "閉じています。もう一度開けます。" : "まだ開いていません。"}</Notice>
      {!project.closed_at ? <form method="post" action={`${base}/open`}><label for="passphrase">合言葉</label><input id="passphrase" name="passphrase" type="text" value={makePassphrase()} minlength={6} maxlength={120} required autocomplete="off" /><p>この合言葉を使えます。書き換えることもできます。</p><button type="submit">開く</button></form> : null}
    </>}
    <p>間違えたときは、このページを閉じられます。閉じたあとも、もう一度開けます。</p>
  </AdminPage>);
}
admin.get("/space/:projectId", (c) => renderAdminSpace(c));

function adminSpaceError(c: Context<AdminEnv>, message: string) {
  return c.html(<AdminPage ward={c.var.ward} account={c.var.account} title="もう一度お願いします"><h1>もう一度お願いします</h1><Notice error>{message}</Notice><a class="button" href={adminPath(c.var.ward.slug, `/space/${c.req.param("projectId")}`)}>実行委員と班長のページに戻る</a></AdminPage>, 400);
}

admin.post("/space/:projectId/open", async (c) => {
  const form = await c.req.parseBody();
  const passphrase = typeof form.passphrase === "string" ? form.passphrase.trim() : "";
  if (passphrase.length < 6 || passphrase.length > 120) return adminSpaceError(c, "合言葉は6文字以上120文字以内で入れてください。");
  try {
    await openSpace(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), passphrase, c.var.account.accountId);
  } catch {
    return adminSpaceError(c, "開けませんでした。入力した合言葉を確かめて、もう一度開けます。");
  }
  return renderAdminSpace(c, passphrase);
});

admin.post("/space/:projectId/close", async (c) => {
  await closeSpace(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), c.var.account.accountId);
  return c.redirect(adminPath(c.var.ward.slug, `/space/${encodeURIComponent(c.req.param("projectId"))}`), 303);
});

admin.post("/space/:projectId/invite", async (c) => {
  const form = await c.req.parseBody();
  const role = form.role === "leader" ? "leader" : "member";
  const district = role === "leader" && typeof form.district === "string" ? form.district.trim() : null;
  if (role === "leader" && !district) return adminSpaceError(c, "班を入れてください。");
  try {
    const token = await createInvite(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), role, district, c.var.account.accountId);
      const url = `${new URL(c.req.url).origin}/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(c.req.param("projectId"))}/join/${token}`;
    return c.html(<AdminPage ward={c.var.ward} account={c.var.account} title="一人用の入口を作りました"><h1>一人用の入口を作りました</h1><Notice>一度使うと、使えなくなります。</Notice><section class="next"><strong>次は</strong><p>この入口を、相手にだけ渡してください。</p><a class="button" href={url}>一人用の入口</a></section><p class="secret">{url}</p><h2>間違えたときは</h2><p>合言葉を変えてもう一度開くと、作った入口は使えなくなります。</p><a class="quiet" href={adminPath(c.var.ward.slug, `/space/${encodeURIComponent(c.req.param("projectId"))}`)}>実行委員と班長のページに戻る</a></AdminPage>);
  } catch {
    return adminSpaceError(c, "入口を作れませんでした。ページを開いてから、もう一度作れます。");
  }
});

admin.post("/space/:projectId/leader", async (c) => {
  const form = await c.req.parseBody();
  const district = typeof form.district === "string" ? form.district.trim() : "";
  if (!district) return adminSpaceError(c, "班を入れてください。");
  try {
    const token = await createInvite(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), "leader", district, c.var.account.accountId, true);
    const url = `${new URL(c.req.url).origin}/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(c.req.param("projectId"))}/person/${token}`;
    const contact = await getPublicContact(c.env.DB, c.var.ward.wardId);
    return c.html(<PrintDocument title="班長への一枚" hint={<a href={adminPath(c.var.ward.slug, `/space/${c.req.param("projectId")}`)}>実行委員と班長のページに戻る</a>}><Sheet footer={<>{c.var.ward.name} {district}</>}><h1>{district}の班長さんへ</h1><p>このQRコードは、その班長にだけ渡してください。</p><PrintQr text={url} sizeMm={32} /><h2>次は</h2><p>案内といっしょに、班長への一枚を印刷して渡してください。</p><p>このQRコードから、班の答えを見たり、回答票を撮って送ったりできます。</p><p>「答えた世帯」に名前が出たら、紙は名前が読めないようにして捨ててかまいません。捨てにくいときは、ついでのときに役員に渡してください。</p><h2>間違えたときは</h2><p>役員に知らせてください。</p><p>{contact}</p></Sheet></PrintDocument>);
  } catch {
    return adminSpaceError(c, "班長への一枚を作れませんでした。ページを開いてから、もう一度作れます。");
  }
});

pub.get("/space/:projectId", async (c) => renderSpace(c, null));

pub.get("/space/:projectId/join/:token", async (c) => {
  const credential = await exchangeInvite(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), c.req.param("token"));
  if (!credential) return closedNotice(c);
  setSpaceCookie(c, credential);
  return c.redirect(`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(credential.projectId)}?joined=once`, 303);
});

pub.get("/space/:projectId/person/:token", async (c) => {
  const credential = await findMember(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), c.req.param("token"));
  if (!credential) return closedNotice(c);
  setSpaceCookie(c, credential);
  return c.redirect(`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(credential.projectId)}?joined=person`, 303);
});

pub.post("/space/:projectId/enter", async (c) => {
  const form = await c.req.parseBody();
  const passphrase = typeof form.passphrase === "string" ? form.passphrase : "";
  const credential = await enterWithPassphrase(c.env.DB, c.var.ward.wardId, c.req.param("projectId"), passphrase);
  if (!credential) return c.html(<Layout title="入れませんでした" siteName={await spaceSiteName(c)}><h1>入れませんでした</h1><p>もう一度入れてください。分からないときは役員に聞いてください</p><p class="link-line"><a href={`/${c.var.ward.slug}/space/${c.req.param("projectId")}`}>もう一度入力する</a></p></Layout>, 403);
  setSpaceCookie(c, credential);
  return c.redirect(`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(credential.projectId)}`, 303);
});

pub.get("/space/:projectId/send-error", async (c) => c.html(<Layout title="送れませんでした" siteName={await spaceSiteName(c)} noindex><h1>送れませんでした</h1><p>もう一度撮って送れます。</p><a class="button" href={`/${c.var.ward.slug}/space/${c.req.param("projectId")}`}>実行委員と班長のページに戻る</a></Layout>, 400));

pub.get("/space/:projectId/file/:originalId", async (c) => {
  const projectId = c.req.param("projectId");
  const credential = await cookieMember(c, projectId);
  if (!credential) return closedNotice(c);
  if (credential.role === "leader") return closedNotice(c);
  const file = await c.env.DB.prepare(
    `SELECT o.r2_path, o.filename, o.media_type FROM originals o JOIN jobs j
     ON j.ward_id = o.ward_id AND j.job_id = o.job_id
     WHERE o.ward_id = ? AND o.original_id = ? AND j.project_id = ? AND j.via = 'space' AND o.withdrawn_at IS NULL AND j.withdrawn_at IS NULL`,
  ).bind(c.var.ward.wardId, c.req.param("originalId"), projectId).first<{ r2_path: string | null; filename: string; media_type: string }>();
  if (!file?.r2_path) return c.notFound();
  c.header("Cache-Control", "private, no-store");
  const fileUrl = `/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(projectId)}/file/${encodeURIComponent(c.req.param("originalId"))}`;
  if (c.req.query("raw") !== "1") return c.html(<Layout title={file.filename} siteName={await spaceSiteName(c)} noindex>
    <a class="back" href={`/${c.var.ward.slug}/space/${projectId}`}>実行委員のページへ</a><h1>{file.filename}</h1>
    <p class="lead">実行委員と班長のページから送られた写真です。役員と、このページに入った人だけが見られます。</p>
    {file.media_type.startsWith("image/") ? <img class="space-photo" src={`${fileUrl}?raw=1`} alt={file.filename} /> : <p>PDFのときは、PDFが開きます。</p>}
    <a class="button" href={`${fileUrl}?raw=1`}>{file.media_type.startsWith("image/") ? "写真を大きく開く" : "PDFを開く"}</a><a class="quiet" href={`/${c.var.ward.slug}/space/${projectId}`}>実行委員のページへ戻る</a>
  </Layout>);
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
  if (credential.role === "leader" && readKind === "general") return closedNotice(c);
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) return c.redirect(`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(projectId)}/send-error`, 303);
  try {
    const outcome = readKind === "general" ? await receiveSpacePaper(c.env, c.executionCtx, c.var.ward.wardId, projectId, file) : await receiveOriginal(c.env, c.executionCtx, {
      wardId: c.var.ward.wardId,
      projectId,
      via: "space",
      readKind,
      parts: [{ kind: "photo", filename: file.name, mediaType: file.type, bytes: new Uint8Array(await file.arrayBuffer()) }],
    });
    if (outcome.jobId) setCookie(c, "space_photo_receipt", outcome.jobId, { path: `/${c.var.ward.slug}/space/${projectId}`, httpOnly: true, sameSite: "Lax", secure: new URL(c.req.url).protocol === "https:", maxAge: 600 });
    return c.redirect(`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(projectId)}?sent=${readKind === "answer_sheet" ? "answer" : "paper"}`, 303);
  } catch {
    return c.redirect(`/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(projectId)}/send-error`, 303);
  }
}

async function renderSpace(c: Context<WardEnv>, direct: string | null) {
  const projectId = c.req.param("projectId");
  if (!projectId) return c.notFound();
  const project = await c.env.DB.prepare("SELECT title, kind, closed_at FROM projects WHERE ward_id = ? AND project_id = ?").bind(c.var.ward.wardId, projectId).first<{ title: string; kind: ProjectKind; closed_at: string | null }>();
  if (!project) return c.notFound();
  if (project.closed_at) return closedNotice(c);
  const state = await getSpace(c.env.DB, c.var.ward.wardId, projectId);
  if (!state || state.closed_at) return closedNotice(c);
  const credential = direct ? await findMember(c.env.DB, c.var.ward.wardId, projectId, direct) : await cookieMember(c, projectId);
  const base = `/${encodeURIComponent(c.var.ward.slug)}/space/${encodeURIComponent(projectId)}`;
  c.header("Cache-Control", "private, no-store");
  if (!credential) return c.html(<Layout title="実行委員のページに入る" siteName={`${c.var.ward.name} ${project.title}`} noindex><h1>実行委員のページに入る</h1><p class="lead">役員から届いた合言葉を入れてください。</p><form method="post" action={`${base}/enter`}><label for="passphrase">合言葉</label><input id="passphrase" name="passphrase" type="password" required /><button type="submit">入る</button></form><p>分からないときは役員に聞いてください。</p></Layout>);
  if (direct) setSpaceCookie(c, credential);
  const { labels, documents: publications } = await residentContext(c.env.DB, c.var.ward.wardId, projectId);
  const deadline = await getAnswerDeadline(c.env.DB, c.var.ward.wardId, projectId);
  const data = await getSpaceMaterials(c.env.DB, c.var.ward.wardId, projectId, credential.role === "leader" ? credential.district ?? "" : null);
  const leader = credential.role === "leader";
  const homeLabel = leader ? `${credential.district ?? ""}の班長さんのページへ` : "実行委員のページへ";
  const contact = await getPublicContact(c.env.DB, c.var.ward.wardId);
  if (c.req.query("joined")) return c.html(<Layout title={leader ? "班長のページに入りました" : "実行委員のページに入りました"} siteName={`${c.var.ward.name} ${project.title}`} noindex>
    <h1>{leader ? `${credential.district ?? ""}の班長として入りました` : "実行委員のページに入りました"}</h1><Notice>このスマホで入りました</Notice><p>30日のあいだは、このスマホで開けば、そのまま入れます。{c.req.query("joined") === "once" ? "いま使った入口は、もう使えません。" : ""}</p>
    <section class="next"><strong>次は</strong><p>{leader ? "班長さんのページを開いて、答えを見てください。" : "実行委員のページを開いて、配られたものを見てください。"}</p><a class="button" href={base}>{leader ? `${credential.district ?? ""}の班長さんのページを開く` : "実行委員のページを開く"}</a></section>
    <h2>ほかのスマホやパソコンで開くとき</h2><p>役員に、新しい入口か合言葉を頼んでください。</p><p class="preserve-lines">{contact || "連絡先は役員に聞いてください。"}</p>
  </Layout>);
  const sent = c.req.query("sent");
  const send = c.req.query("send");
  const sheet = leader;
  const sending = send === "answer" || (!leader && send === "paper");
  const received = sent === "answer" || (!leader && sent === "paper");
  const receiptId = received ? getCookie(c, "space_photo_receipt") : undefined;
  const ownReceipt = receiptId ? await c.env.DB.prepare("SELECT job_id FROM jobs WHERE ward_id = ? AND job_id = ? AND project_id = ? AND via = 'space' AND withdrawn_at IS NULL")
    .bind(c.var.ward.wardId, receiptId, projectId).first<{ job_id: string }>() : null;
  const checks = ownReceipt ? await photoChecks(c.env.DB, c.var.ward.wardId, ownReceipt.job_id) : [];
  if (sending || received) return c.html(<Layout title={received ? sheet ? "回答票を受け取りました" : "紙を受け取りました" : sheet ? "回答票を撮って送る" : "手元の紙を撮って送る"} siteName={`${c.var.ward.name} ${project.title}`} noindex>
    {!received ? <a class="back" href={base}>{homeLabel}</a> : null}
    <h1>{received ? sheet ? "回答票を受け取りました" : "紙を受け取りました" : sheet ? "回答票を撮って送る" : "手元の紙を撮って送る"}</h1>
    {received ? <>
      <PhotoCheckNotice checks={checks} retakeHref={`${base}?send=${sheet ? "answer" : "paper"}`} continueHref={base} />
      <p class="lead">{sheet ? "ありがとうございました。読み取れた分から数えます。この画面は閉じてかまいません。" : "役員に届きました。回答票は、読み取った内容が役員の画面と同じ答えの数に入ります。当番表や当日の紙は、役員が読んで必要なところを直します。この画面は閉じてかまいません。"}</p>
      <section class="next"><strong>次は</strong><p>{sheet ? "回答票が残っていれば、続けて撮って送ってください。残りがなければ、これで終わりです。" : "紙が残っていれば、続けて撮って送ってください。残りがなければ、これで終わりです。"}</p><a class="button" href={`${base}?send=${sheet ? "answer" : "paper"}`}>続けて撮って送る</a></section>
      {received ? <><h2>撮った回答票の紙は</h2><p>「答えた世帯」に名前が出たら、紙は名前が読めないようにして捨ててかまいません。写真が残ります。</p><p>捨てにくいときや、念のため残したいときは、ついでのときに役員に渡してください。急ぎません。</p></> : null}
      <h2>間違えて送ったときは</h2><p>役員に知らせてください。</p><p class="preserve-lines">{contact || "連絡先は役員に聞いてください。"}</p><a class="quiet" href={base}>{homeLabel}</a>
    </> : <>
      <p class="lead">{sheet ? "預かった回答票を撮ってください。一枚の写真に何枚写っていてもかまいません。" : "回答票、当番表、当日の紙のどれでもかまいません。一枚の写真に何枚写っていてもかまいません。"}</p>
      <form method="post" action={`${base}/${sheet ? "send-answer" : "send"}`} enctype="multipart/form-data"><div class="field"><label class="file-button">{sheet ? "カメラで回答票を撮る" : "カメラで紙を撮る"}<input name="file" type="file" accept="image/*,.pdf" capture="environment" required /></label></div><div class="action-links"><button type="submit">送る</button></div></form>
      <p>写真かPDFを送れます。{deadline ? `答えの締切は${formatJstDate(deadline)}です。` : ""}</p>
      <details class="hint"><summary>読みにくい字があったとき</summary><div><p>そのまま送ってください。読めないところは役員が直します。{leader ? "班長さん" : "実行委員さん"}が確かめる必要はありません。</p></div></details>
      {!leader ? <details class="hint"><summary>何の紙か書かなくてよいのですか</summary><div><p>書かなくてかまいません。そのまま送ってください。役員が読んで、必要なところを直します。</p></div></details> : null}
    </>}
  </Layout>);
  const roster = await getRoster(c.env.DB, c.var.ward.wardId);
  const householdCount = roster.filter((row) => !leader || row.district === credential.district).length;
  const meeting = project.kind === "general_meeting";
  const meetingAnswers = meeting ? (await listAnswers(c.env.DB, c.var.ward.wardId, projectId))
    .filter((answer) => (!leader || answer.district === (credential.district ?? "")) && isMeetingStatus(answer.meetingStatus)) : null;
  return c.html(<Layout title={leader ? "班長のページ" : "実行委員のページ"} siteName={`${c.var.ward.name} ${project.title}`} noindex>
    <div class="space-page"><h1>{leader ? `${credential.district ?? ""}の班長さんへ` : "実行委員のページ"}</h1>
    <p class="lead">{leader ? `このページでは、${credential.district ?? ""}の答えを見て、預かった回答票を写真で送れます。` : `${project.title}の準備のために、役員から配られたものを見て、手元の紙の写真を送るページです。住民には見えません。`}{leader && deadline ? `答えの締切は${formatJstDate(deadline)}です。` : ""}</p>
    <div class="split"><aside><div class="action-links"><a class="button" href={`${base}?send=${leader ? "answer" : "paper"}`}>{leader ? "回答票を撮って送る" : "手元の紙を撮って送る"}</a></div>
    {!leader ? <p>回答票、当番表、当日の紙のどれでもかまいません。写真かPDFを送れます。送った紙は、役員に届きます。</p> : null}
    </aside><section><h2>当番表</h2><p class="muted">配ったときの当番表です。役員が配り直すまで変わりません。</p>
    {data.tablesRecorded ? <><MaterialsTable table="duties" items={data.items} /><h2>配置図</h2><MaterialsTable table="layout" items={data.items} /></> : <p>{data.tablesPublished ? "配ったときの表の記録がありません。役員に聞いてください。" : "まだ配っていません。"}</p>}
    <h2>実行委員名簿</h2>{data.tablesRecorded ? <MaterialsTable table="committee" items={data.items} /> : <p>まだ配っていません。</p>}
    {data.documents.length ? data.documents.map((doc) => <section><h2>{doc.title}</h2><p>役員が実行委員と班長に配った文書です。直している途中の文書は出ません。</p><details class="fold"><summary>{doc.title}を読む</summary><div>{articleParagraphs(doc.body).map((text) => <p class="preserve-lines">{text}</p>)}</div></details></section>) : <><h2>配られたもの</h2><p>まだ配っていません。</p></>}
    <h2>案内</h2>{publications.length ? publications.map((doc) => <p><a class="quiet" href={`/${c.var.ward.slug}/p/${projectId}`}>{doc.title}（区のページ）</a></p>) : <p>まだ配っていません。</p>}
    <h2>出欠</h2>{meetingAnswers ? <>
      <MeetingCounts totals={countMeetingAnswers(meetingAnswers)} className="counts space-counts" />
      <p class="muted">紙で答えた世帯も、回答票を送ると数に入ります。</p>
      {!leader ? [...new Set([...roster.map((row) => row.district), ...meetingAnswers.map((row) => row.district)])].map((district) => <p>{district || "班が分からない"}: {meetingTotalsText(countMeetingAnswers(meetingAnswers.filter((answer) => answer.district === district)))}</p>) : null}
      {meetingAnswers.length ? <details class="fold"><summary>答えた世帯の一覧（{meetingAnswers.length}世帯）</summary><div><table class="stack"><thead><tr>{!leader ? <th>班</th> : null}<th>代表者</th><th>答え</th></tr></thead><tbody>{meetingAnswers.map((answer) => <tr>{!leader ? <td data-label="班">{answer.district || "班が分からない"}</td> : null}<td data-label="代表者">{answer.household}</td><td data-label="答え">{meetingText(answer)}</td></tr>)}</tbody></table></div></details> : <p>答えはまだありません。</p>}
    </> : <>
    <div class="counts space-counts"><div class="count"><b>{new Set(data.attendance.map((row) => JSON.stringify([row.district, row.household]))).size}<small>世帯</small></b><span>{householdCount ? `${householdCount}世帯のうち` : "答えた"}</span></div><div class="count"><b>{data.attendance.reduce((sum, row) => sum + row.people_count, 0)}<small>人</small></b><span>参加する</span></div></div><p class="muted">紙で答えた世帯も、回答票を送ると数に入ります。</p>
    {data.attendance.length ? <details class="fold"><summary>答えた世帯の一覧（{new Set(data.attendance.map((row) => JSON.stringify([row.district, row.household]))).size}世帯）</summary><div><table class="stack"><thead><tr>{!leader ? <th>班</th> : null}<th>代表者</th><th class="num">人数</th></tr></thead><tbody>{data.attendance.map((row) => <tr>{!leader ? <td data-label="班">{row.district || "班が分からない"}</td> : null}<td data-label="代表者">{row.household}</td><td data-label="人数" class="num">{countText({ peopleCount: row.people_count, childrenCount: row.children_count, adultsCount: row.adults_count, seniorsCount: row.seniors_count }, labels)}</td></tr>)}</tbody></table></div></details> : <p>答えはまだありません。</p>}
    </>}
    {leader ? <p class="muted">名前が出た世帯の回答票は、名前が読めないようにして捨ててかまいません。捨てにくいときは、ついでのときに役員に渡してください。</p> : <><h2>協賛先</h2><p>{data.tablesRecorded ? `${data.items.filter((item) => item.kind === "sponsors").length}軒のうち、${data.items.filter((item) => item.kind === "sponsors" && ["yes", "no"].includes(String(item.data.reply))).length}軒から返事がありました。` : ""}額と、お願いした内容は、このページには出ません。</p>{data.tablesRecorded ? <details class="fold"><summary>協賛先の一覧を開く（{data.items.filter((item) => item.kind === "sponsors").length}軒）</summary><div><MaterialsTable table="sponsors" items={data.items} /></div></details> : <p>まだ配っていません。</p>}</>}
    {!leader ? <><h2>写真と届いたもの</h2>{data.originals.length ? data.originals.map((file) => <p><a class="quiet" href={`${base}/file/${encodeURIComponent(file.original_id)}`}>{file.filename}</a></p>) : <p>まだありません。</p>}</> : null}
    <h2>連絡先</h2><p class="preserve-lines">{contact || "役員に聞いてください。"}</p></section></div></div>
  </Layout>);
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
  const projectId = c.req.param("projectId");
  const project = await c.env.DB.prepare("SELECT closed_at FROM projects WHERE ward_id = ? AND project_id = ?")
    .bind(c.var.ward.wardId, projectId).first<{ closed_at: string | null }>();
  const state = projectId ? await getSpace(c.env.DB, c.var.ward.wardId, projectId) : null;
  const title = project?.closed_at || state?.closed_at ? "閉じました" : !state ? "まだ開いていません" : "この入口は使えません";
  const contact = await getPublicContact(c.env.DB, c.var.ward.wardId);
  return c.html(<Layout title={title} siteName={await spaceSiteName(c)} noindex><h1>{title}</h1><p>{title === "閉じました" ? "閉じました。役員に聞いてください。行事が終わって、役員が閉じています。" : title === "まだ開いていません" ? "役員がまだ開いていません。開いているはずのときは、役員に聞いてください。" : "この入口からは入れませんでした。役員に、新しい入口を頼んでください。"}</p><p class="preserve-lines">{contact || "連絡先は役員に聞いてください。"}</p>{title === "この入口は使えません" ? <a class="button" href={`/${c.var.ward.slug}/space/${projectId}`}>合言葉で入る</a> : null}<a class="quiet" href={`/${encodeURIComponent(c.var.ward.slug)}/`}>区のページへ</a></Layout>, 403);
}

export const space: Bundle = { admin, pub };

function adminPath(wardSlug: string, path: string): string {
  return `/${encodeURIComponent(wardSlug)}/admin${path}`;
}
