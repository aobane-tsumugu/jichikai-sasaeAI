import { newId, nowIso } from "../core/ids";
import { generateDeviceToken, sha256Hex } from "../core/password";
import { Hono, type Context } from "hono";
import type { AdminEnv, WardEnv } from "../env";
import { AdminPage } from "../core/admin-ui";
import { adminPath, issueDevice, requireAdmin } from "../core/auth";
import { Layout, Notice } from "../core/ui";
import { connectVerifiedSignIn, createPasswordSignIn, findVerifiedSignIns, listSignInMethods, readInvitation,
  LINK_UNAVAILABLE, SIGN_IN_LABEL, type SignInKind } from "../core/sign-in";
import { signInConnections, type ExternalSignInKind } from "../core/sign-in-connections";

export const mySignInPath = (ward: { slug: string }) => adminPath(ward, "/sign-in");
const kindOf = (raw: string): SignInKind | null => raw === "password" || raw === "line" || raw === "email" ? raw : null;

export function unavailableLink(c: Context<WardEnv> | Context<AdminEnv>) {
  return c.html(<Layout title="このリンクは使えません" siteName={`${c.var.ward.name}役員の画面`} noindex>
    <h1>このリンクは使えません</h1><Notice error>期限が過ぎたか、もう使われました。リンクは一度だけ使えます。</Notice>
    <section class="next"><strong>次は</strong><p>いつもの方法でログインしてください。まだログインできない方は「ログインできないとき」を開いてください。</p>
      <a class="button" href={adminPath(c.var.ward, "/login")}>役員の画面にログインする</a></section>
    <a class="quiet" href={adminPath(c.var.ward, "/login/help")}>ログインできないとき</a>
  </Layout>, 400);
}

function passwordPage(c: Context<WardEnv> | Context<AdminEnv>, result: { loginId: string; password: string }, added: boolean) {
  return c.html(<Layout title="IDとパスワードを作りました" siteName={`${c.var.ward.name}役員の画面`} noindex>
    <h1>IDとパスワードを作りました</h1><Notice>この画面でしか見られません。紙に書いて、しまっておいてください。</Notice>
    <div class="panel"><p>ID: <strong>{result.loginId}</strong></p><p>パスワード</p><p class="secret">{result.password}</p></div>
    <section class="next"><strong>次は</strong><p>書き写せたら、下のボタンを押してください。このスマホやパソコンでは、次から入力しなくてもログインできます。</p>
      <a class="button" href={adminPath(c.var.ward, added ? "/sign-in/saved?kind=password" : "/sign-in/done")}>書き写したのでログインする</a></section>
    <a class="quiet" href={mySignInPath(c.var.ward)}>ログインの方法へ</a>
  </Layout>);
}

const mine = new Hono<AdminEnv>();
mine.use("*", requireAdmin);
mine.get("/", async (c) => {
  const methods = await listSignInMethods(c.env.DB, c.var.ward.wardId, c.var.account.accountId);
  const active = methods.filter((m) => m.removed_at === null);
  const connections = signInConnections(c.env);
  const showKinds: SignInKind[] = ["password", "email", "line"];
  const using = showKinds.filter((kind) => active.some((m) => m.kind === kind)).map((kind) => SIGN_IN_LABEL[kind]);
  const addable = showKinds.filter((kind) => kind !== "password" && connections[kind] !== undefined && !active.some((m) => m.kind === kind));
  return c.html(<AdminPage ward={c.var.ward} account={c.var.account} title="ログインの方法" back={{ href: adminPath(c.var.ward, "/settings"), label: "自治会の設定へ" }}>
    <h1>ログインの方法</h1>
    <p class="lead">{using.length ? `${c.var.account.name}さんは、${using.join("と")}でログインできます。` : `${c.var.account.name}さんのログインの方法は、まだありません。`}このスマホやパソコンでは、次から入力しなくてもログインできます。</p>
    <p>{addable.length ? `${addable.map((kind) => SIGN_IN_LABEL[kind]).join("や")}でもログインできるようにしておくと、パスワードを忘れても自分で戻せます。` : "パスワードを忘れたときは、ほかの役員に「この画面を使える人」から、ログインし直すためのリンクを出してもらってください。"}</p>
    {showKinds.map((kind) => {
      const method = active.find((m) => m.kind === kind);
      const available = kind === "password" || connections[kind] !== undefined;
      if (!available) return null;
      return <section class="panel"><h2>{SIGN_IN_LABEL[kind]}</h2>
        {method ? <p>{method.email ? `${method.email}でログインできます。` : "この方法でログインできます。"}</p> : <p>この方法は、まだ使っていません。</p>}
        {(!method || kind === "email") ? <form method="post" action={kind === "password" ? `${mySignInPath(c.var.ward)}/password` : adminPath(c.var.ward, `/sign-in-connect/${kind}/start`)}>
          <input type="hidden" name="add" value="1" /><button class="secondary">{SIGN_IN_LABEL[kind]}を{method ? "変える" : "足す"}</button></form> : null}
      </section>;
    })}
  </AdminPage>);
});

