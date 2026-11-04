import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { baseUrl, wardUrl } from "../core/ward";
import { Credentials, Layout, Notice } from "../core/ui";
import type { AppEnv } from "../env";
import { CutLine, PrintDocument, PrintQr, Sheet, qrSvg } from "../print";
import { addAccount, listAccounts, resetPassword } from "../settings/accounts";
import { checkOpsLogin, createOpsSession, OPS_COOKIE, OPS_SESSION_HOURS, opsConfigured, verifyOpsSession } from "./session";
import { listWards, openWard } from "./wards";

// 束 1: 運用の画面（提供側の ID とパスワード）。/ops に付く。
// 区の一覧と開設、固定 URL と QR、A4 の案内、最初の役員のアカウントの足す・初期化（役員が入れなくなった時）。
// 区の開設は scripts/open-ward.ts からも同じ入口（POST /ops/wards、Accept: application/json）で行う。

export const opsRoutes = new Hono<AppEnv>();

type OpsContext = Context<AppEnv>;

function wantsJson(c: OpsContext): boolean {
  return (c.req.header("accept") ?? "").includes("application/json");
}

const OpsPage = (props: { title: string; loggedIn?: boolean; children?: unknown }) => (
  <Layout
    title={`${props.title} 運用の画面`}
    siteName="運用の画面（提供側）"
    noindex
    headerRight={
      props.loggedIn ? (
        <form class="inline" method="post" action="/ops/logout">
          <button type="submit" class="secondary">
            ログアウト
          </button>
        </form>
      ) : null
    }
  >
    {props.children as never}
  </Layout>
);

opsRoutes.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  await next();
});

// ---- ログイン（ログインの検査の外） ----

const LoginForm = (props: { error?: string }) => (
  <OpsPage title="ログイン">
    <h1>運用の画面にログイン</h1>
    {props.error ? <Notice error>{props.error}</Notice> : null}
    <form method="post" action="/ops/login">
      <label for="id">ID</label>
      <input id="id" name="id" type="text" autocomplete="username" required />
      <label for="password">パスワード</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <p>
        <button type="submit">ログイン</button>
      </p>
    </form>
  </OpsPage>
);

const NotConfigured = () => (
  <OpsPage title="未設定">
    <h1>運用の画面は設定されていません</h1>
    <p>Workers の secrets に OPS_ID と OPS_PASSWORD を入れると使えます。</p>
  </OpsPage>
);

opsRoutes.get("/login", (c) => (opsConfigured(c.env) ? c.html(<LoginForm />) : c.html(<NotConfigured />, 503)));

opsRoutes.post("/login", async (c) => {
  if (!opsConfigured(c.env)) return c.html(<NotConfigured />, 503);
  const form = await c.req.parseBody();
  const id = typeof form["id"] === "string" ? form["id"] : "";
  const password = typeof form["password"] === "string" ? form["password"] : "";
  if (!(await checkOpsLogin(c.env, id, password))) {
    return c.html(<LoginForm error="ID かパスワードが違います。" />, 401);
  }
  setCookie(c, OPS_COOKIE, await createOpsSession(c.env), {
    path: "/ops",
    httpOnly: true,
    sameSite: "Strict",
    secure: new URL(c.req.url).protocol === "https:",
    maxAge: OPS_SESSION_HOURS * 60 * 60,
  });
  return c.redirect("/ops/", 303);
});

// ---- ここから先はログインが要る ----

opsRoutes.use("*", async (c, next) => {
  if (!opsConfigured(c.env)) return c.html(<NotConfigured />, 503);
  if (!(await verifyOpsSession(c.env, getCookie(c, OPS_COOKIE)))) {
    if (wantsJson(c)) return c.json({ ok: false, message: "ログインしていません。" }, 401);
    return c.redirect("/ops/login", 303);
  }
  await next();
});

opsRoutes.post("/logout", (c) => {
  deleteCookie(c, OPS_COOKIE, { path: "/ops" });
  return c.redirect("/ops/login", 303);
});

// ---- 区の一覧と開設 ----

const OpenForm = (props: { error?: string; values?: { slug: string; name: string; firstAccountName: string } }) => (
  <>
    <h2>区を開く</h2>
    {props.error ? <Notice error>{props.error}</Notice> : null}
    <form method="post" action="/ops/wards" class="panel">
      <label for="name">区の名前</label>
      <input id="name" name="name" type="text" required maxlength={60} value={props.values?.name ?? ""} />
      <label for="slug">区の URL（小文字の英数字とハイフン。例 aozora-ku）</label>
      <input id="slug" name="slug" type="text" required maxlength={40} value={props.values?.slug ?? ""} />
      <label for="first">最初の役員の名前</label>
      <input id="first" name="firstAccountName" type="text" required maxlength={40} value={props.values?.firstAccountName ?? ""} />
      <p>
        <button type="submit">開く</button>
      </p>
    </form>
  </>
);

