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
    // 月がない通年の予定も受け取る。くり返しの詳しい言い方は資料のまま残す。
    const recurrence = /毎週|毎月|随時|通年/.test(entry.date_text) ? entry.date_text.trim() : "";
    if (!entry.month && !recurrence) continue;
    const same = await db.prepare("SELECT 1 AS ok FROM ward_year_items WHERE ward_id = ? AND title = ? AND (recurrence_text = ? AND recurrence_text <> '' OR recurrence_text = '' AND month = ?) LIMIT 1")
      .bind(wardId, entry.title, recurrence, entry.month).first();
    if (same) continue;
    await db.prepare("INSERT INTO ward_year_items (ward_id, item_id, title, month, date_text, recurrence_text, added, source_original_id) VALUES (?, ?, ?, ?, ?, ?, 1, ?)")
      .bind(wardId, newId(), entry.title, recurrence ? null : entry.month, entry.date_text, recurrence, entry.original_id || null).run();
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

/** 資料の食い違いを人が選んだときだけ、同じ資料に結び付いた説明と決めたことをそろえる。 */
export async function reconcileAnsweredFact(db: D1Database, wardId: string, projectId: string, questionId: string,
  itemKey: string, options: string[], answer: string, accountId: string): Promise<void> {
  const question = await db.prepare("SELECT detail FROM project_questions WHERE ward_id = ? AND project_id = ? AND question_id = ?")
    .bind(wardId, projectId, questionId).first<{ detail: string }>();
  const detail = JSON.parse(question?.detail ?? "{}") as { sources?: { ref?: string }[] };
  const refs = [...new Set(detail.sources?.flatMap((source) => source.ref ? [source.ref] : []) ?? [])];
  const project = await db.prepare("SELECT title FROM projects WHERE ward_id = ? AND project_id = ?")
    .bind(wardId, projectId).first<{ title: string }>();
  const title = project?.title.replace(/^\d{4}年度?\s*/, "").replace(/[（(].*?[）)]/g, "").trim();
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = options.map((option) => {
    const date = itemKey === "date_time" ? option.normalize("NFKC").match(/(?:(\d{4})年)?(\d{1,2})月(\d{1,2})日/) : null;
    return date ? new RegExp(`(?:${date[1] ?? "\\d{4}"}年)?${Number(date[2])}月${Number(date[3])}日(?:[（(][^）)]*[）)])?`, "g")
      : new RegExp(escape(option), "g");
  });
  const matches = (text: string) => patterns.some((pattern) => { pattern.lastIndex = 0; return pattern.test(text); });
  const replace = (text: string) => {
    // 一度の置換にして、選んだ値の中を別の候補として置き換えない。
    const chosenDate = itemKey === "date_time" ? answer.match(/(?:\d{4}年)?\d{1,2}月\d{1,2}日(?:[（(][^）)]*[）)])?/) : null;
    return text.replace(new RegExp(patterns.map((pattern) => pattern.source).join("|"), "g"), () => chosenDate?.[0] ?? answer);
  };
  const now = nowIso();
  const statements: D1PreparedStatement[] = [];
  if (refs.length) {
    const know = await db.prepare(`SELECT k.item_id, k.body FROM ward_know_items k WHERE k.ward_id = ? AND k.removed_at IS NULL
      AND EXISTS (SELECT 1 FROM ward_material_links l WHERE l.ward_id = ? AND l.target_kind = 'know_item'
        AND l.target_id = k.item_id AND l.original_id IN (${refs.map(() => "?").join(",")}))`)
      .bind(wardId, wardId, ...refs).all<{ item_id: string; body: string }>();
    for (const row of know.results) {
      const body = row.body.split("\n").map((line) => title && line.includes(title) && matches(line) ? replace(line) : line).join("\n");
      if (body !== row.body) statements.push(db.prepare(`UPDATE ward_know_items SET body = ?, reviewed_at = ?, updated_at = ?
        WHERE ward_id = ? AND item_id = ? AND removed_at IS NULL`).bind(body, now, now, wardId, row.item_id));
    }
  }
  const decisions = await db.prepare(`SELECT row_id, data FROM project_rows WHERE ward_id = ? AND project_id = ?
    AND table_key = 'decisions' AND scope = 'current' AND source_kind = 'original' AND removed_at IS NULL`)
    .bind(wardId, projectId).all<{ row_id: string; data: string }>();
  for (const row of decisions.results) {
    const data = JSON.parse(row.data) as { what?: string };
    if (data.what && matches(data.what) && (options.includes(data.what) || !!title && data.what.includes(title))) statements.push(db.prepare(`UPDATE project_rows SET removed_at = ?, updated_at = ?, created_by_account_id = ?
      WHERE ward_id = ? AND project_id = ? AND row_id = ? AND removed_at IS NULL`).bind(now, now, accountId, wardId, projectId, row.row_id));
  }
  if (statements.length) await db.batch(statements);
}
