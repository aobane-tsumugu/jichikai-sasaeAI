import { Hono, type Context } from "hono";
import { AdminPage } from "../core/admin-ui";
import { adminPath } from "../core/auth";
import { formatJst } from "../core/time";
import { Notice } from "../core/ui";
import { createInvitation, createInvitedAccount } from "../core/sign-in";
import { renderSVG } from "uqr";
import type { AdminEnv } from "../env";
import {
  addSeat,
  listAccounts,
  listSeats,
  lockOutDevices,
  removeAccount,
  removeSeat,
  setAccountSeat,
  setAccountLoginId,
  type AccountRow,
  type Failure,
  type SeatRow,
} from "./accounts";

// 役員の席とアカウント（足す・外す・初期化・端末の締め出し）。役員の誰でも使える。席は名札で、鍵ではない。

export const people = new Hono<AdminEnv>();

const DONE: Record<string, string> = {
  "seat-added": "役職を足しました。",
  "seat-removed": "役職を外しました。その役職にいた人は、役職なしになりました。",
  "seat-changed": "役職を変えました。",
  "account-removed": "役員を外しました。",
  "login-id-changed": "IDを変更しました。",
  "locked-out": "この端末で入れないようにしました。",
};

const here = (c: Context<AdminEnv>, query = "") => adminPath(c.var.ward, `/settings/people${query}`);
const done = (c: Context<AdminEnv>, code: keyof typeof DONE) => c.redirect(here(c, `?done=${code}`), 303);

interface View {
  seats: SeatRow[];
  accounts: AccountRow[];
  entered: Set<string>;
  resets: { name: string; actor: string; created_at: string; purpose: string; created_by_provider: number }[];
}

const SeatSelect = (props: { seats: SeatRow[]; selected: string | null; name?: string; label: string }) => (
  <fieldset><legend>{props.label}</legend><div class="choice half">
    <label><input type="radio" name={props.name ?? "seatId"} value="" checked={props.selected === null} />役職なし</label>
    {props.seats.map((seat) => <label><input type="radio" name={props.name ?? "seatId"} value={seat.seatId} checked={seat.seatId === props.selected} />{seat.title}</label>)}
  </div></fieldset>
);

