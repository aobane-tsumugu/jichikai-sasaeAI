// 運用の画面（提供側）のログイン。提供側は一つの ID とパスワード（Workers の secrets の OPS_ID と OPS_PASSWORD）。
// 状態を D1 に持たないため、ログインの札は署名付きの有効期限にする。署名の鍵は ID とパスワードから作るので、
// パスワードを変えると出回っている札は全部無効になる。
import type { Env } from "../env";
import { safeEqual } from "../core/password";

export const OPS_COOKIE = "ops_session";
export const OPS_SESSION_HOURS = 12;

const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array | null {
  if (!/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
  return Uint8Array.from(hex.match(/../g) ?? [], (h) => parseInt(h, 16));
}

async function digest(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text)));
}

/** 運用の画面が使えるか（OPS_ID と OPS_PASSWORD の両方が入っている）。 */
export function opsConfigured(env: Pick<Env, "OPS_ID" | "OPS_PASSWORD">): env is { OPS_ID: string; OPS_PASSWORD: string } & typeof env {
  return Boolean(env.OPS_ID && env.OPS_PASSWORD);
}

/** ID とパスワードの照合。どちらが違っても同じだけ計算し、時間差で漏らさない。 */
export async function checkOpsLogin(
  env: Pick<Env, "OPS_ID" | "OPS_PASSWORD">,
  id: string,
  password: string,
): Promise<boolean> {
  if (!opsConfigured(env)) return false;
  const [idOk, passwordOk] = await Promise.all([
    digest(id).then((a) => digest(env.OPS_ID).then((b) => safeEqual(toHex(a), toHex(b)))),
    digest(password).then((a) => digest(env.OPS_PASSWORD).then((b) => safeEqual(toHex(a), toHex(b)))),
  ]);
  return idOk && passwordOk;
}

async function sessionKey(env: { OPS_ID: string; OPS_PASSWORD: string }): Promise<CryptoKey> {
  const material = await digest(`ops-session:${env.OPS_ID}:${env.OPS_PASSWORD}`);
  return crypto.subtle.importKey("raw", material, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

/** ログインの札: <有効期限 ms>.<署名> */
export async function createOpsSession(env: Pick<Env, "OPS_ID" | "OPS_PASSWORD">, now = Date.now()): Promise<string> {
  if (!opsConfigured(env)) throw new Error("運用の画面は設定されていません");
  const expires = String(now + OPS_SESSION_HOURS * 60 * 60 * 1000);
  const mac = await crypto.subtle.sign("HMAC", await sessionKey(env), encoder.encode(expires));
  return `${expires}.${toHex(new Uint8Array(mac))}`;
}

export async function verifyOpsSession(
  env: Pick<Env, "OPS_ID" | "OPS_PASSWORD">,
  cookie: string | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (!cookie || !opsConfigured(env)) return false;
  const [expires, mac] = cookie.split(".");
  if (!expires || !mac || !/^[0-9]+$/.test(expires) || Number(expires) < now) return false;
  const signature = fromHex(mac);
  if (!signature) return false;
  return crypto.subtle.verify("HMAC", await sessionKey(env), signature, encoder.encode(expires));
}
