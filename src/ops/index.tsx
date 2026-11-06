import { AnswerLabelFields, getAnswerLabels, saveAnswerLabels } from "../settings/answer-labels";
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
import { clearLoginFailures, delayLoginAfterFailures } from "../core/login-throttle";
import { formatJstDate, formatJst } from "../core/time";
import { lifecyclePages } from "./lifecycle-pages";
import { readSpacePaper } from "../space/receive-paper";

// 束 1: 運用の画面（提供側の ID とパスワード）。/ops に付く。
// 区の一覧と開設、固定 URL と QR、A4 の案内、最初の役員の入る人の足す・初期化（役員が入れなくなった時）。
// 区の開設は scripts/open-ward.ts からも同じ入口（POST /ops/wards、Accept: application/json）で行う。

export const opsRoutes = new Hono<AppEnv>();

type OpsContext = Context<AppEnv>;

function wantsJson(c: OpsContext): boolean {
  return (c.req.header("accept") ?? "").includes("application/json");
}

const OpsPage = (props: { title: string; loggedIn?: boolean; children?: unknown }) => (
  <Layout
    title={`${props.title}運用の画面`}
    siteName="SasaeAI 運用の画面"
    noindex
    headerRight={
      props.loggedIn ? (
        <form class="inline" method="post" action="/ops/logout">
          <button type="submit" class="secondary">
            このスマホやパソコンから出る
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
  <OpsPage title="入る">
    <h1>運用の画面に入る</h1>
    {props.error ? <Notice error>{props.error}</Notice> : null}
    <form method="post" action="/ops/login">
      <label for="id">ID</label>
      <input id="id" name="id" type="text" autocomplete="username" required />
      <label for="password">パスワード</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required />
      <p>
        <button type="submit">入る</button>
      </p>
    </form>
  </OpsPage>
);

const NotConfigured = () => (
  <OpsPage title="まだ決めていません">
    <h1>運用の画面は設定されていません</h1>
    <p>WorkersのsecretsにOPS_IDとOPS_PASSWORDを入れると使えます。</p>
  </OpsPage>
);

opsRoutes.get("/login", (c) => (opsConfigured(c.env) ? c.html(<LoginForm />) : c.html(<NotConfigured />, 503)));

opsRoutes.post("/login", async (c) => {
  if (!opsConfigured(c.env)) return c.html(<NotConfigured />, 503);
  const form = await c.req.parseBody();
  const id = typeof form["id"] === "string" ? form["id"] : "";
  const password = typeof form["password"] === "string" ? form["password"] : "";
  if (!(await checkOpsLogin(c.env, id, password))) {
    await delayLoginAfterFailures(c.env.DB, "provider", c.env.OPS_ID ?? "provider");
    return c.html(<LoginForm error="IDかパスワードが違います。" />, 401);
  }
  await clearLoginFailures(c.env.DB, "provider", c.env.OPS_ID ?? "provider");
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
    if (wantsJson(c)) return c.json({ ok: false, message: "まだ入っていません。" }, 401);
    return c.redirect("/ops/login", 303);
  }
  await next();
});

opsRoutes.post("/logout", (c) => {
  deleteCookie(c, OPS_COOKIE, { path: "/ops" });
  return c.redirect("/ops/login", 303);
});

// ---- 区の一覧と開設 ----

const OpenForm = (props: { error?: string; values?: { slug: string; name: string; firstAccountName: string; lineDestination?: string } }) => (
  <>
    <h2 id="open-ward">新しい区を開く</h2>
    {props.error ? <Notice error>{props.error}</Notice> : null}
    <form method="post" action="/ops/wards" class="panel">
      <label for="name">区の名前</label>
      <input id="name" name="name" type="text" required maxlength={60} value={props.values?.name ?? ""} />
      <label for="slug">区のページのアドレスに入れる名前（小文字の英数字とハイフン。例aozora-ku）</label>
      <input id="slug" name="slug" type="text" required maxlength={40} value={props.values?.slug ?? ""} />
      <label for="first">最初の役員の名前</label>
      <input id="first" name="firstAccountName" type="text" required maxlength={40} value={props.values?.firstAccountName ?? ""} />
      <details><summary>公式LINEを使う区だけ</summary>
        <label for="line-destination">公式LINEの送信先ID（書かなくてかまいません）</label>
        <input id="line-destination" name="lineDestination" type="text" maxlength={100} value={props.values?.lineDestination ?? ""} />
        <p>鍵の値は入力しません。開いたあとに出る名前で、提供側の設定に入れてください。</p>
      </details>
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
      <h1>区の一覧</h1><p class="lead">SasaeAIを提供している区です。区の名前を押すと、その区の画面が開きます。</p><a class="quiet" href="#open-ward">新しい区を開く</a>
      <p><a href="/ops/costs">全体の費用を見る</a></p>
      <p><a href="/ops/deletions">消去の状況</a></p>
      {wards.length === 0 ? (
        <p class="muted">まだ区がありません。</p>
      ) : (
        wards.map((w) => (
          <p><a class="row-link" href={`/ops/wards/${w.slug}`}><b>{w.name}</b><span>役員の入る人{w.accountCount}人</span><span>見てほしいもの{w.attentionCount}件</span><span>区のページ {wardUrl(c.env, c.req.url, w.slug)}</span></a></p>
        ))
      )}
      <OpenForm />
    </OpsPage>,
  );
});

