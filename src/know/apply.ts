// AI が読んだ内容を、役員が知っておくことと一年の地図へ入れる。役員が書いた文は上書きしない。
import type { KnowTopic, ReadingBody, WardFact, YearEntry } from "../ai/schema";
import { newId, nowIso } from "../core/ids";

const MAX_BODY = 4000;

async function applyFact(db: D1Database, wardId: string, topic: KnowTopic, facts: WardFact[]): Promise<void> {
  const text = [...new Set(facts.map((fact) => fact.text.trim()).filter(Boolean))].join("\n");
  if (!text) return;
  const row = await db.prepare("SELECT body, reviewed_at, removed_at FROM ward_know_items WHERE ward_id = ? AND item_id = ?")
    .bind(wardId, topic).first<{ body: string; reviewed_at: string | null; removed_at: string | null }>();
  // 外した項目は、この区にない項目なので入れない。
  if (row?.removed_at) return;
  const now = nowIso();
  const originalId = facts[0]!.original_id;
  if (!row?.body.trim()) {
    await db.prepare(`INSERT INTO ward_know_items (ward_id, item_id, body, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (ward_id, item_id) DO UPDATE SET body = excluded.body, reviewed_at = NULL, updated_at = excluded.updated_at`)
      .bind(wardId, topic, text.slice(0, MAX_BODY), now).run();
  } else if (row.reviewed_at === null) {
    // AI が入れたまま人が触っていない項目には、新しい紙の内容を足す。
    if (!row.body.includes(text)) await db.prepare("UPDATE ward_know_items SET body = ?, updated_at = ? WHERE ward_id = ? AND item_id = ?")
      .bind(`${row.body}\n${text}`.slice(0, MAX_BODY), now, wardId, topic).run();
  } else if (!row.body.includes(text)) {
    // 役員が書いた文と違う時は上書きせず、質問にする。
    await db.prepare("UPDATE ward_know_items SET proposed_text = ?, proposed_original_id = ?, updated_at = ? WHERE ward_id = ? AND item_id = ?")
      .bind(text.slice(0, MAX_BODY), originalId, now, wardId, topic).run();
  }
  for (const id of new Set(facts.map((fact) => fact.original_id).filter(Boolean))) {
    await db.prepare(`INSERT OR IGNORE INTO ward_material_links (ward_id, link_id, original_id, target_kind, target_id, linked_by) VALUES (?, ?, ?, 'know_item', ?, 'ai')`)
      .bind(wardId, newId(), id, topic).run();
  }
}

async function applyYear(db: D1Database, wardId: string, entries: YearEntry[]): Promise<void> {
  for (const entry of entries) {
    if (!entry.month) continue;
    const same = await db.prepare("SELECT 1 AS ok FROM ward_year_items WHERE ward_id = ? AND title = ? AND month = ? LIMIT 1").bind(wardId, entry.title, entry.month).first();
    if (same) continue;
    await db.prepare("INSERT INTO ward_year_items (ward_id, item_id, title, month, date_text, added, source_original_id) VALUES (?, ?, ?, ?, ?, 1, ?)")
      .bind(wardId, newId(), entry.title, entry.month, entry.date_text, entry.original_id || null).run();
  }
}

/** 読み終わった資料の内容を入れる。失敗しても資料の読みは止めない。 */
export async function applyWardReading(db: D1Database, wardId: string, body: ReadingBody): Promise<void> {
  if (!("fields" in body)) return;
  const byTopic = new Map<KnowTopic, WardFact[]>();
  for (const fact of body.ward_facts ?? []) byTopic.set(fact.topic, [...(byTopic.get(fact.topic) ?? []), fact]);
  for (const [topic, facts] of byTopic) await applyFact(db, wardId, topic, facts);
  await applyYear(db, wardId, body.year_entries ?? []);
}

/** 公式 LINE の文のうち、行事に限らない決まりや情報を入れる。 */
export async function applyLineFact(db: D1Database, wardId: string, jobId: string, topic: KnowTopic, text: string): Promise<void> {
  const original = await db.prepare("SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ? AND withdrawn_at IS NULL ORDER BY position LIMIT 1")
    .bind(wardId, jobId).first<{ original_id: string }>();
  if (original) await applyFact(db, wardId, topic, [{ original_id: original.original_id, topic, text: text.slice(0, 500) }]);
}
