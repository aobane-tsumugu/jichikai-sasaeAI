import { Hono, type Context } from "hono";
import { AdminPage } from "../core/admin-ui";
import { adminPath } from "../core/auth";
import { formatJst } from "../core/time";
import { Credentials, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import {
  addAccount,
  addSeat,
  listAccounts,
  listSeats,
  lockOutDevices,
  removeAccount,
  removeSeat,
  resetPassword,
  setAccountSeat,
  type AccountRow,
  type Failure,
  type SeatRow,
} from "./accounts";

// 役員の席とアカウント（足す・外す・初期化・端末の締め出し）。役員の誰でも使える。席は名札で、鍵ではない。

export const people = new Hono<AdminEnv>();

const DONE: Record<string, string> = {
  "seat-added": "席を足しました。",
  "seat-removed": "席を外しました。その席にいた人は、席なしになりました。",
  "seat-changed": "席を変えました。",
  "account-removed": "アカウントを外しました。",
  "locked-out": "端末を締め出しました。",
};

const here = (c: Context<AdminEnv>, query = "") => adminPath(c.var.ward, `/settings/people${query}`);
const done = (c: Context<AdminEnv>, code: keyof typeof DONE) => c.redirect(here(c, `?done=${code}`), 303);

interface View {
  seats: SeatRow[];
  accounts: AccountRow[];
}

const SeatSelect = (props: { seats: SeatRow[]; selected: string | null; name?: string; label: string }) => (
  <select name={props.name ?? "seatId"} aria-label={props.label}>
    <option value="" selected={props.selected === null}>
      席なし
    </option>
    {props.seats.map((s) => (
      <option value={s.seatId} selected={s.seatId === props.selected}>
        {s.title}
      </option>
    ))}
  </select>
);

const PeoplePage = (props: {
  c: Context<AdminEnv>;
  view: View;
  notice?: string;
  error?: string;
}) => {
  const { ward, account: me, deviceId } = props.c.var;
  const { seats, accounts } = props.view;
  const base = (rest: string) => adminPath(ward, `/settings/people${rest}`);
  return (
    <AdminPage ward={ward} account={me} title="役員の席とアカウント" back={{ href: adminPath(ward, "/settings"), label: "区の設定" }}>
      <h1>役員の席とアカウント</h1>
      <p class="muted">
        席は「会長」「書記」などの名札です。席があるかないかで、できることは変わりません。アカウントは一人に一つで、名前と長いパスワードで入ります。
      </p>
      {props.notice ? <Notice>{props.notice}</Notice> : null}
      {props.error ? <Notice error>{props.error}</Notice> : null}

      <h2>席</h2>
      {seats.length === 0 ? <p class="muted">席はまだありません。席は無くても使えます。</p> : null}
      {seats.map((s) => {
        const holders = accounts.filter((a) => a.seatId === s.seatId).map((a) => a.name);
        return (
          <div class="panel">
            <strong>{s.title}</strong>
            <span class="muted"> {holders.length > 0 ? holders.join("、") : "（だれもいません）"}</span>{" "}
            <form
              class="inline"
              method="post"
              action={base(`/seats/${s.seatId}/remove`)}
              onsubmit="return confirm('この席を外します。その席にいる人は席なしになります（アカウントは残ります）。')"
            >
              <button type="submit" class="secondary">
                席を外す
              </button>
            </form>
          </div>
        );
      })}
      <form method="post" action={base("/seats")} class="panel">
        <label for="seat-title">席を足す（例 会長、書記）</label>
        <input id="seat-title" name="title" type="text" required maxlength={40} />
        <p>
          <button type="submit">足す</button>
        </p>
      </form>

      <h2>アカウント</h2>
      {accounts.map((a) => {
        const mine = a.accountId === me.accountId;
        return (
          <div class="panel">
            <p>
              <strong>{a.name}</strong>
              {mine ? <span class="muted">（あなた）</span> : null}
            </p>
            <form method="post" action={base(`/accounts/${a.accountId}/seat`)} class="inline">
              <SeatSelect seats={seats} selected={a.seatId} label={`${a.name} の席`} />{" "}
              <button type="submit" class="secondary">
                席を変える
              </button>
            </form>
            <details>
              <summary>端末 {a.devices.length} 台</summary>
              {a.devices.length === 0 ? <p class="muted">ログインした端末はありません。</p> : null}
              <ul>
                {a.devices.map((d) => (
                  <li>
                    {d.label || "不明な端末"}、最後に使った日時 {formatJst(d.lastSeenAt)}{" "}
                    {d.deviceId === deviceId ? (
                      <span class="muted">（この端末）</span>
                    ) : (
                      <form
                        class="inline"
                        method="post"
                        action={base(`/accounts/${a.accountId}/devices/${d.deviceId}/lockout`)}
                        onsubmit="return confirm('この端末を締め出します。この端末では、もう一度ログインが必要になります。')"
                      >
                        <button type="submit" class="danger">
                          締め出す
                        </button>
                      </form>
                    )}
                  </li>
                ))}
              </ul>
              {a.devices.some((d) => d.deviceId !== deviceId) ? (
                <form
                  method="post"
                  action={base(`/accounts/${a.accountId}/lockout`)}
                  onsubmit="return confirm('この端末以外の、このアカウントの全部の端末を締め出します。')"
                >
                  <button type="submit" class="danger">
                    {mine ? "この端末以外を全部締め出す" : "全部の端末を締め出す"}
                  </button>
                </form>
              ) : null}
            </details>
            <div>
              <form
                class="inline"
                method="post"
                action={base(`/accounts/${a.accountId}/reset`)}
                onsubmit="return confirm('パスワードを作り直します。古いパスワードは使えなくなります。')"
              >
                <button type="submit" class="secondary">
                  初期化（パスワードを作り直す）
                </button>
              </form>{" "}
              <form
                class="inline"
                method="post"
                action={base(`/accounts/${a.accountId}/remove`)}
                onsubmit="return confirm('このアカウントを外します。この人は入れなくなります。')"
              >
                <button type="submit" class="danger">
                  外す
                </button>
              </form>
            </div>
          </div>
        );
      })}
      <form method="post" action={base("/accounts")} class="panel">
        <label for="account-name">アカウントを足す（名前）</label>
        <input id="account-name" name="name" type="text" required maxlength={40} />
        <label for="account-seat">席</label>
        <SeatSelect seats={seats} selected={null} label="席" />
        <p>
          <button type="submit">足す</button>
        </p>
        <p class="muted">足すと、パスワードが一度だけ出ます。その人に渡してください。</p>
      </form>
    </AdminPage>
  );
};

async function loadView(c: Context<AdminEnv>): Promise<View> {
  const wardId = c.var.ward.wardId;
  const [seats, accounts] = await Promise.all([listSeats(c.env.DB, wardId), listAccounts(c.env.DB, wardId)]);
  return { seats, accounts };
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

const CredentialsPage = (props: { c: Context<AdminEnv>; title: string; name: string; password: string }) => (
  <AdminPage
    ward={props.c.var.ward}
    account={props.c.var.account}
    title={props.title}
    back={{ href: adminPath(props.c.var.ward, "/settings/people"), label: "役員の席とアカウントへ戻る" }}
  >
    <h1>{props.title}</h1>
    <Credentials name={props.name} password={props.password} />
  </AdminPage>
);

people.post("/accounts", async (c) => {
  const form = await c.req.parseBody();
  const text = (key: string) => (typeof form[key] === "string" ? (form[key] as string) : "");
  const result = await addAccount(c.env.DB, c.var.ward.wardId, {
    name: text("name"),
    seatId: text("seatId") || null,
    createdBy: c.var.account.accountId,
  });
  if (!result.ok) return fail(c, result);
  c.header("Cache-Control", "no-store");
  return c.html(<CredentialsPage c={c} title="アカウントを足しました" name={result.name} password={result.password} />, 201);
});

people.post("/accounts/:accountId/reset", async (c) => {
  const accountId = c.req.param("accountId");
  const keep = accountId === c.var.account.accountId ? c.var.deviceId : undefined;
  const result = await resetPassword(c.env.DB, c.var.ward.wardId, accountId, keep);
  if (!result.ok) return showPage(c, { error: result.message }, 404);
  c.header("Cache-Control", "no-store");
  return c.html(<CredentialsPage c={c} title="パスワードを作り直しました" name={result.name} password={result.password} />);
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
