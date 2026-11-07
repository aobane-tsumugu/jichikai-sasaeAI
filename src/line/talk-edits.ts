import type { Env } from "../env";
import { newId, nowIso } from "../core/ids";
import { assignProject } from "../intake/api";
import { getJob, listOriginals, setJobProject } from "../intake/store";
import { receive } from "../intake/receive";
import type { Waitable } from "../intake/types";
import { linkKnowSource, listKnowItems } from "../know/store";
import { createProject } from "../project/api";
import { PROJECT_KINDS, type ProjectKind } from "../project/model";
import { type BundleAction, type BundleDecision } from "./bundle-decisions";
import { markInboxItemUnrelated, saveLineBundleInquiry } from "./intake";
import { rememberPhotoSource } from "./photo-context";
import type { Talk, TalkPost, TalkTopic } from "./talks";

export async function saveOfficerDecision(db: D1Database, wardId: string, bundleId: string, summary: string,
  action: BundleAction, projectId: string | null): Promise<void> {
  const now = nowIso();
  await db.prepare(`INSERT INTO line_bundle_decisions
    (ward_id, bundle_id, summary, action, project_id, decided_by, created_at, updated_at, decided_at)
    VALUES (?, ?, ?, ?, ?, 'officer', ?, ?, ?) ON CONFLICT (ward_id, bundle_id) DO UPDATE SET
    summary = excluded.summary, action = excluded.action, project_id = excluded.project_id,
    decided_by = 'officer', updated_at = excluded.updated_at, decided_at = excluded.decided_at`)
    .bind(wardId, bundleId, summary, action, projectId, now, now, now).run();
}

/** 参考は既存の接続処理と同じく今年の中身を作るAIへ渡さない。 */
export async function move(env: Env, ctx: Waitable, wardId: string, posts: TalkPost[], action: BundleAction, projectId: string | null) {
  for (const post of posts) {
    if (!post.jobId) continue;
    const job = await getJob(env.DB, wardId, post.jobId);
    if (!job || job.withdrawn_at || job.status === "connecting") throw new Error("busy");
    if (action === "reference" || action === "inquiry" || action === "unrelated" || action === "know") {
      if (!await setJobProject(env.DB, wardId, post.jobId, projectId)) throw new Error("busy");
      await env.DB.prepare(`UPDATE jobs SET status = CASE WHEN read_at IS NOT NULL THEN 'done' ELSE status END,
        stop_reason = ? WHERE ward_id = ? AND job_id = ? AND withdrawn_at IS NULL`)
        .bind(action === "reference" ? "参考資料として残しました。" : "役員が使い方を直しました。", wardId, post.jobId).run();
    } else {
      if (projectId && job.project_id === projectId && job.stop_reason === "参考資料として残しました。") {
        if (!await setJobProject(env.DB, wardId, post.jobId, null)) throw new Error("busy");
      }
      if (!await assignProject(env, ctx, wardId, post.jobId, projectId)) throw new Error("busy");
    }
    if (post.itemId) await env.DB.prepare(`UPDATE line_inbox_items SET matched_project_id = ?, disposition = ?,
      matched_project_name = (SELECT title FROM projects WHERE ward_id = ? AND project_id = ?), match_reason = NULL
      WHERE ward_id = ? AND item_id = ?`).bind(projectId, projectId ? "matched" : "unmatched", wardId, projectId, wardId, post.itemId).run();
    if (projectId && post.itemId) await rememberPhotoSource(env.DB, wardId, post.jobId, projectId);
  }
}

interface SavedPost { id: string; bundleId: string; jobId: string | null; projectId: string | null }
interface Snapshot { posts: SavedPost[]; decisions: Array<{ id: string; value: BundleDecision | null }>;
  inquiries: Array<{ inquiry_id: string; line_bundle_id: string | null; subject: string }>; links: Array<{ original_id: string; target_id: string }> }

