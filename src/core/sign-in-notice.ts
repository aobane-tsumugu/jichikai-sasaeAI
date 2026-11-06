import type { Env, WardInfo } from "../env";
import { lineAccessToken, officerGroupId, officerPushAllowance, pushInquiryAnswer } from "../line/api";
import { adminPath } from "./auth";
import { nowIso } from "./ids";

/** 再発行したことだけを指定の役員グループへ知らせる。入口や資格情報は含めない。 */
export async function notifySignInReset(env: Env, ward: WardInfo, reset: { linkId: string; name: string }, origin: string,
  request: typeof fetch = fetch): Promise<"sent" | "unavailable" | "failed"> {
  const group = officerGroupId(env, ward.wardId);
  if (!group) return "unavailable";
  try {
    const token = await lineAccessToken(env, ward.wardId);
    if (!token) throw new Error("送信の設定がありません");
    const allowance = await officerPushAllowance(token, group, request);
    if (!allowance || allowance.used + allowance.recipients > allowance.limit) throw new Error("送れる通数を確かめられません");
    const url = new URL(adminPath(ward, "/settings/people"), origin).href;
    await pushInquiryAnswer(token, group, `${reset.name}さんの入り方を作り直しました。前の入り方と、覚えたスマホやパソコンは使えなくなりました。\n役員の一覧で確かめられます。\n${url}`, reset.linkId, request);
    await env.DB.prepare("UPDATE sign_in_links SET notified_at = ?, notification_error = NULL WHERE ward_id = ? AND link_id = ?")
      .bind(nowIso(), ward.wardId, reset.linkId).run();
    return "sent";
  } catch {
    await env.DB.prepare("UPDATE sign_in_links SET notification_error = ? WHERE ward_id = ? AND link_id = ?")
      .bind("役員グループへ知らせられませんでした。本人に連絡してください。", ward.wardId, reset.linkId).run();
    return "failed";
  }
}