mine.post("/password", async (c) => {
  const result = await createPasswordSignIn(c.env.DB, c.var.ward.wardId, { accountId: c.var.account.accountId });
  return result.ok ? passwordPage(c, result, true) : unavailableLink(c);
});

mine.get("/saved", (c) => {
  const kind = kindOf(c.req.query("kind") ?? "");
  return c.html(<AdminPage ward={c.var.ward} account={c.var.account} title="ログインの方法を足しました" back={{ href: mySignInPath(c.var.ward), label: "ログインの方法へ" }}>
    <h1>ログインの方法を足しました</h1><Notice>{kind ? SIGN_IN_LABEL[kind] : "ログインの方法"}を足しました。次から、このログインの方法も使えます。</Notice>
    <section class="next"><strong>次は</strong><p>このまま使ってください。</p><a class="button" href={adminPath(c.var.ward, "/")}>最初の画面へ</a></section>
    <a class="quiet" href={mySignInPath(c.var.ward)}>ログインの方法へ戻る</a>
  </AdminPage>);
});
mine.get("/done", (c) => c.html(<AdminPage ward={c.var.ward} account={c.var.account} title="ログインしました">
  <h1>ログインしました</h1><Notice>{c.var.account.name}さんとしてログインしました。このスマホやパソコンでは、次から入力しなくてもログインできます。</Notice>
  <section class="next"><strong>次は</strong><p>最初の画面で、今の自治会の様子を見てください。</p><a class="button" href={adminPath(c.var.ward, "/")}>最初の画面へ</a></section>
  <h2>使えなくなったときのために</h2><p>ログインの方法をもう一つ足せます。足さなくても使えます。</p><a class="quiet" href={mySignInPath(c.var.ward)}>ログインの方法を足す</a>
</AdminPage>));

export const signInRoutes = new Hono<WardEnv>();
signInRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store"); c.header("X-Robots-Tag", "noindex"); c.header("Referrer-Policy", "no-referrer");
  await next();
});
signInRoutes.route("/sign-in", mine);
signInRoutes.get("/invite/:token", async (c) => {
  const token = c.req.param("token");
  const invitation = await readInvitation(c.env.DB, c.var.ward.wardId, token);
  if (!invitation) return unavailableLink(c);
  const connections = signInConnections(c.env);
  return c.html(<Layout title="ログインの方法を選ぶ" siteName={`${c.var.ward.name}役員の画面`} noindex>
    <h1>{invitation.name}さん、ログインの方法を選んでください</h1>
    <p class="lead">役員の画面にログインできるようになります。ログインの方法はあとから足せます。</p>
    {(["line", "email"] as const).map((kind) => connections[kind] ? <form method="post" action={adminPath(c.var.ward, `/sign-in-connect/${kind}/start`)}>
      <input type="hidden" name="invitation" value={token} /><button class="secondary">{SIGN_IN_LABEL[kind]}で続ける</button></form> : null)}
    <form method="post" action={adminPath(c.var.ward, `/invite/${token}/password`)}><button>IDとパスワードを作る</button></form>
    <p>名前が違うときは、このリンクをくれた役員に聞いてください。</p><a class="quiet" href={adminPath(c.var.ward, "/login")}>ログインの画面へ戻る</a>
  </Layout>);
});
signInRoutes.post("/invite/:token/password", async (c) => {
  const result = await createPasswordSignIn(c.env.DB, c.var.ward.wardId, { token: c.req.param("token") });
  if (!result.ok) return unavailableLink(c);
  await issueDevice(c, c.var.ward, result.accountId);
  return passwordPage(c, result, false);
});

/** 接続が無い時は入口を出さず、URLを直接開かれても本人確認を飛ばさない。 */
signInRoutes.post("/sign-in-connect/:kind/start", async (c) => {
  const kind = c.req.param("kind");
  const connection = kind === "line" || kind === "email" ? signInConnections(c.env)[kind] : undefined;
  if (!connection) return unavailableLink(c);
  const originalRequest = c.req.raw.clone();
  const body = await c.req.parseBody();
  if (typeof body.invitation === "string") {
    if (!await readInvitation(c.env.DB, c.var.ward.wardId, body.invitation)) return unavailableLink(c);
    return connection.start(c, { invitation: body.invitation });
  }
  if (body.add === "1") {
    const secured = new Hono<AdminEnv>();
    secured.use("*", async (a, next) => { a.set("ward", c.var.ward); await next(); });
    secured.use("*", requireAdmin);
    secured.post("*", (a) => connection.start(a, { accountId: a.var.account.accountId }));
    return secured.fetch(originalRequest, c.env);
  }
  return connection.start(c, { login: true });
});
signInRoutes.post("/sign-in-select", async (c) => {
  const form = await c.req.parseBody();
  const token = typeof form.token === "string" ? form.token : "";
  const row = await c.env.DB.prepare(`UPDATE sign_in_links SET used_at = ? WHERE ward_id = ? AND purpose = 'email'
    AND token_hash = ? AND used_at IS NULL AND revoked_at IS NULL AND expires_at > ?
    AND EXISTS (SELECT 1 FROM accounts a WHERE a.ward_id = sign_in_links.ward_id AND a.account_id = sign_in_links.account_id AND a.removed_at IS NULL AND a.sign_in_required = 0)
    RETURNING account_id`).bind(nowIso(), c.var.ward.wardId, await sha256Hex(token), nowIso()).first<{ account_id: string }>();
  if (!row) return unavailableLink(c);
  await issueDevice(c, c.var.ward, row.account_id);
  return c.redirect(adminPath(c.var.ward, "/"), 303);
});

