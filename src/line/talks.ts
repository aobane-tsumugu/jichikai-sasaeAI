import { sha256Hex } from "../intake/media";
import { getReadings } from "../intake/store";
import type { OriginalRow } from "../intake/types";
import { saveAiBundleDecision, type BundleDecision } from "./bundle-decisions";
import { listClarifications } from "./clarifications";
import { hasSenderName, senderNumbers, senderText } from "./sender";

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
  senderNumber?: number;
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

const TOPICS_PER_PAGE = 20;

/** beforeの話題より前を、新しい方から20話題選び、表示は古い順に保つ。 */
export function talkPage(talk: Talk, before?: string) {
  const end = before === undefined ? talk.topics.length : talk.topics.findIndex((topic) => topic.anchor === before);
  if (end < 0) return null;
  const start = Math.max(0, end - TOPICS_PER_PAGE);
  return { topics: talk.topics.slice(start, end), older: start > 0 ? talk.topics[start]!.anchor : null };
}

/** 話題を含む区切りと、その枠の印を一緒に返す。 */
export function conversationPath(talk: Talk, topic: TalkTopic) {
  const index = talk.topics.indexOf(topic);
  const end = talk.topics.length - Math.floor((talk.topics.length - 1 - index) / TOPICS_PER_PAGE) * TOPICS_PER_PAGE;
  const before = end < talk.topics.length ? `?before=${talk.topics[end]!.anchor}` : "";
  return `${talkPath(talk.id)}${before}#${topic.anchor}`;
}

/**
 * トークを集める。資料、読み取り、判断は一件ずつ読まず、自治会の分をまとめて読む。
 * 役員の画面から送った物が数百ある自治会でも、画面を開くたびに件数だけ問い合わせを重ねないため。
 * withText が false の時は、役員の画面から送った文の中身を読まない（一覧と元の会話への道だけの時）。
 */
