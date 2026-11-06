import type { Env } from "../env";

const LINE_API = "https://api.line.me";

/** 写真が届いた場所への質問だけに使う。一斉送信の関数とは分ける。 */
export async function sendLineQuestion(token: string, input: {
  to: string; replyToken: string | null; text: string; batchId: string;
  options: Array<{ label: string; id: string }>;
  quoteToken?: string | null; camera?: boolean;
}, request: typeof fetch = fetch): Promise<string | null> {
  const message = { type: "text", text: input.text, ...(input.quoteToken ? { quoteToken: input.quoteToken } : {}), ...(input.options.length || input.camera ? { quickReply: {
    items: [...(input.camera ? [{ type: "action", action: { type: "camera", label: "撮り直す" } }] : []), ...input.options.map((option) => ({ type: "action", action: { type: "postback", label: option.label.slice(0, 20),
      displayText: option.label, data: new URLSearchParams({ clarification: option.id, answer: option.label }).toString() } }))],
  } } : {}) };
  const response = await request(`${LINE_API}/v2/bot/message/${input.replyToken ? "reply" : "push"}`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json",
      ...(!input.replyToken ? { "X-Line-Retry-Key": crypto.randomUUID() } : {}) },
    body: JSON.stringify(input.replyToken ? { replyToken: input.replyToken, messages: [message] } : { to: input.to, messages: [message] }),
  });
  if (!response.ok) throw new Error(`LINE API request failed (${response.status})`);
  const value = await response.json() as { sentMessages?: Array<{ id?: string }> };
  return value.sentMessages?.[0]?.id ?? null;
}

export class LineSendRejected extends Error {}

/** 役員が書いた返事を、問い合わせが届いた場所へ届ける。 */
export async function pushInquiryAnswer(token: string, userId: string, text: string, retryKey: string, request: typeof fetch = fetch): Promise<void> {
  const response = await request(`${LINE_API}/v2/bot/message/push`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "X-Line-Retry-Key": retryKey },
    body: JSON.stringify({ to: userId, messages: [{ type: "text", text }] }),
  });
  if (!response.ok) throw new LineSendRejected(`LINE API request failed (${response.status})`);
}

export async function replyLineText(token: string, replyToken: string, text: string, request: typeof fetch = fetch): Promise<void> {
  const response = await request(`${LINE_API}/v2/bot/message/reply`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ replyToken, messages: [{ type: "text", text }] }),
  });
  if (!response.ok) throw new Error(`LINE API request failed (${response.status})`);
}

export async function getLineMemberDisplayName(
  token: string,
  source: { type: "user" | "group" | "room"; userId?: string; groupId?: string; roomId?: string },
  request: typeof fetch = fetch,
): Promise<string | null> {
  if (!source.userId) return null;
  const path = source.type === "group" && source.groupId
    ? `/v2/bot/group/${encodeURIComponent(source.groupId)}/member/${encodeURIComponent(source.userId)}`
    : source.type === "room" && source.roomId
      ? `/v2/bot/room/${encodeURIComponent(source.roomId)}/member/${encodeURIComponent(source.userId)}`
      : `/v2/bot/profile/${encodeURIComponent(source.userId)}`;
  try {
    const profile = await lineGet<{ displayName?: string }>(path, token, request);
    return profile.displayName?.trim().slice(0, 100) || null;
  } catch {
    return null;
  }
}

export interface LineAllowance {
  friends: number | null;
  monthlyLimit: number | null;
  used: number;
  remaining: number | null;
}