opsRoutes.get("/", async (c) => {
  const wards = await listWards(c.env.DB);
  return c.html(
    <OpsPage title="区の一覧" loggedIn>
      <h1>区の一覧</h1>
      {wards.length === 0 ? (
        <p class="muted">まだ区がありません。</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>区</th>
              <th>URL</th>
              <th>アカウント</th>
            </tr>
          </thead>
          <tbody>
            {wards.map((w) => (
              <tr>
                <td>
                  <a href={`/ops/wards/${w.slug}`}>{w.name}</a>
                </td>
                <td>{wardUrl(c.env, c.req.url, w.slug)}</td>
                <td>{w.accountCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <OpenForm />
    </OpsPage>,
  );
});

opsRoutes.post("/wards", async (c) => {
  const form = await c.req.parseBody();
  const text = (key: string) => (typeof form[key] === "string" ? (form[key] as string) : "");
  const input = { slug: text("slug"), name: text("name"), firstAccountName: text("firstAccountName") };
  const result = await openWard(c.env.DB, input);

  if (!result.ok) {
    if (wantsJson(c)) return c.json({ ok: false, message: result.message }, 400);
    return c.html(
      <OpsPage title="区を開く" loggedIn>
        <h1>区を開けませんでした</h1>
        <OpenForm error={result.message} values={input} />
      </OpsPage>,
      400,
    );
  }

  const url = wardUrl(c.env, c.req.url, result.ward.slug);
  const adminUrl = `${url}admin/`;
  if (wantsJson(c)) {
    return c.json(
      {
        ok: true,
        slug: result.ward.slug,
        name: result.ward.name,
        url,
        adminUrl,
        qrSvgUrl: `${baseUrl(c.env, c.req.url)}/ops/wards/${result.ward.slug}/qr.svg`,
        account: { name: result.account.name, password: result.account.password },
      },
      201,
    );
  }
  return c.html(
    <OpsPage title="区を開きました" loggedIn>
      <h1>区を開きました</h1>
      <Credentials name={result.account.name} password={result.account.password} />
      <WardUrls url={url} adminUrl={adminUrl} slug={result.ward.slug} />
    </OpsPage>,
    201,
  );
});

const WardUrls = (props: { url: string; adminUrl: string; slug: string }) => (
  <>
    <h2>固定 URL と QR</h2>
    <p>
      区のページ: <a href={props.url}>{props.url}</a>
    </p>
    <p>
      役員画面: <a href={props.adminUrl}>{props.adminUrl}</a>
    </p>
    <div class="qrbox" dangerouslySetInnerHTML={{ __html: qrSvg(props.url) }} />
    <p>
      <a class="button secondary" href={`/ops/wards/${props.slug}/sheet`}>
        A4 の案内を開く（印刷）
      </a>{" "}
      <a class="button secondary" href={`/ops/wards/${props.slug}/qr.svg`}>
        QR の画像
      </a>
    </p>
  </>
);

// ---- 区ごとの画面 ----

async function wardOrNull(c: OpsContext, slug: string) {
  const row = await c.env.DB.prepare("SELECT ward_id, slug, name FROM wards WHERE slug = ?")
    .bind(slug)
    .first<{ ward_id: string; slug: string; name: string }>();
  return row ? { wardId: row.ward_id, slug: row.slug, name: row.name } : null;
}

const WardNotFound = () => (
  <OpsPage title="見つかりません" loggedIn>
    <h1>その区は見つかりません</h1>
    <p>
      <a href="/ops/">区の一覧へ</a>
    </p>
  </OpsPage>
);

opsRoutes.get("/wards/:slug", async (c) => {
  const ward = await wardOrNull(c, c.req.param("slug"));
  if (!ward) return c.html(<WardNotFound />, 404);
  const accounts = await listAccounts(c.env.DB, ward.wardId);
  const url = wardUrl(c.env, c.req.url, ward.slug);
  return c.html(
    <OpsPage title={ward.name} loggedIn>
      <p>
        <a href="/ops/">区の一覧</a>
      </p>
      <h1>{ward.name}</h1>
      <WardUrls url={url} adminUrl={`${url}admin/`} slug={ward.slug} />
      <h2>役員のアカウント</h2>
      <p class="muted">役員全員が入れなくなった時のために、提供側からも足す・初期化ができます。</p>
      <table>
        <thead>
          <tr>
            <th>名前</th>
            <th>席</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr>
              <td>{a.name}</td>
              <td>{a.seatTitle ?? ""}</td>
              <td>
                <form
                  class="inline"
                  method="post"
                  action={`/ops/wards/${ward.slug}/accounts/${a.accountId}/reset`}
                  onsubmit="return confirm('パスワードを作り直します。古いパスワードと、この人の端末の記憶は使えなくなります。')"
                >
                  <button type="submit" class="secondary">
                    初期化
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form method="post" action={`/ops/wards/${ward.slug}/accounts`} class="panel">
        <label for="newname">アカウントを足す（名前）</label>
        <input id="newname" name="name" type="text" required maxlength={40} />
        <p>
          <button type="submit">足す</button>
        </p>
      </form>
    </OpsPage>,
  );
});

opsRoutes.post("/wards/:slug/accounts", async (c) => {
  const ward = await wardOrNull(c, c.req.param("slug"));
  if (!ward) return c.html(<WardNotFound />, 404);
  const form = await c.req.parseBody();
  const result = await addAccount(c.env.DB, ward.wardId, { name: typeof form["name"] === "string" ? form["name"] : "" });
  if (!result.ok) {
    return c.html(
      <OpsPage title="足せませんでした" loggedIn>
        <Notice error>{result.message}</Notice>
        <p>
          <a href={`/ops/wards/${ward.slug}`}>戻る</a>
        </p>
      </OpsPage>,
      400,
    );
  }
  return c.html(
    <OpsPage title="アカウントを足しました" loggedIn>
      <h1>アカウントを足しました</h1>
      <Credentials name={result.name} password={result.password} />
      <p>
        <a href={`/ops/wards/${ward.slug}`}>区の画面へ戻る</a>
      </p>
    </OpsPage>,
    201,
  );
});

opsRoutes.post("/wards/:slug/accounts/:accountId/reset", async (c) => {
  const ward = await wardOrNull(c, c.req.param("slug"));
  if (!ward) return c.html(<WardNotFound />, 404);
  const result = await resetPassword(c.env.DB, ward.wardId, c.req.param("accountId"));
  if (!result.ok) {
    return c.html(
      <OpsPage title="初期化できませんでした" loggedIn>
        <Notice error>{result.message}</Notice>
        <p>
          <a href={`/ops/wards/${ward.slug}`}>戻る</a>
        </p>
      </OpsPage>,
      404,
    );
  }
  return c.html(
    <OpsPage title="パスワードを作り直しました" loggedIn>
      <h1>パスワードを作り直しました</h1>
      <Credentials name={result.name} password={result.password} />
      <p>
        <a href={`/ops/wards/${ward.slug}`}>区の画面へ戻る</a>
      </p>
    </OpsPage>,
  );
});

// ---- QR と A4 の案内 ----

opsRoutes.get("/wards/:slug/qr.svg", async (c) => {
  const ward = await wardOrNull(c, c.req.param("slug"));
  if (!ward) return c.text("見つかりません", 404);
  return c.body(qrSvg(wardUrl(c.env, c.req.url, ward.slug)), 200, {
    "Content-Type": "image/svg+xml; charset=utf-8",
  });
});

opsRoutes.get("/wards/:slug/sheet", async (c) => {
  const ward = await wardOrNull(c, c.req.param("slug"));
  if (!ward) return c.html(<WardNotFound />, 404);
  const url = wardUrl(c.env, c.req.url, ward.slug);
  return c.html(
    <PrintDocument title={`${ward.name} 区のページの案内`}>
      <Sheet footer={<span>{ward.name}</span>}>
        <h1>{ward.name} 区のページ</h1>
        <p>案内、お知らせ、手伝いの募集は、スマートフォンやパソコンから、登録なしでご覧になれます。</p>
        <p>下の QR をスマートフォンのカメラで読み取ると、区のページが開きます。</p>
        <p style="text-align:center">
          <PrintQr text={url} sizeMm={70} />
        </p>
        <p style="text-align:center; font-size:16pt; overflow-wrap:anywhere">{url}</p>
        <CutLine label="ここから下は役員の控え" />
        <p>役員画面（役員の名前とパスワードでログインします）: {`${url}admin/`}</p>
      </Sheet>
    </PrintDocument>,
  );
});