export async function listTalks(db: D1Database, wardId: string, options: { withText?: boolean } = {}): Promise<Talk[]> {
  const withText = options.withText ?? true;
  const numbers = await senderNumbers(db, wardId);
  const originalRows = await db.prepare(`SELECT o.*, j.job_id AS for_job FROM jobs j JOIN originals o
    ON o.ward_id = j.ward_id AND (o.job_id = j.job_id OR o.job_id = j.paper_source_job_id)
    WHERE j.ward_id = ? AND o.withdrawn_at IS NULL ORDER BY o.position`).bind(wardId).all<OriginalRow & { for_job: string }>();
  const originalsByJob = new Map<string, OriginalRow[]>();
  for (const { for_job: jobId, ...original } of originalRows.results) {
    const list = originalsByJob.get(jobId) ?? [];
    list.push(original as OriginalRow);
    originalsByJob.set(jobId, list);
  }
  const originalsOf = (jobId: string | null) => jobId ? originalsByJob.get(jobId) ?? [] : [];
  // 表の行には updated_at もある。読み取りの後に一度だけ写すかを決めるのに使う。
  const decisions = new Map<string, BundleDecision & { updated_at?: string }>((await db.prepare("SELECT * FROM line_bundle_decisions WHERE ward_id = ?")
    .bind(wardId).all<BundleDecision & { updated_at: string }>()).results.map((decision) => [decision.bundle_id, decision] as const));
  const marks = new Map<string, Promise<string>>();
  const mark = (destination: string, type: string, id: string) => {
    const key = JSON.stringify([destination, type, id]);
    if (!marks.has(key)) marks.set(key, talkMark(wardId, destination, type, id));
    return marks.get(key)!;
  };
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
      talkId: await mark(row.line_destination ?? "", type, sourceId),
      talkName: type === "user" ? senderText(row.sender_display_name, type, numbers.get(row.sender_id)) : "役員のLINEグループ",
      jobId: row.job_id, itemId: row.item_id, eventId: row.event_id, sourceType: type, sourceId, destination: row.line_destination ?? "", senderId: row.sender_id,
      sender: row.sender_display_name ?? "", senderNumber: numbers.get(row.sender_id), at: row.received_at, text: row.original_text ?? "",
      originals: originalsOf(row.job_id), projectId: row.project_id };
  }));
  const jobs = await db.prepare(`SELECT j.job_id, j.created_at, j.project_id, j.read_at, a.name AS display_name,
      COALESCE(t.bundle_id, 'admin:' || j.job_id) AS bundle_id
    FROM jobs j LEFT JOIN line_talk_admin_topics t ON t.ward_id = j.ward_id AND t.job_id = j.job_id
    LEFT JOIN accounts a ON a.ward_id = j.ward_id AND a.account_id = j.account_id
    WHERE j.ward_id = ? AND j.via = 'admin' AND j.task = 'connect' AND j.withdrawn_at IS NULL
      AND EXISTS (SELECT 1 FROM originals o WHERE o.ward_id = j.ward_id AND o.job_id = j.job_id AND o.withdrawn_at IS NULL)
    ORDER BY j.created_at, j.job_id`).bind(wardId)
    .all<{ job_id: string; created_at: string; project_id: string | null; read_at: string | null; display_name: string | null; bundle_id: string }>();
  const adminId = await mark("", "admin", "");
  const directBodies = new Map<string, string[]>();
  if (withText) {
    const direct = await db.prepare(`SELECT r.job_id, r.body FROM readings r JOIN jobs j ON j.ward_id = r.ward_id AND j.job_id = r.job_id
      WHERE r.ward_id = ? AND r.source = 'direct' AND j.via = 'admin' AND j.task = 'connect' AND j.withdrawn_at IS NULL`)
      .bind(wardId).all<{ job_id: string; body: string }>();
    for (const row of direct.results) directBodies.set(row.job_id, [...directBodies.get(row.job_id) ?? [], row.body]);
  }
  for (const job of jobs.results) {
    const originals = originalsOf(job.job_id);
    const text = (directBodies.get(job.job_id) ?? []).flatMap((raw) => {
      let body: unknown;
      try { body = JSON.parse(raw); } catch { return []; }
      const blocks = body && typeof body === "object" && "text_blocks" in body && Array.isArray(body.text_blocks)
        ? body.text_blocks as Array<{ original_id?: unknown; text?: unknown }> : [];
      return blocks.filter((b) => typeof b.text === "string" && originals.some((o) => o.original_id === b.original_id && o.kind === "text"))
        .map((b) => b.text as string);
    }).join("\n");
    // 役員画面の受付と読み取りに保存済みの結果を同じ表に写す。人の直しは更新しない。
    // 写すのは、まだ無い時と、AIの判断のまま行き先や読み取りが変わった時だけにする。開くたびに書き直さない。
    const saved = decisions.get(job.bundle_id);
    if (!saved || (saved.decided_by === "ai" && ((saved.project_id ?? null) !== (job.project_id ?? null)
      || (job.read_at !== null && (saved.updated_at ?? "") < job.read_at)))) {
      const readings = await getReadings(db, wardId, job.job_id);
      decisions.set(job.bundle_id, await saveAiBundleDecision(db, wardId, job.bundle_id,
        readings.map((r) => r.body.summary).filter(Boolean).join(" ").slice(0, 500) || "送った資料です。", "material", job.project_id, new Date()));
    }
    posts.push({ id: `admin:${job.job_id}`, bundleId: job.bundle_id, talkId: adminId, talkName: "役員の画面から送ったもの",
      jobId: job.job_id, itemId: null, eventId: null, sourceType: "admin", sourceId: "", destination: "", senderId: "",
      sender: job.display_name || "役員", at: job.created_at, text, originals, projectId: job.project_id });
  }
  const inquiryPosts = await db.prepare("SELECT * FROM line_talk_inquiry_posts WHERE ward_id = ? ORDER BY received_at, event_id")
    .bind(wardId).all<{ event_id: string; bundle_id: string; destination: string; source_type: string; source_id: string;
      sender_id: string; sender_name: string | null; received_at: string; text: string }>();
  for (const row of inquiryPosts.results) posts.push({ id: row.event_id, bundleId: row.bundle_id,
    talkId: await mark(row.destination, row.source_type, row.source_id),
    talkName: row.source_type === "user" ? senderText(row.sender_name, row.source_type, numbers.get(row.sender_id)) : "役員のLINEグループ",
    jobId: null, itemId: null, eventId: row.event_id, sourceType: row.source_type, sourceId: row.source_id, destination: row.destination, senderId: row.sender_id,
    sender: row.sender_name ?? "", senderNumber: numbers.get(row.sender_id), at: row.received_at, text: row.text, originals: [], projectId: null });
  // 古い問い合わせには届いたものが無い場合がある。元の文を同じトークに出す。
  const inquiries = await db.prepare(`SELECT inquiry_id, line_bundle_id, line_event_id, received_at, subject, answer,
      line_source_type, line_source_id, line_user_id, line_sender_label FROM inquiry_records WHERE ward_id = ?
      AND (line_source_type IS NOT NULL OR line_bundle_id IS NOT NULL) ORDER BY received_at, inquiry_id`).bind(wardId)
    .all<{ inquiry_id: string; line_bundle_id: string | null; line_event_id: string | null; received_at: string; subject: string;
      answer: string; line_source_type: string; line_source_id: string; line_user_id: string | null; line_sender_label: string | null }>();
  for (const row of inquiries.results) {
    if (posts.some((p) => p.bundleId === row.line_bundle_id || (row.line_event_id && p.eventId === row.line_event_id))) continue;
    // 別の資料へ直した問い合わせの記録は返事の画面に残すが、元の会話を二重に出さない。
    if (!row.line_bundle_id && row.line_event_id && posts.some((p) => p.eventId === row.line_event_id)) continue;
    const id = row.line_bundle_id ?? `inquiry:${row.inquiry_id}`;
    const existing = posts.find((p) => p.sourceType === row.line_source_type && p.sourceId === row.line_source_id);
    const senderId = row.line_user_id || (row.line_source_type === "user" ? row.line_source_id : "");
    posts.push({ id: `inquiry:${row.inquiry_id}`, bundleId: id, talkId: existing?.talkId ?? await mark("", row.line_source_type, row.line_source_id),
      talkName: row.line_source_type === "user" ? senderText(row.line_sender_label, row.line_source_type, numbers.get(senderId)) : "役員のLINEグループ",
      jobId: null, itemId: null, eventId: row.line_event_id, sourceType: row.line_source_type, sourceId: row.line_source_id, destination: existing?.destination ?? "",
      senderId, sender: row.line_sender_label ?? "", senderNumber: numbers.get(senderId), at: row.received_at,
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
    if (post.sourceType !== "user" || hasSenderName(post.sender)) talk.name = post.talkName;
    let topic = talk.topics.find((t) => t.id === post.bundleId);
    if (!topic) {
      const record = inquiries.results.find((q) => q.line_bundle_id === post.bundleId || (post.eventId && q.line_event_id === post.eventId)
        || `inquiry:${q.inquiry_id}` === post.bundleId);
      topic = { id: post.bundleId, anchor: await topicAnchor(post.bundleId), posts: [], decision: decisions.get(post.bundleId) ?? null,
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
  for (const talk of await listTalks(db, wardId, { withText: false })) {
    const topic = talk.topics.find((t) => (find.bundleId && t.id === find.bundleId) || (find.inquiryId && t.inquiry?.inquiry_id === find.inquiryId)
      || (inquiry?.line_bundle_id && t.id === inquiry.line_bundle_id)
      || t.posts.some((p) => (find.itemId && p.itemId === find.itemId) || (find.jobId && p.jobId === find.jobId) || (inquiry?.line_event_id && p.eventId === inquiry.line_event_id)));
    if (topic) return conversationPath(talk, topic);
  }
  return null;
}
