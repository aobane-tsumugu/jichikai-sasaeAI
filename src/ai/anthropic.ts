// Anthropic への入口。API キーは使わない。署名鍵（ES256 の秘密の JWK）で JWT を作り、
// /v1/oauth/token で 10 分のトークンに換えて、Bearer で使う（公式の Workload Identity Federation）。
// 鍵、JWT、トークンは記録にも D1 にも出さない。モジュールの中に持つのはトークンと有効期限だけ。
import Anthropic from "@anthropic-ai/sdk";
import type { Env } from "../env";

/** 製品で使うモデル。claude-opus-5-5 は置かない（CLAUDE.md）。 */
export const MODEL = {
  /** 読む、回答票、復元、繋げる、下書き、報告、地図の下書き */
  main: "claude-sonnet-5-5",
  /** 当てる（候補の ID から選ぶだけ） */
  light: "claude-haiku-5-5",
} as const;

const ISSUER = "https://issuer.jichikai-sasae.invalid";
const SUBJECT = "jichikai-sasae-worker";
const AUDIENCE = "https://api.anthropic.com";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:jwt-bearer";
/** jwt-bearer の交換に付ける。refresh_token の交換には付けない（SDK の lib/credentials/types.d.ts）。 */
const FEDERATION_BETA = "oidc-federation-2026-04-01";
const JWT_LIFETIME_SECONDS = 300;
/** 切れる前に取り直す余裕 */
const REFRESH_MARGIN_MS = 60_000;

export class AnthropicAuthError extends Error {
  constructor(
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "AnthropicAuthError";
  }
}