const PeoplePage = (props: { c: Context<AdminEnv>; view: View; notice?: string; error?: string }) => {
  const { ward, account: me, deviceId } = props.c.var;
  const { seats, accounts, entered, resets } = props.view;
  const base = (rest: string) => adminPath(ward, `/settings/people${rest}`);
  // 下の層から来た誤りの文も、この画面の言葉にそろえる。
  const words = (value: string) => value.replaceAll("アカウント", "役員").replaceAll("席", "役職").replaceAll("締め出", "入れないように");
  return <AdminPage ward={ward} account={me} title="役員の一覧" back={{ href: adminPath(ward, "/settings"), label: "区の設定へ" }}>
    <h1>役員の一覧</h1><p class="lead">役員を足したり、入れなくなった人にリンクを出したりします。役職があるかないかで、できることは変わりません。</p>
    {props.notice ? <><Notice>{words(props.notice)}</Notice><section class="next"><strong>次は</strong><p>ほかに直すものがなければ、最初の画面へ戻ってください。</p><a class="button" href={adminPath(ward, "/")}>最初の画面へ</a></section><p>間違えたときは、この画面でもう一度直せます。外した役員や役職は、下の欄から足せます。</p></> : null}
    {props.error ? <Notice error>{words(props.error)}入力した内容を確かめて、もう一度操作してください。</Notice> : null}
    <div class="action-links"><a class="button" href="#add">役員を足す</a></div>
    <h2>役員（{accounts.length}人）</h2>
    {accounts.map((a) => { const mine = a.accountId === me.accountId; return <section class="panel">
      <h3>{a.name}{mine ? "（あなた）" : ""}</h3><p class="muted">{seats.find((seat) => seat.seatId === a.seatId)?.title ?? "役職なし"}　ID {a.loginId}　{entered.has(a.accountId) ? `スマホやパソコン ${a.devices.length}台` : "まだ入っていません"}</p>
      <details class="fold"><summary>この人の設定を直す</summary><div>
        <h3>IDと役職</h3><form method="post" action={base(`/accounts/${a.accountId}/login-id`)}>
          <label for={`login-id-${a.accountId}`}>ID</label><input id={`login-id-${a.accountId}`} name="loginId" type="text" required maxlength={40} value={a.loginId} autocapitalize="none" spellcheck={false} /><p class="help-text">半角の英数字で入れてください。前後の空白は取り除きます。</p><button class="secondary">IDを変える</button>
        </form>
        <form method="post" action={base(`/accounts/${a.accountId}/seat`)}><SeatSelect seats={seats} selected={a.seatId} label="役職" /><button class="secondary">役職を変える</button></form>
        <h3>スマホやパソコン（{a.devices.length}台）</h3>
        {a.devices.length === 0 ? <p class="muted">入ったことのあるスマホやパソコンはありません。</p> : null}
        {a.devices.map((d) => <section><p><b>{d.label || "名前の分からないスマホやパソコン"}</b>　最後に使った日 {formatJst(d.lastSeenAt)}{d.deviceId === deviceId ? "（いま使っているスマホやパソコン）" : ""}</p>
          {d.deviceId !== deviceId ? <form method="post" action={base(`/accounts/${a.accountId}/devices/${d.deviceId}/lockout`)}><button class="secondary">このスマホやパソコンを入れないようにする</button></form> : null}</section>)}
        {a.devices.some((d) => d.deviceId !== deviceId) ? <form method="post" action={base(`/accounts/${a.accountId}/lockout`)}><button class="secondary">{mine ? "いま使っているスマホやパソコン以外を、全部入れないようにする" : "この役員のスマホやパソコンを全部入れないようにする"}</button></form> : null}
        <p class="muted">入れなくなったスマホやパソコンでも、もう一度、その人の入り方で入れば入れます。</p>
        <h3>入り方</h3>
        <p>入れなくなったときは、本人に渡すリンクを出します。前のリンクとパスワードは使えなくなります。LINEとメールのつなぎ、覚えたスマホやパソコンはそのままです。</p>
        <form method="post" action={base(`/accounts/${a.accountId}/reset`)}><button class="secondary">入るためのリンクを出す</button></form>
        <h3>役員から外す</h3><p>この人は入れなくなり、使っているスマホやパソコンからも出されます。同じ人をもう一度足すと、新しいリンクを渡します。最後の一人は外せません。</p>
        <form method="post" action={base(`/accounts/${a.accountId}/remove`)}><button class="secondary">役員から外す</button></form>
      </div></details>
    </section>; })}
    {resets.length ? <details class="fold"><summary>リンクを出した記録</summary><div>{resets.map((r) => <p>{formatJst(r.created_at)}　{r.created_by_provider ? "SasaeAI" : r.actor}が、{r.name}さんのリンクを出しました。</p>)}</div></details> : null}
    <h2 id="add">役員を足す</h2><form method="post" action={base("/accounts")}>
      <label for="account-name">お名前</label><input id="account-name" name="name" type="text" required maxlength={40} /><p class="help-text">IDは自動で作ります。足すと、入るためのリンクが出ます。その人に渡してください。</p>
      <SeatSelect seats={seats} selected={null} label="役職（なくてもかまいません）" /><div class="action-links"><button class="secondary">この内容で役員を足す</button></div>
    </form>
    <details class="fold"><summary>役職を足す、外す</summary><div>
      <p>役職は「会長」「書記」のような名札です。なくても使えます。外すと、その役職の人は役職なしになります。役員としては残ります。</p>
      {seats.map((seat) => <section><p><b>{seat.title}</b>　{accounts.filter((a) => a.seatId === seat.seatId).map((a) => a.name).join("、") || "だれもいません"}</p><form method="post" action={base(`/seats/${seat.seatId}/remove`)}><button class="secondary">この役職を外す</button></form></section>)}
      <form method="post" action={base("/seats")}><label for="seat-title">足す役職の名前（例 会長、書記）</label><input id="seat-title" name="title" required maxlength={40} /><button class="secondary">役職を足す</button></form>
    </div></details>
  </AdminPage>;
};

async function loadView(c: Context<AdminEnv>): Promise<View> {
  const wardId = c.var.ward.wardId;
  const [seats, accounts] = await Promise.all([listSeats(c.env.DB, wardId), listAccounts(c.env.DB, wardId)]);
  const [completed, records] = await Promise.all([
    c.env.DB.prepare("SELECT account_id FROM accounts WHERE ward_id = ? AND removed_at IS NULL AND sign_in_completed_at IS NOT NULL")
      .bind(wardId).all<{ account_id: string }>(),
    c.env.DB.prepare(`SELECT a.name, COALESCE(actor.name, '役員') AS actor, l.created_at, l.purpose, l.created_by_provider
      FROM sign_in_links l JOIN accounts a ON a.ward_id = l.ward_id AND a.account_id = l.account_id
      LEFT JOIN accounts actor ON actor.ward_id = l.ward_id AND actor.account_id = l.created_by_account_id
      WHERE l.ward_id = ? AND l.purpose IN ('invite', 'reset')
      ORDER BY l.created_at DESC`).bind(wardId)
      .all<View["resets"][number]>(),
  ]);
  return { seats, accounts, entered: new Set(completed.results.map((r) => r.account_id)), resets: records.results };
}

async function showPage(c: Context<AdminEnv>, extra: { notice?: string; error?: string } = {}, status: 200 | 400 | 404 = 200) {
  const view = await loadView(c);
  c.header("Cache-Control", "no-store");
  return c.html(<PeoplePage c={c} view={view} {...extra} />, status);
}

const fail = (c: Context<AdminEnv>, f: Failure) => showPage(c, { error: f.message }, 400);