opsRoutes.post("/wards", async (c) => {
  const form = await c.req.parseBody();
  const text = (key: string) => (typeof form[key] === "string" ? (form[key] as string) : "");
  const input = { slug: text("slug"), name: text("name"), firstAccountName: text("firstAccountName"), lineDestination: text("lineDestination") };
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
        account: { loginId: result.account.loginId, name: result.account.name, password: result.account.password },
        ...(result.line ? { line: result.line } : {}),
      },
      201,
    );
  }
  return c.html(
    <OpsPage title="区を開きました" loggedIn>
      <h1>区を開きました</h1>
      <Credentials loginId={result.account.loginId} name={result.account.name} password={result.account.password} />
      {result.line ? <><h2>公式LINEの鍵の設定</h2>
        <p>Workers secretsに次の名前で鍵を設定してください。値はこの画面にもD1にも保存しません。</p>
        <p>チャネルシークレット: <code>{result.line.channelSecretBinding}</code></p>
        <p>チャネルアクセストークン: <code>{result.line.accessTokenBinding}</code></p>
      </> : null}
      <WardUrls url={url} adminUrl={adminUrl} slug={result.ward.slug} />
    </OpsPage>,
    201,
  );
});

const WardUrls = (props: { url: string; adminUrl: string; slug: string }) => (
  <>
    <h2>区のページのアドレスとQRコード</h2>
    <p>
      区のページ: <a href={props.url}>{props.url}</a>
    </p>
    <p>
      役員画面: <a href={props.adminUrl}>{props.adminUrl}</a>
    </p>
    <div class="qrbox" dangerouslySetInnerHTML={{ __html: qrSvg(props.url) }} />
    <p>
      <a class="button secondary" href={`/ops/wards/${props.slug}/sheet`}>
        A4の案内を開く（印刷）
      </a>{" "}
      <a class="button secondary" href={`/ops/wards/${props.slug}/qr.svg`}>
        QRの画像
      </a>
    </p>
  </>
);

// ---- 区ごとの画面 ----

