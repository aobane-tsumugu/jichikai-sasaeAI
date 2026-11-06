import type { Context, MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import type { AdminEnv, WardEnv, WardInfo } from "../env";
import { newId, nowIso } from "./ids";
import { generateDeviceToken, sha256Hex } from "./password";

// 役員画面の入り方。一人ずつのアカウントでログインすると、端末に札（Cookie）を渡す。
// 札の要約を devices（端末の記憶）に置き、なくした端末は行を消して締め出す。
// 席（役の名札）は見ない。ログインしていれば役員の誰でも同じに使える（前提 11）。

export const DEVICE_COOKIE = "device";
/** 最後に使ってからこの日数を過ぎた端末の記憶は無効にする。 */
const DEVICE_VALID_DAYS = 180;
/** 最終利用の更新は、書き込みを減らすため一日に一回まで。 */
const TOUCH_AFTER_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function adminPath(ward: Pick<WardInfo, "slug">, rest = ""): string {
  return `/${ward.slug}/admin${rest}`;
}

/** ブラウザと OS の短い説明。端末の見分け用で、厳密ではない。 */
export function deviceLabel(userAgent: string | undefined): string {
  const ua = userAgent ?? "";
  const os = /iPhone|iPad/.test(ua)
    ? "iPhone/iPad"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "Mac"
          : /Linux/.test(ua)
            ? "Linux"
            : "不明な機器";
  const browser = /Edg\//.test(ua)
    ? "Edge"
    : /Firefox\//.test(ua)
      ? "Firefox"
      : /Chrome\/|CriOS\//.test(ua)
        ? "Chrome"
        : /Safari\//.test(ua)
          ? "Safari"
          : "ブラウザ";
  return `${browser} / ${os}`;
}

/** 端末の記憶を作り、札を Cookie で渡す。 */
export async function issueDevice(
  c: Context<WardEnv>,
  ward: WardInfo,
  accountId: string,
): Promise<string> {
  const token = generateDeviceToken();
  const deviceId = newId();
  await c.env.DB.prepare(
    "INSERT INTO devices (device_id, ward_id, account_id, token_hash, label, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(
      deviceId,
      ward.wardId,
      accountId,
      await sha256Hex(token),
      deviceLabel(c.req.header("user-agent")),
      nowIso(),
      nowIso(),
    )
    .run();
  await c.env.DB.prepare("UPDATE accounts SET sign_in_completed_at = COALESCE(sign_in_completed_at, ?) WHERE ward_id = ? AND account_id = ? AND removed_at IS NULL")
    .bind(nowIso(), ward.wardId, accountId).run();
  setDeviceCookie(c, ward, token);
  return deviceId;
}

function setDeviceCookie(c: Context<WardEnv>, ward: WardInfo, token: string) {
  setCookie(c, DEVICE_COOKIE, token, {
    path: adminPath(ward),
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    maxAge: DEVICE_VALID_DAYS * 24 * 60 * 60,
  });
}

export function clearDeviceCookie(c: Context, ward: WardInfo) {
  deleteCookie(c, DEVICE_COOKIE, { path: adminPath(ward) });
}

interface DeviceRow {
  device_id: string;
  last_seen_at: string;
  account_id: string;
  name: string;
  seat_id: string | null;
}

/** 役員画面の入口の検査。ログインしていなければログイン画面へ送る。 */
export const requireAdmin: MiddlewareHandler<AdminEnv> = async (c, next) => {
  const ward = c.var.ward;
  const token = getCookie(c, DEVICE_COOKIE);
  let found: DeviceRow | null = null;
  if (token) {
    found = await c.env.DB.prepare(
      `SELECT d.device_id, d.last_seen_at, a.account_id, a.name, a.seat_id
         FROM devices d
         JOIN accounts a ON a.ward_id = d.ward_id AND a.account_id = d.account_id
         JOIN wards w ON w.ward_id = d.ward_id AND w.is_active = 1
        WHERE d.ward_id = ? AND d.token_hash = ? AND a.removed_at IS NULL AND a.sign_in_required = 0`,
    )
      .bind(ward.wardId, await sha256Hex(token))
      .first<DeviceRow>();
  }
  const lastSeen = found ? Date.parse(found.last_seen_at) : NaN;
  if (!found || !(Date.now() - lastSeen < DEVICE_VALID_DAYS * DAY_MS)) {
    const here = new URL(c.req.url);
    const back = c.req.method === "GET" ? `${here.pathname}${here.search}` : adminPath(ward, "/");
    return c.redirect(`${adminPath(ward, "/login")}?next=${encodeURIComponent(back)}`, 303);
  }
  if (Date.now() - lastSeen > TOUCH_AFTER_MS) {
    await c.env.DB.prepare("UPDATE devices SET last_seen_at = ? WHERE ward_id = ? AND device_id = ?")
      .bind(nowIso(), ward.wardId, found.device_id)
      .run();
  }
  c.set("account", { accountId: found.account_id, name: found.name, seatId: found.seat_id });
  c.set("deviceId", found.device_id);
  c.header("Cache-Control", "no-store");
  c.header("X-Robots-Tag", "noindex");
  await next();
};

/** ログイン後の戻り先。区の役員画面の中だけを許す（外へ飛ばさない）。 */
export function safeNext(ward: Pick<WardInfo, "slug">, candidate: string | undefined | null): string {
  const home = adminPath(ward, "/");
  if (!candidate) return home;
  const prefix = adminPath(ward);
  if (!candidate.startsWith(`${prefix}/`) && candidate !== prefix) return home;
  if (candidate.startsWith("//") || candidate.includes("\\") || /[\r\n]/.test(candidate)) return home;
  return candidate;
}