async function formText(c: Context<AdminEnv>, key: string): Promise<string> {
  const form = await c.req.parseBody();
  const value = form[key];
  return typeof value === "string" ? value : "";
}

people.get("/", (c) => {
  const code = c.req.query("done");
  return showPage(c, code && code in DONE ? { notice: DONE[code] } : {});
});

people.post("/seats", async (c) => {
  const result = await addSeat(c.env.DB, c.var.ward.wardId, await formText(c, "title"));
  return result.ok ? done(c, "seat-added") : fail(c, result);
});

people.post("/seats/:seatId/remove", async (c) => {
  const result = await removeSeat(c.env.DB, c.var.ward.wardId, c.req.param("seatId"));
  return result.ok ? done(c, "seat-removed") : fail(c, result);
});

const InvitationPage = (props: { c: Context<AdminEnv>; title: string; name: string; token: string; reset: boolean }) => {
  const link = new URL(adminPath(props.c.var.ward, `/invite/${props.token}`), props.c.req.url).href;
  return (
  <AdminPage
    ward={props.c.var.ward}
    account={props.c.var.account}
    title={props.title}
    back={{ href: adminPath(props.c.var.ward, "/settings/people"), label: "役員の一覧へ戻る" }}
  >
    <h1>{props.title}</h1><Notice>{props.reset ? `${props.name}さんの前のリンクとパスワードは使えなくなりました。LINEとメールのつなぎ、覚えたスマホやパソコンはそのままです。役員の一覧に記録しました。` : `${props.name}さんに渡すリンクを作りました。`}</Notice>
    <section class="panel"><p>{props.name}さんに、このリンクを渡してください。開くと、本人が入り方を選べます。一度だけ、7日のあいだ使えます。</p>
      <p class="secret invite-link">{link}</p><div class="invite-qr" role="img" aria-label="リンクを開くQRコード" dangerouslySetInnerHTML={{ __html: renderSVG(link, { ecc: "M", border: 4 }) }} /></section>
    <section class="next"><strong>次は</strong><p>リンクを渡してください。その場でスマホに見せるときは、QRコードを読んでもらいます。</p></section>
    <h2>閉じてしまったときは</h2><p>役員の一覧から、もう一度リンクを出せます。</p>
    <a class="button secondary" href={adminPath(props.c.var.ward, "/settings/people")}>渡し終えたので役員の一覧へ</a>
  </AdminPage>
); };

people.post("/accounts", async (c) => {
  const form = await c.req.parseBody();
  const text = (key: string) => (typeof form[key] === "string" ? (form[key] as string) : "");
  const result = await createInvitedAccount(c.env.DB, c.var.ward.wardId, {
    name: text("name"),
    seatId: text("seatId") || null,
    createdBy: c.var.account.accountId,
  });
  if (!result.ok) return fail(c, result);
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  return c.html(<InvitationPage c={c} title="役員を足しました" name={result.name} token={result.token} reset={false} />, 201);
});

people.post("/accounts/:accountId/reset", async (c) => {
  const accountId = c.req.param("accountId");
  const result = await createInvitation(c.env.DB, c.var.ward.wardId, accountId, { accountId: c.var.account.accountId });
  if (!result.ok) return showPage(c, { error: result.message }, 404);
  c.header("Cache-Control", "no-store");
  c.header("Referrer-Policy", "no-referrer");
  return c.html(<InvitationPage c={c} title="入るためのリンクを出しました" name={result.name} token={result.token} reset={result.reset} />);
});

people.post("/accounts/:accountId/login-id", async (c) => {
  const result = await setAccountLoginId(
    c.env.DB,
    c.var.ward.wardId,
    c.req.param("accountId"),
    await formText(c, "loginId"),
  );
  if (!result.ok) return fail(c, result);
  return done(c, "login-id-changed");
});

people.post("/accounts/:accountId/remove", async (c) => {
  const result = await removeAccount(c.env.DB, c.var.ward.wardId, c.req.param("accountId"), c.var.account.accountId);
  return result.ok ? done(c, "account-removed") : fail(c, result);
});

people.post("/accounts/:accountId/seat", async (c) => {
  const seatId = (await formText(c, "seatId")) || null;
  const result = await setAccountSeat(c.env.DB, c.var.ward.wardId, c.req.param("accountId"), seatId);
  return result.ok ? done(c, "seat-changed") : fail(c, result);
});

// このアカウントの全部の端末を締め出す。自分のアカウントでは、いま使っている端末を残す。
people.post("/accounts/:accountId/lockout", async (c) => {
  const accountId = c.req.param("accountId");
  const exceptDeviceId = accountId === c.var.account.accountId ? c.var.deviceId : undefined;
  await lockOutDevices(c.env.DB, c.var.ward.wardId, accountId, { exceptDeviceId });
  return done(c, "locked-out");
});

people.post("/accounts/:accountId/devices/:deviceId/lockout", async (c) => {
  await lockOutDevices(c.env.DB, c.var.ward.wardId, c.req.param("accountId"), { deviceId: c.req.param("deviceId") });
  return done(c, "locked-out");
});
