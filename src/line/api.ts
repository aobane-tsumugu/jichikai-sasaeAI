import type { Env } from "../env";

const LINE_API = "https://api.line.me";

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
  if (safeUrl.protocol !== "https:") throw new Error("送信先の URL は HTTPS にしてください。");
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

export function lineAccessToken(env: Pick<Env, "LINE_CHANNEL_ACCESS_TOKEN">): string {
  if (!env.LINE_CHANNEL_ACCESS_TOKEN) throw new Error("LINE の接続設定がありません。");
  return env.LINE_CHANNEL_ACCESS_TOKEN;
}
