import { Hono } from "hono";
import type { WardEnv } from "../env";
import { adminPath, issueDevice, safeNext } from "./auth";
import { cleanLoginId, cleanName, hashPassword, loginIdProblem, nameKey, safeEqual } from "./password";
import { Layout, Notice } from "./ui";

// 役員画面のログイン。ID と長いパスワード。公開の入口なので、ID の有無は答えに出さない。

export const loginRoutes = new Hono<WardEnv>();

const LoginPage = (props: { wardName: string; action: string; next: string; error?: string }) => (
  <Layout title={`${props.wardName} 役員画面のログイン`} siteName={props.wardName} noindex>
    <h1>役員画面にログイン</h1>
    {props.error ? <Notice error>{props.error}</Notice> : null}
    <form method="post" action={props.action}>
      <input type="hidden" name="next" value={props.next} />
      <label for="loginId">ID</label>
      <input id="loginId" name="loginId" type="text" autocomplete="username" autocapitalize="none" spellcheck={false} required />
      <label for="password">パスワード</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <p>
        <button type="submit">ログイン</button>
      </p>
    </form>
    <p class="muted">パスワードは、役員の誰かが作って渡した長い文字です。この端末は、ログインすると次から入力を省けます。</p>
  </Layout>
);

loginRoutes.get("/login", (c) => {
  const ward = c.var.ward;
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  return c.html(
    <LoginPage
      wardName={ward.name}
      action={adminPath(ward, "/login")}
      next={safeNext(ward, c.req.query("next"))}
    />,
  );
});

// ID が無い時も同じだけ要約を計算して、時間差で ID の有無を漏らさない。
const DUMMY_SALT = "no-such-account";

loginRoutes.post("/login", async (c) => {
  const ward = c.var.ward;
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
      ? "SELECT account_id, password_salt, password_hash FROM accounts WHERE ward_id = ? AND login_id = ? AND removed_at IS NULL"
      : "SELECT account_id, password_salt, password_hash FROM accounts WHERE ward_id = ? AND name_key = ? AND removed_at IS NULL",
  )
    .bind(ward.wardId, hasLoginId ? identity : nameKey(identity))
    .first<{ account_id: string; password_salt: string; password_hash: string }>();

  const computed = await hashPassword(password, account?.password_salt ?? DUMMY_SALT);
  const ok = account ? safeEqual(computed, account.password_hash) : false;
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  if (!account || !ok || (hasLoginId && loginIdProblem(rawIdentity) !== null)) {
    return c.html(
      <LoginPage
        wardName={ward.name}
        action={adminPath(ward, "/login")}
        next={next}
        error="名前かパスワードが違います。"
      />,
      401,
    );
  }
  await issueDevice(c, ward, account.account_id);
  return c.redirect(next, 303);
});