async function wardOrNull(c: OpsContext, slug: string) {
  const row = await c.env.DB.prepare("SELECT ward_id, slug, name FROM wards WHERE ward_id = (SELECT ward_id FROM wards WHERE slug = ?)")
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
  const labels = await getAnswerLabels(c.env.DB, ward.wardId);
  const accounts = await listAccounts(c.env.DB, ward.wardId);
  const url = wardUrl(c.env, c.req.url, ward.slug);
  return c.html(
    <OpsPage title={ward.name} loggedIn>
      <p>
        <a href="/ops/">区の一覧</a>
      </p>
      <h1>{ward.name}</h1><p class="lead">この区の提供側の画面です。役員全員が入れなくなったときに、入る人を足したり、パスワードを作り直したりします。</p>
      <h2>役員の入る人</h2>
      <p class="muted">役員がだれも入れないと連絡が来たら、パスワードを作り直す前に、区の連絡先へこちらから電話して、本人か確かめてください。</p>
      <p>パスワードを作り直すと、古いパスワードと、その人のスマホやパソコンの記憶は使えなくなります。前のパスワードには戻せません。</p>
      <table class="stack">
        <thead>
          <tr>
            <th>ID</th>
            <th>表示名</th>
            <th>役職</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr>
              <td data-label="ID">{a.loginId}</td>
              <td data-label="表示名">{a.name}</td>
              <td data-label="役職">{a.seatTitle ?? ""}</td>
              <td data-label="操作">
                <form
                  class="inline"
                  method="post"
                  action={`/ops/wards/${ward.slug}/accounts/${a.accountId}/reset`}
                >
                  <button type="submit" class="secondary">
                    パスワードを作り直す
                  </button>
                </form>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <form method="post" action={`/ops/wards/${ward.slug}/accounts`} class="panel">
        <label for="newname">足す人の表示名</label>
        <input id="newname" name="name" type="text" required maxlength={40} />
        <p>
          <button type="submit">入る人を足す</button>
        </p>
      </form>
      <h2>この区のほかの画面</h2>
      <nav class="action-links" aria-label="提供側の画面">
        <a class="row-link" href={`/ops/wards/${ward.slug}/costs`}><b>費用</b><span>月ごとに、AIに読んでもらった費用を見ます</span></a>
        <a class="row-link" href={`/ops/wards/${ward.slug}/budget`}><b>予算</b><span>一回の処理の上限と、月の目安を決めます</span></a>
        <a class="row-link" href={`/ops/wards/${ward.slug}/queue`}><b>読み取りの状況</b><span>失敗したものを、もう一度動かします</span></a>
        <a class="row-link" href={`/ops/wards/${ward.slug}/lifecycle`}><b>保管と消去</b><span>毎日の控え、引き渡し、区を止める、区の消去</span></a>
      </nav>
      <WardUrls url={url} adminUrl={`${url}admin/`} slug={ward.slug} />
      {c.req.query("labels") === "saved" ? <Notice>保存しました。次に配る案内から、この言い方で出ます。</Notice> : null}
      <form method="post" action={`/ops/wards/${ward.slug}/answer-labels`}><p>区分の数は三つのままです。役員の画面の区の情報と同じものを直します。</p><AnswerLabelFields labels={labels} /><button class="secondary" type="submit">人数の聞き方を保存する</button></form>

    </OpsPage>,
  );
});

opsRoutes.post("/wards/:slug/answer-labels", async (c) => {
  const ward = await wardOrNull(c, c.req.param("slug"));
  if (!ward) return c.html(<WardNotFound />, 404);
  if (!await saveAnswerLabels(c.env.DB, ward.wardId, await c.req.parseBody(), null)) return c.html(<OpsPage title="人数の聞き方" loggedIn><Notice error>人数の聞き方を三つとも入れてください。一つ80文字までです。</Notice><a href={`/ops/wards/${ward.slug}`}>戻る</a></OpsPage>, 400);
  return c.redirect(`/ops/wards/${ward.slug}?labels=saved`, 303);
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
    <OpsPage title="入る人を足しました" loggedIn>
      <h1>入る人を足しました</h1>
      <Credentials loginId={result.loginId} name={result.name} password={result.password} /><section class="next"><strong>次は</strong><p>この人に、IDとパスワードを渡してください。渡し終えてから、この画面を閉じてください。</p></section><p>閉じたら、もう一度パスワードを作り直せます。</p>
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
      <OpsPage title="パスワードを作り直せませんでした" loggedIn>
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
      <Credentials loginId={result.loginId} name={result.name} password={result.password} /><section class="next"><strong>次は</strong><p>この人に、IDとパスワードを渡してください。渡し終えてから、この画面を閉じてください。</p></section><p>閉じたら、もう一度パスワードを作り直せます。</p>
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
    <PrintDocument title={`${ward.name}区のページの案内`}>
      <Sheet footer={<span>{ward.name} 印刷した日: {formatJstDate(new Date().toISOString())}</span>}>
        <h1>{ward.name} 区のページ</h1>
        <p>案内、お知らせ、手伝いの募集は、スマートフォンやパソコンから、登録なしでご覧になれます。</p>
        <p>下のQRをスマートフォンのカメラで読み取ると、区のページが開きます。</p>
        <p style="text-align:center">
          <PrintQr text={url} sizeMm={70} />
        </p>
        <p style="text-align:center; font-size:16pt; overflow-wrap:anywhere">{url}</p>
        <CutLine label="ここから下は役員の控え" />
        <p>役員の画面（IDとパスワードで入ります）: {`${url}admin/`}</p>
      </Sheet>
    </PrintDocument>,
  );
});