async function lineGet<T>(path: string, token: string, request: typeof fetch): Promise<T> {
  const response = await request(`${LINE_API}${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) throw new Error(`LINE API request failed (${response.status})`);
  return (await response.json()) as T;
}

/** 提供側が区ごとに指定した役員グループだけを使う。受信したグループから推測しない。 */
export function officerGroupId(env: Env, wardId: string): string | null {
  return secretValue(env, `LINE_${wardId.toUpperCase().replaceAll("-", "_")}_OFFICER_GROUP_ID`);
}

/** 無料の範囲を上限にし、役員グループの人数を送信前に数える。 */
export async function officerPushAllowance(token: string, groupId: string, request: typeof fetch = fetch) {
  const [quota, consumption, group] = await Promise.all([
    lineGet<{ type: string; value?: number }>("/v2/bot/message/quota", token, request),
    lineGet<{ totalUsage: number }>("/v2/bot/message/quota/consumption", token, request),
    lineGet<{ count: number }>(`/v2/bot/group/${encodeURIComponent(groupId)}/members/count`, token, request),
  ]);
  if (!Number.isSafeInteger(consumption.totalUsage) || consumption.totalUsage < 0 || !Number.isSafeInteger(group.count) || group.count < 1) return null;
  if (quota.type === "limited" && (!Number.isSafeInteger(quota.value) || quota.value! < 0)) return null;
  return { limit: Math.min(200, quota.type === "limited" ? quota.value! : 200), used: consumption.totalUsage, recipients: group.count };
}

/** 一つの役員グループへのPush。問い合わせの本文は呼び出し側で含めない。 */
export async function pushOfficerDigest(token: string, groupId: string, text: string, retryKey: string, request: typeof fetch = fetch): Promise<void> {
  const response = await request(`${LINE_API}/v2/bot/message/push`, {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", "X-Line-Retry-Key": retryKey },
    body: JSON.stringify({ to: groupId, messages: [{ type: "text", text }] }),
  });
  if (!response.ok) throw new Error(`LINE API request failed (${response.status})`);
}

/** LINE 側の友だち数と月の一斉送信枠を読む。友だちの一覧は取得しない。 */
export async function getLineAllowance(
  token: string,
  request: typeof fetch = fetch,
  now = new Date(),
): Promise<LineAllowance> {
  const day = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now).replaceAll("-", "");
  const [followers, quota, consumption] = await Promise.all([
    lineGet<{ status: string; followers: number | null }>(`/v2/bot/insight/followers?date=${day}`, token, request),
    lineGet<{ type: string; value: number }>("/v2/bot/message/quota", token, request),
    lineGet<{ totalUsage: number }>("/v2/bot/message/quota/consumption", token, request),
  ]);
  const monthlyLimit = quota.type === "limited" ? quota.value ?? null : null;
  return {
    friends: followers.status === "ready" ? followers.followers : null,
    monthlyLimit,
    used: consumption.totalUsage,
    remaining: monthlyLimit === null ? null : Math.max(0, monthlyLimit - consumption.totalUsage),
  };
}

/** 題と URL だけを公式 LINE の友だち全員へ送る。受信者一覧は扱わない。 */
export async function sendLineTitleAndUrl(
  token: string,
  title: string,
  url: string,
  request: typeof fetch = fetch,
): Promise<void> {
  const safeUrl = new URL(url);
  if (safeUrl.protocol !== "https:") throw new Error("送信先のURLはHTTPSにしてください。");
  const response = await request(`${LINE_API}/v2/bot/message/broadcast`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      messages: [{ type: "text", text: `${title}\n${safeUrl.toString()}` }],
    }),
  });
  if (!response.ok) throw new Error(`LINE API request failed (${response.status})`);
}

/** 市の通知など、役員が内容を整えてから届ける文を公式 LINE で一斉送信する。 */
export async function broadcastLineText(token: string, text: string, request: typeof fetch = fetch): Promise<void> {
  const message = text.trim();
  if (!message || message.length > 5000) throw new Error("送る文を確かめてください。");
  const response = await request(`${LINE_API}/v2/bot/message/broadcast`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ type: "text", text: message }] }),
  });
  if (!response.ok) throw new Error(`LINE API request failed (${response.status})`);
}

export const LINE_NOT_CONFIGURED = "この区の公式LINEは接続設定がないため送信しません。";

/** 開設時に参照先の名前だけを決め、鍵の値は Workers secrets に置く。 */
export function lineSecretNames(wardId: string) {
  const name = wardId.toUpperCase().replaceAll("-", "_");
  return {
    channelSecretBinding: `LINE_${name}_CHANNEL_SECRET`,
    accessTokenBinding: `LINE_${name}_CHANNEL_ACCESS_TOKEN`,
  } as const;
}

function secretValue(env: Env, name: string | null): string | null {
  if (!name || !/^LINE_[A-Z0-9_]+$/.test(name)) return null;
  const value = env[name as `LINE_${string}`];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export async function lineChannelCredentials(env: Env, wardId: string, destination?: string) {
  const statement = env.DB.prepare(`SELECT channel_secret_binding, access_token_binding FROM line_channels
    WHERE ward_id = ? ${destination === undefined ? "" : "AND destination = ?"} ORDER BY created_at, destination LIMIT 1`);
  const bindings = destination === undefined ? [wardId] : [wardId, destination];
  const row = await statement.bind(...bindings).first<{ channel_secret_binding: string | null; access_token_binding: string | null }>();
  return row ? {
    channelSecret: secretValue(env, row.channel_secret_binding),
    accessToken: secretValue(env, row.access_token_binding),
  } : null;
}

export async function lineAccessToken(env: Env, wardId: string): Promise<string | null> {
  return (await lineChannelCredentials(env, wardId))?.accessToken ?? null;
}
