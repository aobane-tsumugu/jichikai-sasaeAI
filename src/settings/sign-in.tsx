import { Hono, type Context } from "hono";
import type { AdminEnv, WardEnv } from "../env";
import { AdminPage } from "../core/admin-ui";
import { adminPath, issueDevice, requireAdmin } from "../core/auth";
import { Layout, Notice } from "../core/ui";
import { connectVerifiedSignIn, createPasswordSignIn, findVerifiedSignIn, listSignInMethods, readInvitation,
  removeSignInMethod, LINK_UNAVAILABLE, SIGN_IN_LABEL, type SignInKind } from "../core/sign-in";
import { signInConnections, type ExternalSignInKind } from "../core/sign-in-connections";

export const mySignInPath = (ward: { slug: string }) => adminPath(ward, "/sign-in");
const kindOf = (raw: string): SignInKind | null => raw === "password" || raw === "line" || raw === "email" ? raw : null;

export function unavailableLink(c: Context<WardEnv> | Context<AdminEnv>) {
  return c.html(<Layout title="このリンクは使えません" siteName={`${c.var.ward.name}役員の画面`} noindex>
    <h1>このリンクは使えません</h1><Notice error>期限が過ぎたか、もう使われました。リンクは一度だけ使えます。</Notice>
    <section class="next"><strong>次は</strong><p>いつもの入り方で入ってください。まだ入れない方は「入れないとき」を開いてください。</p>
      <a class="button" href={adminPath(c.var.ward, "/login")}>役員の画面に入る</a></section>
    <a class="quiet" href={adminPath(c.var.ward, "/login/help")}>入れないとき</a>
  </Layout>, 400);
}

function passwordPage(c: Context<WardEnv> | Context<AdminEnv>, result: { loginId: string; password: string }, added: boolean) {
  return c.html(<Layout title="IDとパスワードを作りました" siteName={`${c.var.ward.name}役員の画面`} noindex>
    <h1>IDとパスワードを作りました</h1><Notice>この画面でしか見られません。紙に書いて、しまっておいてください。</Notice>
    <div class="panel"><p>ID: <strong>{result.loginId}</strong></p><p>パスワード</p><p class="secret">{result.password}</p></div>
    <section class="next"><strong>次は</strong><p>書き写せたら、下のボタンを押してください。このスマホやパソコンでは、次から入力しなくても入れます。</p>
      <a class="button" href={adminPath(c.var.ward, added ? "/sign-in/saved?kind=password" : "/sign-in/done")}>書き写したので入る</a></section>
    <a class="quiet" href={mySignInPath(c.var.ward)}>自分の入り方へ</a>
  </Layout>);
}

const mine = new Hono<AdminEnv>();
mine.use("*", requireAdmin);
mine.get("/", async (c) => {
  const methods = await listSignInMethods(c.env.DB, c.var.ward.wardId, c.var.account.accountId);
  const active = methods.filter((m) => m.removed_at === null);
  const connections = signInConnections(c.env);
  const showKinds: SignInKind[] = ["password", "email", "line"];
  return c.html(<AdminPage ward={c.var.ward} account={c.var.account} title="自分の入り方" back={{ href: adminPath(c.var.ward, "/settings/people"), label: "役員の一覧へ" }}>
    <h1>自分の入り方</h1><p class="lead">二つにしておくと、片方が使えないときも自分で戻せます。一つでも使えます。</p>
    {showKinds.map((kind) => {
      const method = active.find((m) => m.kind === kind);
      const available = kind === "password" || connections[kind] !== undefined;
      if (!available) return null;
      return <section class="panel"><h2>{SIGN_IN_LABEL[kind]}</h2>
        {method ? <><p>{method.email ?? "使えるようになっています。"}</p>
          {active.length > 1 ? <form method="post" action={`${mySignInPath(c.var.ward)}/${kind}/remove`}><button class="secondary">{SIGN_IN_LABEL[kind]}を外す</button></form>
            : <p>最後の一つなので外せません。</p>}</>
          : <><p>まだ使っていません。</p><form method="post" action={kind === "password" ? `${mySignInPath(c.var.ward)}/password` : adminPath(c.var.ward, `/sign-in-connect/${kind}/start`)}>
            <input type="hidden" name="add" value="1" /><button class="secondary">{SIGN_IN_LABEL[kind]}を{methods.some((m) => m.kind === kind) ? "つなぎ直す" : "足す"}</button></form></>}
      </section>;
    })}
    <p>最後の一つは外せません。外した入り方は、つなぎ直せます。</p>
  </AdminPage>);
});

mine.post("/:kind/remove", async (c) => {
  const kind = kindOf(c.req.param("kind"));
  const result = kind ? await removeSignInMethod(c.env.DB, c.var.ward.wardId, c.var.account.accountId, kind) : { ok: false, message: "その入り方は見つかりません。" };
  if (!result.ok) return c.html(<AdminPage ward={c.var.ward} account={c.var.account} title="入り方を外せませんでした">
    <h1>入り方を外せませんでした</h1><Notice error>{result.message}</Notice>
    <section class="next"><strong>次は</strong><p>別の入り方を先に足してください。</p><a class="button" href={mySignInPath(c.var.ward)}>自分の入り方へ戻る</a></section>
  </AdminPage>, 400);
  return c.redirect(`${mySignInPath(c.var.ward)}/removed?kind=${kind}`, 303);
});

