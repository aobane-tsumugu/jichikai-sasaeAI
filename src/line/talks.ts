import { sha256Hex } from "../intake/media";
import { getReadings, listOriginals } from "../intake/store";
import type { OriginalRow } from "../intake/types";
import { getBundleDecision, saveAiBundleDecision, type BundleDecision } from "./bundle-decisions";
import { listClarifications } from "./clarifications";

export interface TalkPost {
  id: string;
  bundleId: string;
  talkId: string;
  talkName: string;
  jobId: string | null;
  itemId: string | null;
  eventId: string | null;
  sourceType: string;
  sourceId: string;
  destination: string;
  senderId: string;
  sender: string;
  at: string;
  text: string;
  originals: OriginalRow[];
  projectId: string | null;
}
export interface TalkTopic {
  id: string;
  anchor: string;
  posts: TalkPost[];
  decision: BundleDecision | null;
  inquiry: { inquiry_id: string; answer: string } | null;
}
export interface Talk {
  id: string;
  name: string;
  posts: TalkPost[];
  topics: TalkTopic[];
  waiting: number;
  at: string;
}

/** トークの印は自治会と接続先を含める。LINEのIDや表示名をURLに使わない。 */
export const talkMark = (wardId: string, destination: string, type: string, id: string) =>
  sha256Hex(JSON.stringify([wardId, destination, type, id]));
export const topicAnchor = async (id: string) => `topic-${await sha256Hex(id)}`;
export const talkPath = (id: string) => `/inbox/talks/${id}`;

