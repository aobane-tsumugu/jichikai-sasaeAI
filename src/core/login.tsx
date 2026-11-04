import { Hono } from "hono";
import type { WardEnv } from "../env";
import { adminPath, issueDevice, safeNext } from "./auth";
import { cleanName, hashPassword, nameKey, safeEqual } from "./password";
import { Layout, Notice } from "./ui";

// 役員画面のログイン。名前と長いパスワード。公開の入口なので、名前の有無は答えに出さない。

export const loginRoutes = new Hono<WardEnv>();

const LoginPage = (props: { wardName: string; action: string; next: string; error?: string }) => (
  <Layout title={`${props.wardName} 役員画面のログイン`} siteName={props.wardName} noindex>
    <h1>役員画面にログイン</h1>
    {props.error ? <Notice error>{props.error}</Notice> : null}
    <form method="post" action={props.action}>
      <input type="hidden" name="next" value={props.next} />
      <label for="name">名前</label>
      <input id="name" name="name" type="text" autocomplete="username" required />
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

// 名前が無い時も同じだけ要約を計算して、時間差で名前の有無を漏らさない（乱数はグローバルの外でしか作れないので固定の値）
const DUMMY_SALT = "no-such-account";

loginRoutes.post("/login", async (c) => {
  const ward = c.var.ward;
  const form = await c.req.parseBody();
  const name = typeof form["name"] === "string" ? form["name"] : "";
  const password = typeof form["password"] === "string" ? form["password"] : "";
  const next = safeNext(ward, typeof form["next"] === "string" ? form["next"] : undefined);

  const account = await c.env.DB.prepare(
    "SELECT account_id, password_salt, password_hash FROM accounts WHERE ward_id = ? AND name_key = ? AND removed_at IS NULL",
  )
    .bind(ward.wardId, nameKey(name))
    .first<{ account_id: string; password_salt: string; password_hash: string }>();

  const computed = await hashPassword(password, account?.password_salt ?? DUMMY_SALT);
  const ok = account ? safeEqual(computed, account.password_hash) : false;
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  if (!account || !ok || cleanName(name) === "") {
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