const usd = (cents: number) => `${(cents / 100).toLocaleString("ja-JP", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}ドル`;
const minutes = (milliseconds: number) => `${(milliseconds / 60_000).toLocaleString("ja-JP", { maximumFractionDigits: 1 })}分`;

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
      <p>入力{total.inputs.toLocaleString("ja-JP")}件</p>
      <p>読む{total.readRuns.toLocaleString("ja-JP")}回・{total.readTokens.toLocaleString("ja-JP")}（読み書きした量）、つなぐ{total.connectRuns.toLocaleString("ja-JP")}回・{total.connectTokens.toLocaleString("ja-JP")}（読み書きした量）</p>
      <p>費用: 読む見積もり{usd(total.readEstimateCents)}、処理記録の金額{usd(total.actualRunCostCents)}、合計{usd(totalCost)}</p>
      <p>入力一つあたり: {total.inputs ? usd(Math.round(totalCost / total.inputs)) : "—"}、平均{total.inputs ? minutes(total.durationMs / total.inputs) : "—"}</p>
      <p>失敗{total.failed.toLocaleString("ja-JP")}件、要対応{total.attention.toLocaleString("ja-JP")}件</p>
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
      <p>読む費用はSonnet 5.5の公開単価による見積もりです。処理記録の金額も加算しています。</p>
      <CostCard months={summaries.flatMap((ward) => ward.months)} title="全体の合計" />
      <h2>区ごと</h2>
      {summaries.map((ward) => {
        const total = summarize(ward.months);
        return <section class="panel"><h3><a href={`/ops/wards/${ward.slug}/costs`}>{ward.name}</a></h3><p>入力{total.inputs}件、費用{usd(total.readEstimateCents + total.actualRunCostCents)}</p></section>;
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
    <OpsPage title={`${ward.name}の費用`} loggedIn>
      <p><a href={`/ops/wards/${ward.slug}`}>{ward.name} の画面</a></p>
      <h1>{ward.name} の費用</h1>
      <p>読む費用はSonnet 5.5の公開単価による見積もりです。処理記録の金額も加算しています。</p>
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
  const sessionBudget = await c.env.DB.prepare("SELECT session_budget_cents FROM ops_ward_limits WHERE ward_id = ?")
    .bind(ward.wardId).first<{ session_budget_cents: number }>();
  return c.html(
    <OpsPage title={`${ward.name}の予算`} loggedIn>
      <p><a href={`/ops/wards/${ward.slug}`}>{ward.name} の画面</a></p>
      <h1>{ward.name}の予算</h1><p class="lead">AIの費用の上限を決めます。上限は目安です。上限に達しても、役員の配る操作は止まりません。</p>
      <section class="panel">
        <h2>一回の処理</h2>
        <p>現在の上限: {((sessionBudget?.session_budget_cents ?? SESSION_BUDGET_CENTS) / 100).toFixed(2)}ドル</p>
        <form method="post" action={`/ops/wards/${ward.slug}/budget`}>
          <label for="sessionBudget">一回の処理の上限（USD）</label>
          <input id="sessionBudget" name="sessionBudget" type="number" min="0.01" max="10000" step="0.01" required value={((sessionBudget?.session_budget_cents ?? SESSION_BUDGET_CENTS) / 100).toFixed(2)} />
          <input type="hidden" name="saveSessionBudget" value="1" />
          <div class="action-bar"><button type="submit">一回の上限を保存</button></div>
        </form>
      </section>
      <section class="panel">
        <h2>今月</h2>
        <p>費用{usd(currentCost)} / 目安上限{metrics.monthlyLimitCents ? usd(metrics.monthlyLimitCents) : "まだ決めていません"}</p>
        {metrics.monthlyLimitCents > 0 && ratio >= 1 ? <p class="notice error">目安上限に達しています。</p>
          : metrics.monthlyLimitCents > 0 && ratio >= 0.8 ? <p class="notice">目安上限に近づいています。</p>
            : null}
        <p>目安上限に達しても、役員の配る操作は止まりません。</p>
        <form method="post" action={`/ops/wards/${ward.slug}/budget`}>
          <label for="monthlyLimit">月の目安上限（USD。0は上限なし）</label>
          <input id="monthlyLimit" name="monthlyLimit" type="number" min="0" step="0.01" required value={(metrics.monthlyLimitCents / 100).toFixed(2)} />
          <div class="action-bar"><button type="submit">月の目安を保存する</button></div>
        </form>
      </section>
    </OpsPage>,
  );
});

opsRoutes.post("/wards/:slug/budget", async (c) => {
  const ward = await wardOrNull(c, c.req.param("slug"));
  if (!ward) return c.html(<WardNotFound />, 404);
  const form = await c.req.parseBody();
  if (form["saveSessionBudget"] === "1") {
    const rawSession = typeof form["sessionBudget"] === "string" ? form["sessionBudget"] : "";
    const sessionAmount = Number(rawSession);
    if (rawSession.trim() === "" || !Number.isFinite(sessionAmount) || sessionAmount < 0.01 || sessionAmount > 10_000) {
      return c.html(<OpsPage title="予算を保存できません" loggedIn><h1>金額を確認してください</h1><p><a href={`/ops/wards/${ward.slug}/budget`}>戻る</a></p></OpsPage>, 400);
    }
    const sessionCents = Math.round(sessionAmount * 100);
    await c.env.DB.prepare(
      `INSERT INTO ops_ward_limits (ward_id, monthly_limit_cents, session_budget_cents, updated_at) VALUES (?, 0, ?, ?)
       ON CONFLICT (ward_id) DO UPDATE SET session_budget_cents = excluded.session_budget_cents, updated_at = excluded.updated_at`,
    ).bind(ward.wardId, sessionCents, new Date().toISOString()).run();
    return budgetSaved(c, ward.slug);
  }
  const raw = typeof form["monthlyLimit"] === "string" ? form["monthlyLimit"] : "";
  const amount = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(amount) || amount < 0 || amount > 10_000_000) {
    return c.html(<OpsPage title="予算を保存できません" loggedIn><h1>金額を確認してください</h1><p><a href={`/ops/wards/${ward.slug}/budget`}>戻る</a></p></OpsPage>, 400);
  }
  const cents = Math.round(amount * 100);
  await c.env.DB.prepare(
    `INSERT INTO ops_ward_limits (ward_id, monthly_limit_cents, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (ward_id) DO UPDATE SET monthly_limit_cents = excluded.monthly_limit_cents, updated_at = excluded.updated_at`,
  ).bind(ward.wardId, cents, new Date().toISOString()).run();
  return budgetSaved(c, ward.slug);
});

