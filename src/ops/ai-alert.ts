import type { Env } from "../env";
import { nowIso } from "../core/ids";
import { listWards } from "./wards";

export const AI_CREDENTIAL_ALERT = "ai.vault_credential.refresh_failed";
export const AI_CREDENTIAL_MESSAGE = "AIにつなぐ鍵の更新に失敗しました。鍵の設定を確かめてください。";

/** 署名済みの知らせのIDを区の接続と照合する。鍵や受け取った本文は保存しない。 */
export async function recordCredentialFailure(env: Env, credentialId: string, vaultId?: string): Promise<boolean> {
  if (!credentialId) return false;
  let matched = false;
  for (const ward of await listWards(env.DB)) {
    const ai = await env.DB.prepare("SELECT vault_id FROM ward_ai WHERE ward_id = ? AND credential_id = ?")
      .bind(ward.wardId, credentialId).first<{ vault_id: string | null }>();
    if (!ai || (vaultId !== undefined && ai.vault_id !== vaultId)) continue;
    await env.DB.prepare(`INSERT INTO ward_settings (ward_id, key, value, updated_at)
      VALUES (?, ?, ?, ?) ON CONFLICT (ward_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
      .bind(ward.wardId, AI_CREDENTIAL_ALERT, AI_CREDENTIAL_MESSAGE, nowIso()).run();
    matched = true;
  }
  return matched;
}