signInRoutes.get("/sign-in-connect/:kind/callback", async (c) => {
  const kind = c.req.param("kind") as ExternalSignInKind;
  const connection = kind === "line" || kind === "email" ? signInConnections(c.env)[kind] : undefined;
  if (!connection) return unavailableLink(c);
  const verified = await connection.finish(c);
  if (!verified) return c.redirect(adminPath(c.var.ward, "/login/help"), 303);
  if ("cancelled" in verified) {
    const { intent } = verified;
    if ("invitation" in intent) return c.redirect(adminPath(c.var.ward, `/invite/${encodeURIComponent(intent.invitation)}`), 303);
    return c.redirect("accountId" in intent ? mySignInPath(c.var.ward) : adminPath(c.var.ward, "/login/help"), 303);
  }
  if (verified.identity.kind !== kind) return c.redirect(adminPath(c.var.ward, "/login/help"), 303);
  const { identity, intent } = verified;
  if ("login" in intent) {
    const accounts = await findVerifiedSignIns(c.env.DB, c.var.ward.wardId, { kind, subject: identity.kind === "email" ? identity.email : identity.subject });
    if (!accounts.length) return c.redirect(adminPath(c.var.ward, "/login/help"), 303);
    if (accounts.length === 1) {
      await issueDevice(c, c.var.ward, accounts[0]!.account_id);
      return c.redirect(adminPath(c.var.ward, "/"), 303);
    }
    // 同じ連絡先で入れる人が複数いるとき、勝手に一人として入れない。
    const choices = await Promise.all(accounts.map(async (account) => {
      const token = generateDeviceToken();
      await c.env.DB.prepare(`INSERT INTO sign_in_links (link_id, ward_id, account_id, purpose, token_hash, expires_at, created_at)
        VALUES (?, ?, ?, 'email', ?, ?, ?)`).bind(newId(), c.var.ward.wardId, account.account_id, await sha256Hex(token), new Date(Date.now() + 30 * 60_000).toISOString(), nowIso()).run();
      return { ...account, token };
    }));
    return c.html(<Layout title="ログインする人を選ぶ" siteName={`${c.var.ward.name}役員の画面`} noindex>
      <h1>だれとしてログインしますか</h1><p class="lead">このログインの方法でログインできる人から、ご自分の名前を選んでください。</p>
      {choices.map((choice) => <form method="post" action={adminPath(c.var.ward, "/sign-in-select")}><input type="hidden" name="token" value={choice.token} /><button>{choice.name}（ID{choice.login_id}）</button></form>)}
      <a class="quiet" href={adminPath(c.var.ward, "/login")}>ログインの画面へ戻る</a>
    </Layout>);
  }
  if ("accountId" in intent) {
    // 足す途中で端末が変わった時は、入り直してから足す。
    const secured = new Hono<AdminEnv>();
    secured.use("*", async (a, next) => { a.set("ward", c.var.ward); await next(); });
    secured.use("*", requireAdmin);
    secured.get("*", async (a) => {
      if (a.var.account.accountId !== intent.accountId) return unavailableLink(a);
      const result = await connectVerifiedSignIn(a.env.DB, a.var.ward.wardId, { accountId: intent.accountId }, identity);
      return result.ok ? a.redirect(`${mySignInPath(a.var.ward)}/saved?kind=${kind}`, 303) : connectionError(a, result.message, mySignInPath(a.var.ward));
    });
    return secured.fetch(c.req.raw, c.env);
  }
  const result = await connectVerifiedSignIn(c.env.DB, c.var.ward.wardId, { token: intent.invitation }, identity);
  if (!result.ok) return result.message === LINK_UNAVAILABLE ? unavailableLink(c)
    : connectionError(c, result.message, adminPath(c.var.ward, `/invite/${encodeURIComponent(intent.invitation)}`));
  await issueDevice(c, c.var.ward, result.accountId);
  return c.redirect(adminPath(c.var.ward, "/sign-in/done"), 303);
});

function connectionError(c: Context<WardEnv> | Context<AdminEnv>, message: string, back?: string) {
  return c.html(<Layout title="つなげませんでした" noindex><h1>つなげませんでした</h1><Notice error>{message}</Notice>
    <section class="next"><strong>次は</strong><p>別のログインの方法でお試しください。</p><a class="button" href={back ?? adminPath(c.var.ward, "/login")}>{back ? "ログインの方法を選ぶ画面へ戻る" : "ログインの画面へ戻る"}</a></section>
  </Layout>, 400);
}
