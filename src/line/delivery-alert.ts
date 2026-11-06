import { deleteSetting, setSetting } from "../settings/store";

/** OpsAlertsへ渡す知らせ。本文や送り先のIDは含めない。 */
export async function deliveryAlert(db: D1Database, wardId: string, kind: "reply" | "publish" | "digest", message: string | null): Promise<void> {
  const key = `line.delivery_alert.${kind}`;
  if (message) await setSetting(db, wardId, key, message);
  else await deleteSetting(db, wardId, key);
}
