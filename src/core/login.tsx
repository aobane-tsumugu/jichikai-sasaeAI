import { Hono } from "hono";
import type { WardEnv } from "../env";
import { adminPath, issueDevice, safeNext } from "./auth";
import { cleanLoginId, cleanName, hashPassword, loginIdProblem, nameKey, safeEqual } from "./password";
import { clearLoginFailures, delayLoginAfterFailures } from "./login-throttle";
import { Layout, Notice, WardStopped } from "./ui";
import { signInRoutes } from "../settings/sign-in";
import { signInConnections } from "./sign-in-connections";

// 役員画面のログイン。ID と長いパスワード。公開の入口なので、ID の有無は答えに出さない。

export const loginRoutes = new Hono<WardEnv>();

const LoginPage = (props: { wardName: string; action: string; next: string; error?: string; line?: boolean; email?: boolean }) => (
  <Layout title={`${props.wardName}役員の画面にログインする`} siteName={`${props.wardName}役員の画面`} noindex>
    <h1>役員の画面にログインする</h1>
    <p class="lead">いつもの方法でログインしてください。</p>
    {props.error ? <Notice error>{props.error}</Notice> : null}
    {(["line", "email"] as const).map((kind) => props[kind] ? <form method="post" action={props.action.replace(/\/login$/, `/sign-in-connect/${kind}/start`)}><button class="secondary">{kind === "line" ? "LINE" : "メール"}でログインする</button></form> : null)}
    <h2>IDとパスワードでログインする</h2>
    <form method="post" action={props.action}>
      <input type="hidden" name="next" value={props.next} />
      <label for="loginId">ID</label>
      <input id="loginId" name="loginId" type="text" autocomplete="username" autocapitalize="none" spellcheck={false} required />
      <label for="password">パスワード</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <p>
        <button type="submit">ログインする</button>
      </p>
    </form>
    <p class="muted">このスマホやパソコンでは、次から入力しなくてもログインできます。</p>
    <a class="quiet" href={`${props.action}/help`}>ログインできないとき</a>
    <a class="quiet" href="/contact">SasaeAIに問い合わせる</a>
  </Layout>
);

loginRoutes.get("/login", async (c) => {
  const ward = c.var.ward;
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  const active = await c.env.DB.prepare("SELECT is_active FROM wards WHERE ward_id = ?").bind(ward.wardId).first<{ is_active: number }>();
  if (!active || active.is_active !== 1) return c.html(<WardStopped wardName={ward.name} homeHref={`/${encodeURIComponent(ward.slug)}/`} />, 503);
  return c.html(
    <LoginPage
      wardName={ward.name}
      action={adminPath(ward, "/login")}
      next={safeNext(ward, c.req.query("next"))}
      line={!!signInConnections(c.env).line}
      email={!!signInConnections(c.env).email}
    />,
  );
});

// ID が無い時も同じだけ要約を計算して、時間差で ID の有無を漏らさない。
const DUMMY_SALT = "no-such-account";