mine.get("/removed", async (c) => {
  const kind = kindOf(c.req.query("kind") ?? "");
  const remaining = (await listSignInMethods(c.env.DB, c.var.ward.wardId, c.var.account.accountId)).filter((m) => m.removed_at === null);
  return c.html(<AdminPage ward={c.var.ward} account={c.var.account} title="入り方を外しました" back={{ href: mySignInPath(c.var.ward), label: "自分の入り方へ" }}>
    <h1>入り方を外しました</h1><Notice>{kind ? SIGN_IN_LABEL[kind] : "入り方"}を外しました。次から、{remaining.map((m) => SIGN_IN_LABEL[m.kind]).join("、")}で入れます。</Notice>
    <section class="next"><strong>次は</strong><p>このまま使ってください。</p><a class="button" href={adminPath(c.var.ward, "/")}>最初の画面へ</a></section>
    <h2>間違えたときは</h2>{kind && (kind === "password" || signInConnections(c.env)[kind])
      ? <form method="post" action={kind === "password" ? `${mySignInPath(c.var.ward)}/password` : adminPath(c.var.ward, `/sign-in-connect/${kind}/start`)}>
        <input type="hidden" name="add" value="1" /><button class="secondary">{SIGN_IN_LABEL[kind]}をつなぎ直す</button></form>
      : <a class="button secondary" href={mySignInPath(c.var.ward)}>入り方をつなぎ直す</a>}
  </AdminPage>);
});

mine.post("/password", async (c) => {
  const result = await createPasswordSignIn(c.env.DB, c.var.ward.wardId, { accountId: c.var.account.accountId });
  return result.ok ? passwordPage(c, result, true) : unavailableLink(c);
});

mine.get("/saved", (c) => {
  const kind = kindOf(c.req.query("kind") ?? "");
  return c.html(<AdminPage ward={c.var.ward} account={c.var.account} title="入り方を足しました" back={{ href: mySignInPath(c.var.ward), label: "自分の入り方へ" }}>
    <h1>入り方を足しました</h1><Notice>{kind ? SIGN_IN_LABEL[kind] : "入り方"}を足しました。次から、この入り方も使えます。</Notice>
    <section class="next"><strong>次は</strong><p>このまま使ってください。</p><a class="button" href={adminPath(c.var.ward, "/")}>最初の画面へ</a></section>
    <h2>間違えたときは</h2><p>自分の入り方の画面で、外せます。</p>
  </AdminPage>);
});
mine.get("/done", (c) => c.html(<AdminPage ward={c.var.ward} account={c.var.account} title="入れました">
  <h1>入れました</h1><Notice>{c.var.account.name}さんとして入りました。このスマホやパソコンでは、次から入力しなくても入れます。</Notice>
  <section class="next"><strong>次は</strong><p>最初の画面で、今の区の様子を見てください。</p><a class="button" href={adminPath(c.var.ward, "/")}>最初の画面へ</a></section>
  <h2>使えなくなったときのために</h2><p>入り方をもう一つ足せます。足さなくても使えます。</p><a class="quiet" href={mySignInPath(c.var.ward)}>入り方を足す</a>
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
  return c.html(<Layout title="入り方を選ぶ" siteName={`${c.var.ward.name}役員の画面`} noindex>
    <h1>{invitation.name}さん、入り方を{invitation.purpose === "reset" ? "決め直して" : "選んで"}ください</h1>
    <p class="lead">{invitation.purpose === "reset" ? "前の入り方は使えなくなりました。同じ方法を選んでもかまいません。" : "役員の画面に入れるようになります。あとから変えられます。"}</p>
    {(["line", "email"] as const).map((kind) => connections[kind] ? <form method="post" action={adminPath(c.var.ward, `/sign-in-connect/${kind}/start`)}>
      <input type="hidden" name="invitation" value={token} /><button class="secondary">{SIGN_IN_LABEL[kind]}で続ける</button></form> : null)}
    <form method="post" action={adminPath(c.var.ward, `/invite/${token}/password`)}><button>IDとパスワードを作る</button></form>
    <p>名前が違うときは、このリンクをくれた役員に聞いてください。</p><a class="quiet" href={adminPath(c.var.ward, "/login")}>入る画面へ戻る</a>
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
    const account = await findVerifiedSignIn(c.env.DB, c.var.ward.wardId, { kind, subject: identity.kind === "email" ? identity.email : identity.subject });
    if (!account) return c.redirect(adminPath(c.var.ward, "/login/help"), 303);
    await issueDevice(c, c.var.ward, account.account_id);
    return c.redirect(adminPath(c.var.ward, "/"), 303);
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
    <section class="next"><strong>次は</strong><p>別の入り方でお試しください。</p><a class="button" href={back ?? adminPath(c.var.ward, "/login")}>{back ? "入り方を選ぶ画面へ戻る" : "入る画面へ戻る"}</a></section>
  </Layout>, 400);
}
