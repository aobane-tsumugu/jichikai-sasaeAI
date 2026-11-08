import { publishedItem } from "../answers/resident";
import { getPublicContact } from "../settings/store";

/**
 * 住民に見せる連絡先。自治会の連絡先がまだ入っていない時は、今出ている案内に書いた連絡先で補う。
 * 加入していない人や越してきたばかりの人は、班長も役員も知らないため（点検 C5、前提 21）。
 * 住民向けのページと、役員のトップの知らせで同じものを使う（トップが住民向けのページと違うことを言わないように）。
 */
export async function wardContact(db: D1Database, wardId: string): Promise<string> {
  const saved = await getPublicContact(db, wardId);
  if (saved) return saved;
  const rows = await db.prepare(`SELECT v.body FROM publication_records r JOIN document_versions v ON v.ward_id = r.ward_id AND v.version_id = r.version_id
    WHERE r.ward_id = ? AND r.unpublished_at IS NULL AND v.scope = 'public' ORDER BY r.published_at DESC LIMIT 20`).bind(wardId).all<{ body: string }>();
  return rows.results.map((row) => publishedItem(row.body, "public_contact")).find(Boolean) ?? "";
}