/** 境目の直しも同じボタンで戻せるよう、触る投稿の行き先を保存する。本文や写真は複製しない。 */
export async function saveUndo(db: D1Database, wardId: string, talk: Talk, topicIds: string[] = talk.topics.map((t) => t.id)): Promise<string> {
  const topics = talk.topics.filter((t) => topicIds.includes(t.id));
  const posts = talk.posts.filter((p) => topicIds.includes(p.bundleId));
  const inquiries = await db.prepare("SELECT inquiry_id, line_bundle_id, subject FROM inquiry_records WHERE ward_id = ? AND line_bundle_id IS NOT NULL")
    .bind(wardId).all<{ inquiry_id: string; line_bundle_id: string | null; subject: string }>();
  const links = await db.prepare("SELECT original_id, target_id FROM ward_material_links WHERE ward_id = ? AND target_kind = 'know_item'")
    .bind(wardId).all<{ original_id: string; target_id: string }>();
  const ids = new Set(posts.flatMap((p) => p.originals.map((o) => o.original_id)));
  const snapshot: Snapshot = { posts: posts.map((p) => ({ id: p.id, bundleId: p.bundleId, jobId: p.jobId, projectId: p.projectId })),
    decisions: topics.map((t) => ({ id: t.id, value: t.decision })),
    inquiries: inquiries.results.filter((q) => topics.some((t) => t.id === q.line_bundle_id)), links: links.results.filter((l) => ids.has(l.original_id)) };
  const id = newId();
  await db.prepare(`INSERT INTO line_talk_undo (ward_id, talk_id, undo_id, body) VALUES (?, ?, ?, ?)
    ON CONFLICT (ward_id, talk_id) DO UPDATE SET undo_id = excluded.undo_id, body = excluded.body`)
    .bind(wardId, talk.id, id, JSON.stringify(snapshot)).run();
  return id;
}