const QUEUE_STATUS: Record<string, string> = {
  received: "受け付けました", reading: "読んでいます", read: "段取りを作るのを待っています",
  connecting: "段取りを作っています", attention: "対応が必要", failed: "失敗",
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
    <OpsPage title={`${ward.name}の読み取りの状況`} loggedIn>
      <p><a href={`/ops/wards/${ward.slug}`}>{ward.name} の画面</a></p>
      <h1>{ward.name}の読み取りの状況</h1><p class="lead">役員が送った資料を読んで、段取りを作る処理のうち、見てほしいものです。失敗したものは、もう一度動かせます。大きすぎる資料だけは、役員に分けて送り直してもらいます。</p>
      {jobs.length === 0 ? <p class="muted">対応が必要なものはありません。</p> : jobs.map((job) => (
        <section class="panel">
          <h2>{QUEUE_STATUS[job.status]}</h2>
          <p>資料: {job.filename || "名前のない資料"}<br />受け付け: {formatJst(job.createdAt)}<br />種類: {job.task === "connect" ? "資料から段取りを作る" : "下書きを書く"}{job.failure ? <><br />理由: {QUEUE_FAILURE[job.failure] ?? "内容を確認してください"}</> : null}</p>
          {job.failure !== "too_large" && (job.status === "failed" || (job.status === "attention" && job.projectId)) ? (
            <form method="post" action={`/ops/wards/${ward.slug}/queue/${job.jobId}/retry`}>
              <button type="submit">もう一度動かす</button>
            </form>
          ) : job.failure === "too_large" ? <p>もう一度動かしても、読めません。役員に、資料を分けて送り直してもらってください。</p> : null}
        </section>
      ))}
    </OpsPage>,
  );
});

