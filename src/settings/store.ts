// 区ごとの設定の読み書き。どの束も、設定は必ずこの関数で読み書きする（ward_id を where に持つ）。
import { nowIso } from "../core/ids";
import { DEFAULT_TEMPLATES, PUBLIC_PRIVACY_NOTICE, SETTING_KEYS, parseSquads, parseTemplates, type Template } from "./keys";

const KEY_PATTERN = /^[a-z0-9_.:-]{1,64}$/;
const MAX_VALUE = 20_000;

export async function getSetting(db: D1Database, wardId: string, key: string): Promise<string | null> {
  if (key === SETTING_KEYS.privacyNotice) return PUBLIC_PRIVACY_NOTICE;
  const row = await db
    .prepare("SELECT value FROM ward_settings WHERE ward_id = ? AND key = ?")
    .bind(wardId, key)
    .first<{ value: string }>();
  return row?.value ?? null;
}

export async function setSetting(
  db: D1Database,
  wardId: string,
  key: string,
  value: string,
  accountId: string | null = null,
): Promise<void> {
  if (!KEY_PATTERN.test(key)) throw new Error("設定のキーは英小文字、数字、_ . : - の 64 文字までです");
  if (value.length > MAX_VALUE) throw new Error("設定の値が長すぎます");
  await db
    .prepare(
      `INSERT INTO ward_settings (ward_id, key, value, updated_at, updated_by_account_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (ward_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by_account_id = excluded.updated_by_account_id`,
    )
    .bind(wardId, key, value, nowIso(), accountId)
    .run();
}

export async function deleteSetting(db: D1Database, wardId: string, key: string): Promise<void> {
  await db.prepare("DELETE FROM ward_settings WHERE ward_id = ? AND key = ?").bind(wardId, key).run();
}

export async function getPublicContact(db: D1Database, wardId: string): Promise<string> {
  return (await getSetting(db, wardId, SETTING_KEYS.publicContact)) ?? "";
}

export async function getSquads(db: D1Database, wardId: string): Promise<string[]> {
  return parseSquads(await getSetting(db, wardId, SETTING_KEYS.squads));
}

/** 保存が無ければ標準の定型文。 */
export async function getTemplates(db: D1Database, wardId: string): Promise<Template[]> {
  const saved = parseTemplates(await getSetting(db, wardId, SETTING_KEYS.templates));
  return saved ?? DEFAULT_TEMPLATES.map((t) => ({ ...t }));
}

export async function saveTemplates(
  db: D1Database,
  wardId: string,
  templates: Template[],
  accountId: string | null,
): Promise<void> {
  await setSetting(db, wardId, SETTING_KEYS.templates, JSON.stringify(templates), accountId);
}