loginRoutes.post("/login", async (c) => {
  const ward = c.var.ward;
  const active = await c.env.DB.prepare("SELECT is_active FROM wards WHERE ward_id = ?").bind(ward.wardId).first<{ is_active: number }>();
  if (!active || active.is_active !== 1) return c.html(<WardStopped wardName={ward.name} homeHref={`/${encodeURIComponent(ward.slug)}/`} />, 503);
  const form = await c.req.parseBody();
  // 現行フォームは loginId。旧フォームが送る name も互換用に受け付ける。
  const hasLoginId = typeof form["loginId"] === "string";
  const rawIdentity = hasLoginId
    ? (form["loginId"] as string)
    : typeof form["name"] === "string"
      ? form["name"]
      : "";
  const identity = hasLoginId ? cleanLoginId(rawIdentity) : cleanName(rawIdentity);
  const password = typeof form["password"] === "string" ? form["password"].trim() : "";
  const next = safeNext(ward, typeof form["next"] === "string" ? form["next"] : undefined);

  const account = await c.env.DB.prepare(
    hasLoginId
      ? `SELECT account_id, password_salt, password_hash FROM accounts WHERE ward_id = ? AND login_id = ? AND removed_at IS NULL AND sign_in_required = 0
          AND EXISTS (SELECT 1 FROM sign_in_methods m WHERE m.ward_id = accounts.ward_id AND m.account_id = accounts.account_id AND m.kind = 'password' AND m.removed_at IS NULL)`
      : `SELECT account_id, password_salt, password_hash FROM accounts WHERE ward_id = ? AND name_key = ? AND removed_at IS NULL AND sign_in_required = 0
          AND EXISTS (SELECT 1 FROM sign_in_methods m WHERE m.ward_id = accounts.ward_id AND m.account_id = accounts.account_id AND m.kind = 'password' AND m.removed_at IS NULL)`,
  )
    .bind(ward.wardId, hasLoginId ? identity : nameKey(identity))
    .first<{ account_id: string; password_salt: string; password_hash: string }>();

  const computed = await hashPassword(password, account?.password_salt ?? DUMMY_SALT);
  const ok = account ? safeEqual(computed, account.password_hash) : false;
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  if (!account || !ok || (hasLoginId && loginIdProblem(rawIdentity) !== null)) {
    await delayLoginAfterFailures(c.env.DB, ward.wardId, identity || rawIdentity || "unknown");
    return c.html(
      <LoginPage
        wardName={ward.name}
        action={adminPath(ward, "/login")}
        next={next}
        line={!!signInConnections(c.env).line}
        email={!!signInConnections(c.env).email}
        error="IDかパスワードが違います。もう一度入れてください。分からないときは、ほかの役員に作り直してもらえます"
      />,
      401,
    );
  }
  await clearLoginFailures(c.env.DB, ward.wardId, identity || rawIdentity);
  await issueDevice(c, ward, account.account_id);
  return c.redirect(next, 303);
});

loginRoutes.get("/login/help", (c) => {
  const connections = signInConnections(c.env);
  c.header("Cache-Control", "no-store"); c.header("X-Robots-Tag", "noindex");
  return c.html(<Layout title="ログインできないとき" siteName={`${c.var.ward.name}役員の画面`} noindex>
    <a class="back" href={adminPath(c.var.ward, "/login")}>← ログインの画面へ</a><h1>ログインできないとき</h1>
    <p class="lead">自分で戻せる方法から、試してください。</p>
    {connections.email || connections.line ? <><h2>ほかの方法でログインする</h2><p>つないであるログインの方法なら、IDやパスワードが分からなくてもログインできます。</p>
      {(["email", "line"] as const).map((kind) => connections[kind] ? <form method="post" action={adminPath(c.var.ward, `/sign-in-connect/${kind}/start`)}><button class="secondary">{kind === "line" ? "LINE" : "メール"}でログインする</button></form> : null)}</> : null}
    <h2>ほかにログインできるスマホやパソコンがあるとき</h2><p>ログインできるスマホやパソコンで「自治会の設定」の「この画面を使える人」を開き、自分の名前の「ログインするためのリンクを出す」を押してください。出たリンクをこのスマホやパソコンで開くと、ログインし直せます。</p>
    <h2>自分で戻せないとき</h2><p>ほかの役員に頼んでください。「この画面を使える人」から、ログインするためのリンクを作ってもらえます。</p>
    <h2>ほかの役員もログインできないとき</h2><p>連絡のつく連絡先を伝えてください。登録したメールが使えなくなったときも、連絡のつく所へ連絡します。</p>
    <a class="button" href={`/contact?ward=${encodeURIComponent(c.var.ward.name)}`}>SasaeAIに問い合わせる</a>
  </Layout>);
});
loginRoutes.route("/", signInRoutes);