opsRoutes.post("/wards/:slug/queue/:jobId/retry", async (c) => {
  const ward = await wardOrNull(c, c.req.param("slug"));
  if (!ward) return c.html(<WardNotFound />, 404);
  const jobId = c.req.param("jobId");
  const filename = (await listWardQueue(c.env.DB, ward.wardId)).find((item) => item.jobId === jobId)?.filename;
  const row = await c.env.DB.prepare("SELECT status, project_id, failure, via, read_kind FROM jobs WHERE ward_id = ? AND job_id = ?")
    .bind(ward.wardId, jobId).first<{ status: string; project_id: string | null; failure: string; via: string; read_kind: string }>();
  if (!row || row.failure === "too_large") return c.html(<OpsPage title="読み直せません" loggedIn><h1>読み直せません</h1><p>資料を分けて送り直してもらってください。</p><a class="quiet" href={`/ops/wards/${ward.slug}/queue`}>読み取りの状況へ戻る</a></OpsPage>, 400);
  let retried = false;
  if (row.status === "attention" && row.project_id) {
    const reset = await c.env.DB.prepare(
      `UPDATE jobs SET status = 'read', failure = '', stop_reason = '', finished_at = NULL, updated_at = ?
        WHERE ward_id = ? AND job_id = ? AND status = 'attention'`,
    ).bind(new Date().toISOString(), ward.wardId, jobId).run();
    if ((reset.meta.changes ?? 0) > 0) { retried = true; c.executionCtx.waitUntil(dispatchProject(c.env, ward.wardId, row.project_id)); }
  } else if (row.status === "failed" && row.via === "space" && row.read_kind === "general" && row.failure !== "connect") {
    retried = await readSpacePaper(c.env, c.executionCtx, ward.wardId, jobId);
  } else if (row.status === "failed") {
    retried = await retryJob(c.env, { waitUntil: (promise) => c.executionCtx.waitUntil(promise) }, ward.wardId, jobId);
  }
  return c.html(<OpsPage title={retried ? "もう一度動かしました" : "動かし直す必要はありません"} loggedIn><h1>{retried ? "もう一度動かしました" : "動かし直す必要はありません"}</h1><Notice>{retried ? `${filename || "資料"}を、もう一度読み始めました` : "この資料は、すでに処理が進んでいます。"}</Notice><p>結果は、少しあとで、読み取りの状況に出ます。役員に何かを頼む必要はありません。</p><section class="next"><strong>次は</strong><p>しばらくしてから、読み取りの状況で結果を見てください。</p><a class="button" href={`/ops/wards/${ward.slug}/queue`}>読み取りの状況へ戻る</a></section><h2>間違えたときは</h2><p>間違えて動かしたときも、困ることはありません。もう一度読み直します。</p></OpsPage>);
});

opsRoutes.route("/", lifecyclePages);

function budgetSaved(c: OpsContext, slug: string) {
  return c.html(<OpsPage title="予算を保存しました" loggedIn><h1>予算を保存しました</h1><Notice>AIの費用の上限を変えました。役員の配る操作は止まりません。</Notice><section class="next"><strong>次は</strong><p>この区の画面で、ほかの状況も見られます。</p><a class="button" href={`/ops/wards/${slug}`}>区の画面へ戻る</a></section><h2>間違えたときは</h2><p>予算の画面で、金額を直して保存できます。</p><a class="quiet" href={`/ops/wards/${slug}/budget`}>予算を直す</a></OpsPage>);
}
