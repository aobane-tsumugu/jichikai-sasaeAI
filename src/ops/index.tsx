import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { baseUrl, wardUrl } from "../core/ward";
import { Credentials, Layout, Notice } from "../core/ui";
import type { AppEnv } from "../env";
import { CutLine, PrintDocument, PrintQr, Sheet, qrSvg } from "../print";
import { dispatchProject, SESSION_BUDGET_CENTS } from "../ai/session";
import { retryJob } from "../intake/api";
import { addAccount, listAccounts, resetPassword } from "../settings/accounts";
import { checkOpsLogin, createOpsSession, OPS_COOKIE, OPS_SESSION_HOURS, opsConfigured, verifyOpsSession } from "./session";
import { getWardMetrics, listWardQueue, type MonthlyMetrics } from "./metrics";
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
      <p><a href="/ops/costs">全体の費用を見る</a></p>
      {wards.length === 0 ? (
        <p class="muted">まだ区がありません。</p>
      ) : (
        wards.map((w) => (
          <section class="panel">
            <h2><a href={`/ops/wards/${w.slug}`}>{w.name}</a></h2>
            <p>区のページ: <a href={wardUrl(c.env, c.req.url, w.slug)}>{wardUrl(c.env, c.req.url, w.slug)}</a></p>
            <p>役員のアカウント {w.accountCount} 件</p>
            <nav class="action-links" aria-label={`${w.name} の画面`}>
              <a class="button secondary" href={`/ops/wards/${w.slug}/sheet`}>A4 の案内</a>
              <a class="button secondary" href={`/ops/wards/${w.slug}/costs`}>費用</a>
              <a class="button secondary" href={`/ops/wards/${w.slug}/budget`}>予算</a>
              <a class="button secondary" href={`/ops/wards/${w.slug}/queue`}>処理状況</a>
            </nav>
          </section>
        ))
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
      <nav class="action-links" aria-label="提供側の画面">
        <a class="button secondary" href={`/ops/wards/${ward.slug}/costs`}>費用</a>
        <a class="button secondary" href={`/ops/wards/${ward.slug}/budget`}>予算</a>
        <a class="button secondary" href={`/ops/wards/${ward.slug}/queue`}>処理状況</a>
      </nav>
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

const usd = (cents: number) => `${(cents / 100).toLocaleString("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} USD`;
const minutes = (milliseconds: number) => `${(milliseconds / 60_000).toLocaleString("ja-JP", { maximumFractionDigits: 1 })} 分`;

function summarize(months: MonthlyMetrics[]) {
  return months.reduce((sum, row) => ({
    inputs: sum.inputs + row.inputs,
    readRuns: sum.readRuns + row.readRuns,
    connectRuns: sum.connectRuns + row.connectRuns,
    readTokens: sum.readTokens + row.readTokens,
    connectTokens: sum.connectTokens + row.connectTokens,
    readEstimateCents: sum.readEstimateCents + row.readEstimateCents,
    actualRunCostCents: sum.actualRunCostCents + row.actualRunCostCents,
    durationMs: sum.durationMs + row.durationMs,
    failed: sum.failed + row.failed,
    attention: sum.attention + row.attention,
  }), {
    inputs: 0, readRuns: 0, connectRuns: 0, readTokens: 0, connectTokens: 0,
    readEstimateCents: 0, actualRunCostCents: 0, durationMs: 0, failed: 0, attention: 0,
  });
}

function CostCard(props: { months: MonthlyMetrics[]; title: string }) {
  const total = summarize(props.months);
  const totalCost = total.readEstimateCents + total.actualRunCostCents;
  return (
    <section class="panel">
      <h2>{props.title}</h2>
      <p>入力 {total.inputs.toLocaleString("ja-JP")} 件</p>
      <p>読む {total.readRuns.toLocaleString("ja-JP")} 回・{total.readTokens.toLocaleString("ja-JP")} トークン、つなぐ {total.connectRuns.toLocaleString("ja-JP")} 回・{total.connectTokens.toLocaleString("ja-JP")} トークン</p>
      <p>費用: 読む見積もり {usd(total.readEstimateCents)}、処理記録の金額 {usd(total.actualRunCostCents)}、合計 {usd(totalCost)}</p>
      <p>入力一つあたり: {total.inputs ? usd(Math.round(totalCost / total.inputs)) : "—"}、平均 {total.inputs ? minutes(total.durationMs / total.inputs) : "—"}</p>
      <p>失敗 {total.failed.toLocaleString("ja-JP")} 件、要対応 {total.attention.toLocaleString("ja-JP")} 件</p>
    </section>
  );
}

opsRoutes.get("/costs", async (c) => {
  const wards = await listWards(c.env.DB);
  const summaries = await Promise.all(wards.map((ward) => getWardMetrics(c.env.DB, ward)));
  const months = [...new Set(summaries.flatMap((ward) => ward.months.map((row) => row.month)))].sort((a, b) => b.localeCompare(a));
  return c.html(
    <OpsPage title="費用" loggedIn>
      <p><a href="/ops/">区の一覧</a></p>
      <h1>費用</h1>
      <p>読む費用は Sonnet 5.5 の公開単価による見積もりです。処理記録の金額も加算しています。</p>
      <CostCard months={summaries.flatMap((ward) => ward.months)} title="全体の合計" />
      <h2>区ごと</h2>
      {summaries.map((ward) => {
        const total = summarize(ward.months);
        return <section class="panel"><h3><a href={`/ops/wards/${ward.slug}/costs`}>{ward.name}</a></h3><p>入力 {total.inputs} 件、費用 {usd(total.readEstimateCents + total.actualRunCostCents)}</p></section>;
      })}
      <h2>月ごとの全体</h2>
      {months.map((month) => <CostCard months={summaries.flatMap((ward) => ward.months.filter((row) => row.month === month))} title={month} />)}
      {summaries.length === 0 ? <p class="muted">区がありません。</p> : null}
    </OpsPage>,
  );
});

opsRoutes.get("/wards/:slug/costs", async (c) => {
  const ward = await wardOrNull(c, c.req.param("slug"));
  if (!ward) return c.html(<WardNotFound />, 404);
  const metrics = await getWardMetrics(c.env.DB, ward);
  return c.html(
    <OpsPage title={`${ward.name} の費用`} loggedIn>
      <p><a href={`/ops/wards/${ward.slug}`}>{ward.name} の画面</a></p>
      <h1>{ward.name} の費用</h1>
      <p>読む費用は Sonnet 5.5 の公開単価による見積もりです。処理記録の金額も加算しています。</p>
      <CostCard months={metrics.months} title="全体の合計" />
      <h2>月ごと</h2>
      {metrics.months.map((row) => <CostCard months={[row]} title={row.month} />)}
      {metrics.months.length === 0 ? <p class="muted">費用の記録はまだありません。</p> : null}
    </OpsPage>,
  );
});

opsRoutes.get("/wards/:slug/budget", async (c) => {
  const ward = await wardOrNull(c, c.req.param("slug"));
  if (!ward) return c.html(<WardNotFound />, 404);
  const metrics = await getWardMetrics(c.env.DB, ward);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const current = metrics.months.find((row) => row.month === thisMonth);
  const currentCost = (current?.readEstimateCents ?? 0) + (current?.actualRunCostCents ?? 0);
  const ratio = metrics.monthlyLimitCents > 0 ? currentCost / metrics.monthlyLimitCents : 0;
  return c.html(
    <OpsPage title={`${ward.name} の予算`} loggedIn>
      <p><a href={`/ops/wards/${ward.slug}`}>{ward.name} の画面</a></p>
      <h1>{ward.name} の予算</h1>
      <section class="panel">
        <h2>一回の処理</h2>
        <p>現在の上限: {SESSION_BUDGET_CENTS} USD</p>
        <p class="muted">一回の処理の上限変更は、AI の処理側に設定が必要です。</p>
      </section>
      <section class="panel">
        <h2>今月</h2>
        <p>費用 {usd(currentCost)} / 目安上限 {metrics.monthlyLimitCents ? usd(metrics.monthlyLimitCents) : "未設定"}</p>
        {metrics.monthlyLimitCents > 0 && ratio >= 1 ? <p class="notice error">目安上限に達しています。</p>
          : metrics.monthlyLimitCents > 0 && ratio >= 0.8 ? <p class="notice">目安上限に近づいています。</p>
            : null}
        <p>目安上限に達しても、役員の配る操作は止まりません。</p>
        <form method="post" action={`/ops/wards/${ward.slug}/budget`}>
          <label for="monthlyLimit">月の目安上限（USD。0 は上限なし）</label>
          <input id="monthlyLimit" name="monthlyLimit" type="number" min="0" step="0.01" required value={(metrics.monthlyLimitCents / 100).toFixed(2)} />
          <p><button type="submit">保存</button></p>
        </form>
      </section>
    </OpsPage>,
  );
});

opsRoutes.post("/wards/:slug/budget", async (c) => {
  const ward = await wardOrNull(c, c.req.param("slug"));
  if (!ward) return c.html(<WardNotFound />, 404);
  const form = await c.req.parseBody();
  const raw = typeof form["monthlyLimit"] === "string" ? form["monthlyLimit"] : "";
  const amount = Number(raw);
  if (!Number.isFinite(amount) || amount < 0 || amount > 10_000_000) {
    return c.html(<OpsPage title="予算を保存できません" loggedIn><h1>金額を確認してください</h1><p><a href={`/ops/wards/${ward.slug}/budget`}>戻る</a></p></OpsPage>, 400);
  }
  const cents = Math.round(amount * 100);
  await c.env.DB.prepare(
    `INSERT INTO ops_ward_limits (ward_id, monthly_limit_cents, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (ward_id) DO UPDATE SET monthly_limit_cents = excluded.monthly_limit_cents, updated_at = excluded.updated_at`,
  ).bind(ward.wardId, cents, new Date().toISOString()).run();
  return c.redirect(`/ops/wards/${ward.slug}/budget`, 303);
});

const QUEUE_STATUS: Record<string, string> = {
  received: "受け付けました", reading: "読んでいます", read: "つなぐのを待っています",
  connecting: "つないでいます", attention: "要対応", failed: "失敗",
};
const QUEUE_FAILURE: Record<string, string> = {
  unsupported: "対応していない形式", too_large: "大きすぎます", unreadable: "読めませんでした",
  refused: "処理できませんでした", error: "処理中に問題が起きました", connect: "つなげられませんでした",
};

opsRoutes.get("/wards/:slug/queue", async (c) => {
  const ward = await wardOrNull(c, c.req.param("slug"));
  if (!ward) return c.html(<WardNotFound />, 404);
  const jobs = await listWardQueue(c.env.DB, ward.wardId);
  return c.html(
    <OpsPage title={`${ward.name} の処理状況`} loggedIn>
      <p><a href={`/ops/wards/${ward.slug}`}>{ward.name} の画面</a></p>
      <h1>{ward.name} の処理状況</h1>
      {jobs.length === 0 ? <p class="muted">対応が必要な物はありません。</p> : jobs.map((job) => (
        <section class="panel">
          <h2>{QUEUE_STATUS[job.status]}</h2>
          <p>受け付け: {new Date(job.createdAt).toLocaleString("ja-JP")}<br />種類: {job.task === "connect" ? "入力" : "下書き"}{job.failure ? <><br />理由: {QUEUE_FAILURE[job.failure] ?? "内容を確認してください"}</> : null}</p>
          {job.status === "failed" || (job.status === "attention" && job.projectId) ? (
            <form method="post" action={`/ops/wards/${ward.slug}/queue/${job.jobId}/retry`}>
              <button type="submit">もう一度動かす</button>
            </form>
          ) : null}
        </section>
      ))}
    </OpsPage>,
  );
});

opsRoutes.post("/wards/:slug/queue/:jobId/retry", async (c) => {
  const ward = await wardOrNull(c, c.req.param("slug"));
  if (!ward) return c.html(<WardNotFound />, 404);
  const jobId = c.req.param("jobId");
  const row = await c.env.DB.prepare("SELECT status, project_id FROM jobs WHERE ward_id = ? AND job_id = ?")
    .bind(ward.wardId, jobId).first<{ status: string; project_id: string | null }>();
  if (row?.status === "attention" && row.project_id) {
    const reset = await c.env.DB.prepare(
      `UPDATE jobs SET status = 'read', failure = '', stop_reason = '', finished_at = NULL, updated_at = ?
        WHERE ward_id = ? AND job_id = ? AND status = 'attention'`,
    ).bind(new Date().toISOString(), ward.wardId, jobId).run();
    if ((reset.meta.changes ?? 0) > 0) c.executionCtx.waitUntil(dispatchProject(c.env, ward.wardId, row.project_id));
  } else if (row?.status === "failed") {
    await retryJob(c.env, { waitUntil: (promise) => c.executionCtx.waitUntil(promise) }, ward.wardId, jobId);
  }
  return c.redirect(`/ops/wards/${ward.slug}/queue`, 303);
});