async function setPostTopic(db: D1Database, wardId: string, post: TalkPost, bundleId: string) {
  if (post.sourceType === "admin" && post.jobId) {
    await db.prepare(`INSERT INTO line_talk_admin_topics (ward_id, job_id, bundle_id) VALUES (?, ?, ?)
      ON CONFLICT (ward_id, job_id) DO UPDATE SET bundle_id = excluded.bundle_id`).bind(wardId, post.jobId, bundleId).run();
    await db.prepare("UPDATE line_inbox_items SET bundle_id = ? WHERE ward_id = ? AND job_id = ? AND source_type = 'admin'")
      .bind(bundleId, wardId, post.jobId).run();
  } else {
    // 古い問い合わせで原文が記録にしかないものも、境目を直した時から投稿として保つ。
    if (!post.itemId && post.id.startsWith("inquiry:")) await db.prepare(`INSERT OR IGNORE INTO line_talk_inquiry_posts
      (ward_id, event_id, bundle_id, destination, source_type, source_id, sender_id, sender_name, received_at, text)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(wardId, post.eventId ?? post.id, post.bundleId, post.destination, post.sourceType, post.sourceId, post.senderId, post.sender, post.at, post.text).run();
    await db.batch([
    db.prepare("UPDATE line_inbox_items SET bundle_id = ? WHERE ward_id = ? AND item_id = ?").bind(bundleId, wardId, post.itemId),
    db.prepare("UPDATE line_talk_inquiry_posts SET bundle_id = ? WHERE ward_id = ? AND event_id = ?").bind(bundleId, wardId, post.eventId),
    db.prepare("UPDATE line_webhook_receipts SET bundle_id = ? WHERE ward_id = ? AND event_id = ?").bind(bundleId, wardId, post.eventId),
    ]);
  }
}

export async function undoTalk(env: Env, ctx: Waitable, wardId: string, talk: Talk, undoId: string) {
  const row = await env.DB.prepare("SELECT body FROM line_talk_undo WHERE ward_id = ? AND talk_id = ? AND undo_id = ?")
    .bind(wardId, talk.id, undoId).first<{ body: string }>();
  if (!row) throw new Error("stale");
  const saved = JSON.parse(row.body) as Snapshot;
  const posts = talk.posts.filter((p) => saved.posts.some((s) => s.id === p.id));
  const topics = talk.topics.filter((t) => t.posts.some((p) => posts.includes(p)));
  if (saved.posts.length !== posts.length || topics.some((t) => t.posts.some((p) => !posts.includes(p)))) throw new Error("stale");
  await checkEditable(env.DB, wardId, posts);
  // 問い合わせの返事は取り消さない。直したあとで返事を書いた時は、画面からもう一度直す。
  for (const topic of topics) if (topic.inquiry?.answer && !saved.inquiries.some((q) => q.inquiry_id === topic.inquiry?.inquiry_id)) throw new Error("answered");
  for (const topic of topics) {
    if (topic.inquiry && !saved.inquiries.some((q) => q.inquiry_id === topic.inquiry?.inquiry_id)) {
      await env.DB.prepare("DELETE FROM inquiry_records WHERE ward_id = ? AND inquiry_id = ? AND answer = '' AND line_answer_sent_at IS NULL")
        .bind(wardId, topic.inquiry.inquiry_id).run();
    } else await env.DB.prepare("UPDATE inquiry_records SET line_bundle_id = NULL WHERE ward_id = ? AND line_bundle_id = ?")
      .bind(wardId, topic.id).run();
  }
  for (const post of posts) {
    const previous = saved.posts.find((p) => p.id === post.id);
    if (previous) await setPostTopic(env.DB, wardId, post, previous.bundleId);
  }
  for (const topic of topics) if (!saved.decisions.some((d) => d.id === topic.id)) await env.DB.prepare("DELETE FROM line_bundle_decisions WHERE ward_id = ? AND bundle_id = ?")
    .bind(wardId, topic.id).run();
  for (const entry of saved.decisions) {
    // 戻した判断も人の判断として残す。あとからAIが上書きしない。
    const value = entry.value;
    const first = saved.posts.find((p) => p.bundleId === entry.id);
    await saveOfficerDecision(env.DB, wardId, entry.id, value?.summary ?? "元の使い方に戻しました。", value?.action ?? "material", value?.project_id ?? first?.projectId ?? null);
  }
  for (const post of posts) {
    const previous = saved.posts.find((p) => p.id === post.id);
    if (!previous) continue;
    const decision = saved.decisions.find((d) => d.id === previous.bundleId)?.value;
    await move(env, ctx, wardId, [post], decision?.action ?? "material", previous.projectId);
    for (const original of post.originals) await env.DB.prepare("DELETE FROM ward_material_links WHERE ward_id = ? AND original_id = ? AND target_kind = 'know_item'")
      .bind(wardId, original.original_id).run();
  }
  for (const link of saved.links) await linkKnowSource(env.DB, wardId, link.target_id, link.original_id);
  for (const record of saved.inquiries) await env.DB.prepare("UPDATE inquiry_records SET line_bundle_id = ?, subject = ? WHERE ward_id = ? AND inquiry_id = ?")
    .bind(record.line_bundle_id, record.subject, wardId, record.inquiry_id).run();
  await env.DB.prepare("DELETE FROM line_talk_undo WHERE ward_id = ? AND talk_id = ? AND undo_id = ?").bind(wardId, talk.id, undoId).run();
}

export async function checkEditable(db: D1Database, wardId: string, posts: TalkPost[]) {
  for (const post of posts) if (post.jobId) {
    const job = await getJob(db, wardId, post.jobId);
    if (!job || job.withdrawn_at || job.status === "connecting") throw new Error("busy");
  }
}

export async function changeBoundary(env: Env, ctx: Waitable, wardId: string, talk: Talk, topic: TalkTopic, postId: string, operation: string, beforeChange: () => Promise<unknown>) {
  const index = topic.posts.findIndex((p) => p.id === postId);
  if (index < 0) throw new Error("input");
  const post = topic.posts[index]!;
  const at = talk.posts.findIndex((p) => p.id === postId);
  const previous = talk.posts[at - 1];
  const target = operation === "join" && previous ? talk.topics.find((t) => t.id === previous.bundleId) : null;
  if (!["split", "join"].includes(operation) || operation === "split" && index === 0 || operation === "join" && (!target || target.id === topic.id)) throw new Error("input");
  const moved = operation === "split" ? topic.posts.slice(index) : [post];
  await checkEditable(env.DB, wardId, target ? [...topic.posts, ...target.posts] : topic.posts);
  if (topic.inquiry?.answer || target?.inquiry?.answer) throw new Error("answered");
  await beforeChange();
  const targetId = target?.id ?? newId();
  const decision = target ? target.decision : topic.decision;
  const action: BundleAction = decision?.action ?? ((target ? target.inquiry : topic.inquiry) ? "inquiry" : "material");
  const projectId = decision ? decision.project_id : target ? target.posts[0]!.projectId : post.projectId;
  for (const member of moved) await setPostTopic(env.DB, wardId, member, targetId);
  await saveOfficerDecision(env.DB, wardId, targetId, decision?.summary ?? "届いた写真と言葉です。", action, projectId);
  if (topic.posts.length > moved.length) await saveOfficerDecision(env.DB, wardId, topic.id,
    topic.decision?.summary ?? "届いた写真と言葉です。", topic.decision?.action ?? "material", topic.decision?.project_id ?? topic.posts[0]!.projectId);
  await move(env, ctx, wardId, moved, action, projectId);
  // 元の問い合わせは残し、新しい側も同じ既存処理へつなぐ。
  if (topic.inquiry) {
    const remaining = topic.posts.filter((p) => !moved.includes(p));
    if (remaining.length) await env.DB.prepare("UPDATE inquiry_records SET subject = ? WHERE ward_id = ? AND inquiry_id = ?")
      .bind(remaining.map((p) => p.text).filter(Boolean).join("\n") || "写真についての問い合わせ", wardId, topic.inquiry.inquiry_id).run();
    else await env.DB.prepare("UPDATE inquiry_records SET line_bundle_id = NULL WHERE ward_id = ? AND inquiry_id = ?")
      .bind(wardId, topic.inquiry.inquiry_id).run();
  }
  if (action === "inquiry") await makeInquiry(env.DB, wardId, targetId, target ? [...target.posts, ...moved] : moved);
  return targetId;
}

async function makeInquiry(db: D1Database, wardId: string, id: string, posts: TalkPost[]) {
  const first = posts[0]!;
  const previous = await db.prepare("SELECT inquiry_id, line_bundle_id FROM inquiry_records WHERE ward_id = ? AND line_event_id = ?")
    .bind(wardId, first.eventId).first<{ inquiry_id: string; line_bundle_id: string | null }>();
  if (previous && !previous.line_bundle_id) await db.prepare("UPDATE inquiry_records SET line_bundle_id = ? WHERE ward_id = ? AND inquiry_id = ?")
    .bind(id, wardId, previous.inquiry_id).run();
  if (first.sourceType === "admin") {
    const found = await db.prepare("SELECT inquiry_id FROM inquiry_records WHERE ward_id = ? AND line_bundle_id = ?").bind(wardId, id).first();
    if (!found) await db.prepare(`INSERT INTO inquiry_records (inquiry_id, ward_id, received_at, kind, subject, answer, submitted_to_city,
      created_at, line_bundle_id) VALUES (?, ?, ?, 'inquiry', ?, '', 0, ?, ?)`)
      .bind(newId(), wardId, first.at, posts.map((p) => p.text).filter(Boolean).join("\n") || "送った資料についての問い合わせ", nowIso(), id).run();
  } else await saveLineBundleInquiry(db, wardId, id, { eventId: first.eventId ?? first.id, senderId: first.senderId,
    senderDisplayName: first.sender, sourceType: first.sourceType === "user" ? "user" : first.sourceType === "room" ? "room" : "group",
    receivedAt: first.at, kind: "text", text: posts.map((p) => p.text).filter(Boolean).join("\n") }, first.sourceId);
}

export async function editTopic(env: Env, ctx: Waitable, wardId: string, accountId: string, topic: TalkTopic, form: FormData, beforeChange: () => Promise<unknown>) {
  await checkEditable(env.DB, wardId, topic.posts);
  const summary = String(form.get("summary") ?? topic.decision?.summary ?? "届いた写真と言葉です。").trim();
  const action = String(form.get("action") ?? "material");
  if (!summary || summary.length > 500 || !["material", "reference", "inquiry", "know", "unrelated"].includes(action)) throw new Error("input");
  let projectId: string | null = null;
  let newProject: { title: string; kind: ProjectKind } | null = null;
  if (action === "material" || action === "reference") {
    projectId = String(form.get("projectId") ?? "") || null;
    if (projectId === "new") {
      const title = String(form.get("projectName") ?? "").trim();
      const kind = String(form.get("kind") ?? "event");
      if (!title || title.length > 100 || !PROJECT_KINDS.some((k) => k === kind)) throw new Error("input");
      newProject = { title, kind: kind as ProjectKind };
    } else if (projectId && !await env.DB.prepare("SELECT 1 FROM projects WHERE ward_id = ? AND project_id = ? AND (closed_at IS NULL OR project_id = ?)")
      .bind(wardId, projectId, topic.decision?.project_id ?? topic.posts[0]?.projectId ?? "").first()) throw new Error("input");
    if (action === "reference" && !projectId) throw new Error("input");
  }
  const knowId = String(form.get("knowId") ?? "");
  if (action === "know" && !(await listKnowItems(env.DB, wardId)).items.some((item) => item.id === knowId)) throw new Error("input");
  await checkEditable(env.DB, wardId, topic.posts);
  await beforeChange();
  if (newProject) {
    const created = await createProject(env.DB, wardId, { ...newProject, year: new Date().getFullYear(), accountId });
    projectId = created.projectId;
  }
  await saveOfficerDecision(env.DB, wardId, topic.id, summary, action as BundleAction, projectId);
  // 問い合わせの言葉を資料に直した時だけ、既存の受付へ渡す。原文と投稿の印は保つ。
  for (const post of topic.posts) if (!post.jobId && post.text && ["material", "reference", "know"].includes(action)) {
    const outcome = await receive(env, { wardId, projectId, via: post.sourceType === "user" ? "line_direct" : "line_group",
      senderLabel: post.sender, parts: [{ kind: "text", filename: "届いた文.txt", mediaType: "text/plain", bytes: new TextEncoder().encode(post.text) }] });
    const duplicate = outcome.duplicates[0];
    const jobId = outcome.jobId ?? (duplicate ? await env.DB.prepare("SELECT job_id FROM originals WHERE ward_id = ? AND original_id = ? AND withdrawn_at IS NULL")
      .bind(wardId, duplicate.originalId).first<{ job_id: string }>(): null)?.job_id;
    if (!jobId) throw new Error("busy");
    await env.DB.prepare(`INSERT INTO line_inbox_items
      (ward_id, item_id, event_id, job_id, sender_id, sender_display_name, source_type, source_id,
       line_destination, original_kind, original_text, received_at, bundle_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'text', ?, ?, ?)`)
      .bind(wardId, post.id, post.eventId ?? post.id, jobId, post.senderId, post.sender, post.sourceType, post.sourceId,
        post.destination, post.text, post.at, topic.id).run();
    await env.DB.prepare("DELETE FROM line_talk_inquiry_posts WHERE ward_id = ? AND event_id = ?").bind(wardId, post.eventId).run();
    post.jobId = jobId;
    post.itemId = post.id;
    post.originals = (await listOriginals(env.DB, wardId, jobId)).filter((o) => !o.withdrawn_at);
    if (outcome.jobId && action === "material") await setJobProject(env.DB, wardId, jobId, null);
  }
  // 役員画面の資料にも既存の原本の扱いを適用する。受信イベントやLINEの送信先は作らない。
  for (const post of topic.posts) if (post.sourceType === "admin" && post.jobId) await env.DB.prepare(`INSERT INTO line_inbox_items
    (ward_id, item_id, event_id, sender_id, original_kind, received_at, job_id, source_type, bundle_id)
    VALUES (?, ?, ?, '', 'image', ?, ?, 'admin', ?) ON CONFLICT (ward_id, item_id) DO UPDATE SET bundle_id = excluded.bundle_id`)
    .bind(wardId, post.id, post.id, post.at, post.jobId, topic.id).run();
  await move(env, ctx, wardId, topic.posts, action as BundleAction, projectId);
  if (action === "inquiry") await makeInquiry(env.DB, wardId, topic.id, topic.posts);
  for (const post of topic.posts) {
    if (action === "unrelated" && post.itemId && topic.decision?.action !== "unrelated") await markInboxItemUnrelated(env.DB, wardId, post.itemId, true);
    for (const original of post.originals) {
      await env.DB.prepare("DELETE FROM ward_material_links WHERE ward_id = ? AND original_id = ? AND target_kind = 'know_item'")
        .bind(wardId, original.original_id).run();
      if (action === "know") await linkKnowSource(env.DB, wardId, knowId, original.original_id);
    }
  }
  return projectId;
}