export async function listTalks(db: D1Database, wardId: string): Promise<Talk[]> {
  const rows = await db.prepare(`SELECT i.*, COALESCE(i.matched_project_id, j.project_id) AS project_id
    FROM line_inbox_items i LEFT JOIN jobs j ON j.ward_id = i.ward_id AND j.job_id = i.job_id
    LEFT JOIN line_photo_items p ON p.ward_id = i.ward_id AND p.job_id = i.job_id
    WHERE i.ward_id = ? AND COALESCE(i.source_type, '') <> 'admin' AND (i.job_id IS NULL OR j.withdrawn_at IS NULL)
    ORDER BY i.received_at, i.created_at, p.image_index, i.event_id`)
    .bind(wardId).all<{ item_id: string; bundle_id: string | null; event_id: string; job_id: string | null;
      line_destination: string | null; source_type: string | null; source_id: string | null; sender_id: string;
      sender_display_name: string | null; original_text: string | null; received_at: string; project_id: string | null }>();
  const posts: TalkPost[] = await Promise.all(rows.results.map(async (row) => {
    const type = row.source_type ?? "user";
    const sourceId = row.source_id || row.sender_id;
    return { id: row.item_id, bundleId: row.bundle_id ?? row.item_id,
      talkId: await talkMark(wardId, row.line_destination ?? "", type, sourceId),
      talkName: type === "user" ? row.sender_display_name || "名前の分からない人" : "役員のLINEグループ",
      jobId: row.job_id, itemId: row.item_id, eventId: row.event_id, sourceType: type, sourceId, destination: row.line_destination ?? "", senderId: row.sender_id,
      sender: row.sender_display_name || "名前の分からない人", at: row.received_at, text: row.original_text ?? "",
      originals: row.job_id ? (await listOriginals(db, wardId, row.job_id)).filter((o) => !o.withdrawn_at) : [], projectId: row.project_id };
  }));
  const jobs = await db.prepare(`SELECT j.job_id, j.created_at, j.project_id, a.name AS display_name,
      COALESCE(t.bundle_id, 'admin:' || j.job_id) AS bundle_id
    FROM jobs j LEFT JOIN line_talk_admin_topics t ON t.ward_id = j.ward_id AND t.job_id = j.job_id
    LEFT JOIN accounts a ON a.ward_id = j.ward_id AND a.account_id = j.account_id
    WHERE j.ward_id = ? AND j.via = 'admin' AND j.task = 'connect' AND j.withdrawn_at IS NULL
      AND EXISTS (SELECT 1 FROM originals o WHERE o.ward_id = j.ward_id AND o.job_id = j.job_id AND o.withdrawn_at IS NULL)
    ORDER BY j.created_at, j.job_id`).bind(wardId)
    .all<{ job_id: string; created_at: string; project_id: string | null; display_name: string | null; bundle_id: string }>();
  const adminId = await talkMark(wardId, "", "admin", "");
  for (const job of jobs.results) {
    const originals = (await listOriginals(db, wardId, job.job_id)).filter((o) => !o.withdrawn_at);
    const readings = await getReadings(db, wardId, job.job_id);
    const text = readings.filter((r) => r.source === "direct").flatMap((r) => "text_blocks" in r.body
      ? r.body.text_blocks.filter((b) => originals.some((o) => o.original_id === b.original_id && o.kind === "text")).map((b) => b.text) : []).join("\n");
    // 役員画面の受付と読み取りに保存済みの結果を同じ表に写す。人の直しは更新しない。
    const saved = await getBundleDecision(db, wardId, job.bundle_id);
    if (!saved || saved.decided_by === "ai") await saveAiBundleDecision(db, wardId, job.bundle_id,
      readings.map((r) => r.body.summary).filter(Boolean).join(" ").slice(0, 500) || "送った資料です。", "material", job.project_id, new Date());
    posts.push({ id: `admin:${job.job_id}`, bundleId: job.bundle_id, talkId: adminId, talkName: "役員の画面から送ったもの",
      jobId: job.job_id, itemId: null, eventId: null, sourceType: "admin", sourceId: "", destination: "", senderId: "",
      sender: job.display_name || "役員", at: job.created_at, text, originals, projectId: job.project_id });
  }
  const inquiryPosts = await db.prepare("SELECT * FROM line_talk_inquiry_posts WHERE ward_id = ? ORDER BY received_at, event_id")
    .bind(wardId).all<{ event_id: string; bundle_id: string; destination: string; source_type: string; source_id: string;
      sender_id: string; sender_name: string | null; received_at: string; text: string }>();
  for (const row of inquiryPosts.results) posts.push({ id: row.event_id, bundleId: row.bundle_id,
    talkId: await talkMark(wardId, row.destination, row.source_type, row.source_id),
    talkName: row.source_type === "user" ? row.sender_name || "名前の分からない人" : "役員のLINEグループ",
    jobId: null, itemId: null, eventId: row.event_id, sourceType: row.source_type, sourceId: row.source_id, destination: row.destination, senderId: row.sender_id,
    sender: row.sender_name || "名前の分からない人", at: row.received_at, text: row.text, originals: [], projectId: null });
  // 古い問い合わせには届いたものが無い場合がある。元の文を同じトークに出す。
  const inquiries = await db.prepare(`SELECT inquiry_id, line_bundle_id, line_event_id, received_at, subject, answer,
      line_source_type, line_source_id, line_sender_label FROM inquiry_records WHERE ward_id = ?
      AND (line_source_type IS NOT NULL OR line_bundle_id IS NOT NULL) ORDER BY received_at, inquiry_id`).bind(wardId)
    .all<{ inquiry_id: string; line_bundle_id: string | null; line_event_id: string | null; received_at: string; subject: string;
      answer: string; line_source_type: string; line_source_id: string; line_sender_label: string | null }>();
  for (const row of inquiries.results) {
    if (posts.some((p) => p.bundleId === row.line_bundle_id || (row.line_event_id && p.eventId === row.line_event_id))) continue;
    // 別の資料へ直した問い合わせの記録は返事の画面に残すが、元の会話を二重に出さない。
    if (!row.line_bundle_id && row.line_event_id && posts.some((p) => p.eventId === row.line_event_id)) continue;
    const id = row.line_bundle_id ?? `inquiry:${row.inquiry_id}`;
    const existing = posts.find((p) => p.sourceType === row.line_source_type && p.sourceId === row.line_source_id);
    posts.push({ id: `inquiry:${row.inquiry_id}`, bundleId: id, talkId: existing?.talkId ?? await talkMark(wardId, "", row.line_source_type, row.line_source_id),
      talkName: row.line_source_type === "user" ? row.line_sender_label || "名前の分からない人" : "役員のLINEグループ",
      jobId: null, itemId: null, eventId: row.line_event_id, sourceType: row.line_source_type, sourceId: row.line_source_id, destination: existing?.destination ?? "",
      senderId: row.line_source_id, sender: row.line_sender_label || "名前の分からない人", at: row.received_at,
      text: row.subject, originals: [], projectId: null });
  }
  const questions = await listClarifications(db, wardId);
  const talks = new Map<string, Talk>();
  for (const post of posts.sort((a, b) => a.at.localeCompare(b.at))) {
    let talk = talks.get(post.talkId);
    if (!talk) {
      talk = { id: post.talkId, name: post.talkName, posts: [], topics: [], waiting: 0, at: post.at };
      talks.set(post.talkId, talk);
    }
    talk.posts.push(post);
    talk.at = post.at;
    // 後から名前が分かった人には、分かった名前を使う。
    if (post.talkName !== "名前の分からない人") talk.name = post.talkName;
    let topic = talk.topics.find((t) => t.id === post.bundleId);
    if (!topic) {
      const record = inquiries.results.find((q) => q.line_bundle_id === post.bundleId || (post.eventId && q.line_event_id === post.eventId)
        || `inquiry:${q.inquiry_id}` === post.bundleId);
      topic = { id: post.bundleId, anchor: await topicAnchor(post.bundleId), posts: [], decision: await getBundleDecision(db, wardId, post.bundleId),
        inquiry: record ? { inquiry_id: record.inquiry_id, answer: record.answer } : null };
      // U82より前の保存済みの行き先も、この表から読む。未判断の写真には判断を作らない。
      if (!topic.decision && (record || post.projectId)) topic.decision = await saveAiBundleDecision(db, wardId, post.bundleId,
        record ? "住民からの問い合わせです。" : (post.jobId ? (await getReadings(db, wardId, post.jobId)).map((r) => r.body.summary).join(" ").slice(0, 500) : "") || post.text.slice(0, 500) || "届いた写真と言葉です。",
        record ? "inquiry" : "material", record ? null : post.projectId, new Date());
      talk.topics.push(topic);
    }
    topic.posts.push(post);
    talk.waiting += questions.filter((q) => q.job_id === post.jobId && !q.answer).length;
  }
  for (const talk of talks.values()) talk.waiting += talk.topics.filter((topic) => topic.inquiry && !topic.inquiry.answer
    && (!topic.decision || topic.decision.action === "inquiry")).length;
  return [...talks.values()].sort((a, b) => b.at.localeCompare(a.at));
}

export async function conversationFor(db: D1Database, wardId: string, find: { itemId?: string; jobId?: string; bundleId?: string; inquiryId?: string }) {
  const inquiry = find.inquiryId ? await db.prepare("SELECT line_event_id, line_bundle_id FROM inquiry_records WHERE ward_id = ? AND inquiry_id = ?")
    .bind(wardId, find.inquiryId).first<{ line_event_id: string | null; line_bundle_id: string | null }>() : null;
  for (const talk of await listTalks(db, wardId)) {
    const topic = talk.topics.find((t) => (find.bundleId && t.id === find.bundleId) || (find.inquiryId && t.inquiry?.inquiry_id === find.inquiryId)
      || (inquiry?.line_bundle_id && t.id === inquiry.line_bundle_id)
      || t.posts.some((p) => (find.itemId && p.itemId === find.itemId) || (find.jobId && p.jobId === find.jobId) || (inquiry?.line_event_id && p.eventId === inquiry.line_event_id)));
    if (topic) return `${talkPath(talk.id)}#${topic.anchor}`;
  }
  return null;
}
