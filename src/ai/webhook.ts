// webhook の受け口（/hooks/anthropic）。Console に登録した種類を受ける（URL は 3xx を返さない。返すと止められる）。
//   session.status_idled / session.status_terminated / session.budget_reached -> その入力の events を引いて完了か要対応か失敗にする
//   session.status_rescheduled -> 一時の再試行。何もしない
//   vault_credential.refresh_failed -> 提供側への知らせ（記録に残す）
// 署名は webhook-id、webhook-timestamp、webhook-signature の三つのヘッダ。SDK の unwrap で検査する。
// 中身は薄い（種類と ID だけ）。重複は events の引き直しで決まるので別に弾かない。
import { Hono } from "hono";
import type { AppEnv } from "../env";
import { checkSession } from "./complete";
import { getClient } from "./deps";
import { recordCredentialFailure } from "../ops/ai-alert";

const SESSION_TYPES = new Set(["session.status_idled", "session.status_terminated", "session.budget_reached"]);

export interface WebhookEvent {
  type: string;
  id: string;
  data: { type: string; id: string; organization_id?: string; workspace_id?: string; vault_id?: string };
}

export const anthropicHooks = new Hono<AppEnv>();

anthropicHooks.post("/anthropic", async (c) => {
  const body = await c.req.text();
  let event: WebhookEvent;
  try {
    const headers = Object.fromEntries(c.req.raw.headers.entries());
    event = getClient(c.env).beta.webhooks.unwrap(body, { headers, key: c.env.ANTHROPIC_WEBHOOK_SIGNING_KEY }) as unknown as WebhookEvent;
  } catch {
    return c.text("invalid signature", 400);
  }
  const type = event.data?.type ?? "";
  if (SESSION_TYPES.has(type)) {
    // 速く 200 を返し、完了の処理は応答の後に動かす。止められても Cron が拾う
    c.executionCtx.waitUntil(handleSession(c.env, event.data.id));
  } else if (type === "vault_credential.refresh_failed") {
    // 保存できるまで成功を返さない。失敗時は提供元の再送で受け直す。
    try {
      if (!await recordCredentialFailure(c.env, event.data.id, event.data.vault_id)) {
        console.error("AIの鍵の更新の失敗を、区の設定に当てられませんでした");
        return c.text("credential ward not found", 503);
      }
    } catch {
      console.error("AIの鍵の更新の失敗の知らせを保存できませんでした");
      return c.text("alert not saved", 503);
    }
  }
  return c.body(null, 204);
});

async function handleSession(env: AppEnv["Bindings"], sessionId: string): Promise<void> {
  try {
    // セッションの metadata から区と入力を割り出す（D1 に session_id が入る前に届いても決まる）
    const job = await env.DB.prepare("SELECT ward_id, job_id FROM jobs WHERE session_id = ?")
      .bind(sessionId)
      .first<{ ward_id: string; job_id: string }>();
    if (job) {
      await checkSession(env, job.ward_id, job.job_id);
      return;
    }
    const session = await getClient(env).beta.sessions.retrieve(sessionId);
    const meta = (session.metadata ?? {}) as Record<string, string>;
    if (meta.ward_id && meta.job_id) {
      await env.DB.prepare("UPDATE jobs SET session_id = ? WHERE ward_id = ? AND job_id = ? AND session_id IS NULL AND status = 'connecting'")
        .bind(sessionId, meta.ward_id, meta.job_id)
        .run();
      await checkSession(env, meta.ward_id, meta.job_id);
    }
  } catch (err) {
    console.error("webhook の処理に失敗しました", err instanceof Error ? err.name : "不明な失敗");
  }
}