export function base64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (let i = 0; i < view.length; i += 0x8000) {
    binary += String.fromCharCode(...view.subarray(i, i + 0x8000));
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

interface SigningKey {
  key: CryptoKey;
  kid: string;
}

let signingKeyCache: { raw: string; value: SigningKey } | null = null;

/** ANTHROPIC_FEDERATION_SIGNING_KEY（秘密の JWK の JSON を base64url にした物）を読む。 */
export async function loadSigningKey(raw: string): Promise<SigningKey> {
  if (signingKeyCache?.raw === raw) return signingKeyCache.value;
  let jwk: JsonWebKey & { kid?: string };
  try {
    jwk = JSON.parse(new TextDecoder().decode(base64urlDecode(raw.trim()))) as JsonWebKey & { kid?: string };
  } catch {
    throw new AnthropicAuthError("署名鍵を読めません（base64url の JWK の JSON ではありません）");
  }
  if (jwk.kty !== "EC" || jwk.crv !== "P-256" || !jwk.d || !jwk.kid) {
    throw new AnthropicAuthError("署名鍵は kid を持つ ES256（P-256）の秘密の JWK にしてください");
  }
  const key = await crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const value = { key, kid: jwk.kid };
  signingKeyCache = { raw, value };
  return value;
}

/** ES256 の JWT を作る。WebCrypto の ECDSA の署名は r||s の 64 バイトで、そのまま JWS の形。 */
export async function signFederationJwt(rawSigningKey: string, nowMs: number = Date.now()): Promise<string> {
  const { key, kid } = await loadSigningKey(rawSigningKey);
  const iat = Math.floor(nowMs / 1000);
  const enc = new TextEncoder();
  const header = base64urlEncode(enc.encode(JSON.stringify({ alg: "ES256", typ: "JWT", kid })));
  const payload = base64urlEncode(
    enc.encode(
      JSON.stringify({
        iss: ISSUER,
        sub: SUBJECT,
        aud: AUDIENCE,
        iat,
        exp: iat + JWT_LIFETIME_SECONDS,
        jti: crypto.randomUUID(),
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(signingInput));
  return `${signingInput}.${base64urlEncode(signature)}`;
}

export interface AccessToken {
  token: string;
  /** Unix 秒。SDK の AccessToken と同じ。 */
  expiresAt: number;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** JWT をトークンに換える。応答の本文は、鍵や assertion を含まない種類だけを例外に出す。 */
export async function exchangeFederationToken(
  env: Pick<
    Env,
    | "ANTHROPIC_FEDERATION_SIGNING_KEY"
    | "ANTHROPIC_FEDERATION_RULE_ID"
    | "ANTHROPIC_ORGANIZATION_ID"
    | "ANTHROPIC_SERVICE_ACCOUNT_ID"
    | "ANTHROPIC_WORKSPACE_ID"
  >,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  nowMs: number = Date.now(),
): Promise<AccessToken> {
  const assertion = await signFederationJwt(env.ANTHROPIC_FEDERATION_SIGNING_KEY, nowMs);
  const res = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/json", "anthropic-beta": FEDERATION_BETA },
    body: JSON.stringify({
      grant_type: GRANT_TYPE,
      assertion,
      federation_rule_id: env.ANTHROPIC_FEDERATION_RULE_ID,
      organization_id: env.ANTHROPIC_ORGANIZATION_ID,
      service_account_id: env.ANTHROPIC_SERVICE_ACCOUNT_ID,
      workspace_id: env.ANTHROPIC_WORKSPACE_ID,
    }),
  });
  let body: { access_token?: unknown; expires_in?: unknown; error?: unknown; error_description?: unknown } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    // 本文が JSON でない時は、状態の番号だけで失敗にする
  }
  if (!res.ok) {
    const kind = typeof body.error === "string" ? body.error.slice(0, 80) : "unknown";
    throw new AnthropicAuthError(`トークンの交換に失敗しました（${res.status} ${kind}）`, res.status);
  }
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new AnthropicAuthError("トークンの交換の応答に access_token がありません", res.status);
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : 600;
  return { token: body.access_token, expiresAt: Math.floor(nowMs / 1000) + expiresIn };
}

let tokenCache: { token: AccessToken; keyRaw: string } | null = null;
let tokenInFlight: Promise<AccessToken> | null = null;

/** 有効なトークンを返す。切れる 1 分前に取り直す。同時の要求は一度の交換にまとめる。 */
export async function getAccessToken(
  env: Parameters<typeof exchangeFederationToken>[0],
  options: { fetchImpl?: FetchLike; nowMs?: number; forceRefresh?: boolean } = {},
): Promise<AccessToken> {
  const nowMs = options.nowMs ?? Date.now();
  const keyRaw = env.ANTHROPIC_FEDERATION_SIGNING_KEY;
  if (
    !options.forceRefresh &&
    tokenCache &&
    tokenCache.keyRaw === keyRaw &&
    tokenCache.token.expiresAt * 1000 - nowMs > REFRESH_MARGIN_MS
  ) {
    return tokenCache.token;
  }
  if (tokenInFlight) return tokenInFlight;
  tokenInFlight = exchangeFederationToken(env, options.fetchImpl, nowMs)
    .then((token) => {
      tokenCache = { token, keyRaw };
      return token;
    })
    .finally(() => {
      tokenInFlight = null;
    });
  return tokenInFlight;
}

/** 試験用。キャッシュを空にする。 */
export function resetAnthropicAuthCache(): void {
  tokenCache = null;
  tokenInFlight = null;
  signingKeyCache = null;
}

export interface ClientOptions {
  maxRetries?: number;
  timeoutMs?: number;
}

/**
 * Anthropic のクライアント。credentials に渡した関数が、要求ごとに有効なトークンを返す（期限が近ければ取り直す）。
 * この形だと SDK が anthropic-beta: oauth-2025-04-20 を自分で付ける。authToken を直に渡す形では付かない。
 */
export function createAnthropic(
  env: Parameters<typeof exchangeFederationToken>[0],
  options: ClientOptions = {},
): Anthropic {
  return new Anthropic({
    credentials: (opts) => getAccessToken(env, { forceRefresh: opts?.forceRefresh }),
    maxRetries: options.maxRetries ?? 1,
    timeout: options.timeoutMs ?? 5 * 60_000,
  });
}
