import { createAnthropic } from "../ai/anthropic";
import { MATCH_NEW, MATCH_UNRELATED, matchProject, type MatchResult } from "../ai/match";
import { projectApi } from "../ai/project-binding";
import { assignProject as assignIntakeProject, receiveOriginal as receiveIntakeOriginal, withdrawJob as withdrawIntakeJob } from "../intake/api";
import type { Waitable } from "../intake/types";
import type { Env } from "../env";
import { addAnswer, getRoster } from "../answers/api";
import { meetingAnswerFromLine } from "../answers/meeting";
import { quickCheckPhotos } from "../intake/photo-check";
import { receive, type ReceiveInput } from "../intake/receive";
import { runRead } from "../intake/pipeline";
import { canStartJobAi, getWardAiLimits, recordAiMatchUsage } from "../ops/metrics";
import { sha256Hex } from "../intake/media";
import { WardBucket } from "../core/storage";
import { recordLineInquiry } from "../project/followup";

/** 当てるAIが出欠の答えと判断した文から、人数を読む。 */
export const LINE_ANSWER_PACK = { version: "line-answer@2", notAttending: /参加しません|参加しない|不参加|欠席/ } as const;

export interface LineOriginal {
  eventId: string;
  senderId: string;
  senderDisplayName?: string | null;
  sourceType: "user" | "group" | "room";
  receivedAt: string;
  kind: "text" | "image";
  text?: string;
  bytes?: ArrayBuffer;
  contentType?: string;
  officialAddressed?: boolean;
  aiLimitReason?: "monthly" | "sender";
}

/** 既存の受信記録を使って一回だけ数える。文の雑談判定で原本を消しても数は残る。 */
export async function lineAiLimitReason(db: D1Database, wardId: string, eventId: string, senderId: string, now: Date): Promise<LineOriginal["aiLimitReason"]> {
  const limits = await getWardAiLimits(db, wardId, now);
  const day = new Date(now.getTime() + 9 * 3600_000).toISOString().slice(0, 10);
  const sender = await sha256Hex(senderId);
  // このUPDATE一つで順番を決め、同時に届いても上限より多くAIへ通さない。
  await db.prepare(`UPDATE line_webhook_receipts SET sender_hash = ?, sender_day = ?, sender_admitted = CASE
    WHEN ? = 0 OR (SELECT COUNT(*) FROM line_webhook_receipts r WHERE r.ward_id = ?
      AND r.sender_hash = ? AND r.sender_day = ? AND r.sender_admitted = 1) < ? THEN 1 ELSE 0 END
    WHERE ward_id = ? AND event_id = ? AND sender_admitted IS NULL`)
    .bind(sender, day, limits.lineSenderDailyLimit, wardId, sender, day, limits.lineSenderDailyLimit, wardId, eventId).run();
  const receipt = await db.prepare("SELECT sender_admitted FROM line_webhook_receipts WHERE ward_id = ? AND event_id = ?")
    .bind(wardId, eventId).first<{ sender_admitted: number }>();
  return receipt?.sender_admitted === 0 ? "sender" : limits.monthlyBlocked ? "monthly" : undefined;
}

/** 月の上限で預かった文を、元の文のままいつもの当て先・出欠・問い合わせの道へ戻す。 */
export async function resumeLimitedLineText(env: Env, wardId: string, jobId: string): Promise<boolean> {
  const item = await env.DB.prepare(`SELECT i.event_id, i.sender_id, i.sender_display_name, i.source_type, i.source_id,
    i.received_at, i.official_addressed, o.r2_path FROM line_inbox_items i JOIN originals o
    ON o.ward_id = i.ward_id AND o.job_id = i.job_id WHERE i.ward_id = ? AND i.job_id = ?
    AND i.original_kind = 'text' AND o.withdrawn_at IS NULL ORDER BY o.position LIMIT 1`)
    .bind(wardId, jobId).first<{ event_id: string; sender_id: string; sender_display_name: string | null;
      source_type: LineOriginal["sourceType"]; source_id: string; received_at: string; official_addressed: number; r2_path: string }>();
  if (!item) return false;
  if (!await canStartJobAi(env.DB, wardId, jobId)) return true;
  const object = await new WardBucket(env.ORIGINALS, wardId).get(item.r2_path);
  if (!object) return false;
  const original: LineOriginal = { eventId: item.event_id, senderId: item.sender_id, senderDisplayName: item.sender_display_name,
    sourceType: item.source_type, receivedAt: item.received_at, kind: "text", text: await object.text(), officialAddressed: item.official_addressed === 1 };
  const pending: Promise<unknown>[] = [];
  const ports = createLineIntakePorts(env, { waitUntil: (promise) => { pending.push(promise); } });
  const result = await ports.matchInboxItem(wardId, original);
  if (result.disposition === "unrelated") {
    await ports.discard(wardId, jobId);
    await markInboxItemUnrelated(env.DB, wardId, jobId);
  } else if (original.officialAddressed && result.attendanceAnswer !== true && result.inquiry) {
    await recordLineInquiry(env.DB, wardId, { eventId: item.event_id, receivedAt: item.received_at, text: original.text ?? "",
      sourceType: item.source_type, sourceId: item.source_id, userId: item.sender_id, senderLabel: item.sender_display_name });
    await env.DB.prepare("UPDATE jobs SET status = 'done', finished_at = ? WHERE ward_id = ? AND job_id = ? AND status = 'read'")
      .bind(new Date().toISOString(), wardId, jobId).run();
  } else if (result.disposition === "matched" && result.projectId) {
    if (result.attendanceAnswer) await ports.saveAnswerReply?.(wardId, result.projectId, original, jobId);
    await ports.assignProject(wardId, jobId, result.projectId);
  } else {
    await env.DB.prepare("UPDATE line_inbox_items SET match_reason = ? WHERE ward_id = ? AND job_id = ?")
      .bind(result.reason ?? null, wardId, jobId).run();
  }
  await Promise.all(pending);
  return true;
}

export interface InboxMatch {
  disposition: "unmatched" | "matched" | "unrelated";
  projectId?: string;
  projectName?: string;
  reason?: string;
  inquiry?: boolean;
  attendanceAnswer?: boolean;
}

export interface LineIntakePorts {
  readPhoto?: (wardId: string, jobId: string) => Promise<unknown>;
  checkPhoto?: (wardId: string, original: LineOriginal, jobId: string) => Promise<void>;
  receiveOriginal: (wardId: string, original: LineOriginal) => Promise<string | null>;
  matchInboxItem: (wardId: string, original: LineOriginal) => Promise<InboxMatch>;
  assignProject: (wardId: string, jobId: string, projectId: string) => Promise<void>;
  discard: (wardId: string, jobId: string) => Promise<void>;
  saveAnswerReply?: (wardId: string, projectId: string, original: LineOriginal, jobId: string) => Promise<void>;
}

async function saveLineAnswer(db: D1Database, wardId: string, projectId: string, original: LineOriginal, jobId: string): Promise<void> {
  const text = original.text ?? "";
  const project = await db.prepare("SELECT kind FROM projects WHERE ward_id = ? AND project_id = ? AND closed_at IS NULL")
    .bind(wardId, projectId).first<{ kind: string }>();
  if (!project) return;
  const meeting = project.kind === "general_meeting";
  const meetingAnswer = meeting ? meetingAnswerFromLine(text) : null;
  if (meeting && !meetingAnswer) return;
  const statedName = (meeting
    ? /^\s*([^、。\n]{1,120}?)(?:です(?=[\s、。\n]|$)|家(?=[はがも\s、。:：\n]|$))/
    : /^\s*([^\s、。\n]{1,40}?)(?:です(?=[\s、。\n]|$)|家(?=[はがも\s、。:：\n]|$))/).exec(text)?.[1]?.trim();
  const roster = await getRoster(db, wardId);
  // 総会で名乗っているときは、委任する相手を答えた世帯として拾わない。
  const identityText = meeting && statedName ? statedName : text;
  const matches = roster.filter((entry) => identityText.includes(entry.household)).sort((a, b) => b.household.length - a.household.length);
  let candidates = matches.filter((entry) => entry.household.length === matches[0]?.household.length);
  const namedDistricts = candidates.filter((entry) => text.includes(entry.district)).sort((a, b) => b.district.length - a.district.length);
  if (namedDistricts.length) candidates = namedDistricts.filter((entry) => entry.district.length === namedDistricts[0]!.district.length);
  // 一つに決まらない世帯は、書かれた名前のまま班を空にして数える。
  const household = candidates.length === 1 ? candidates[0] : undefined;
  // 人数だけ文字の幅をそろえる。原本や手伝える時間の文は書き換えない。
  const countText = text.normalize("NFKC");
  const notAttending = LINE_ANSWER_PACK.notAttending.test(countText);
  const adults = /大人\s*(\d+)\s*人/.exec(countText);
  const children = /子(?:ども|供)\s*(\d+)\s*人/.exec(countText);
  const seniors = /(?:高齢(?:の方|者)?|シニア)\s*(\d+)\s*人/.exec(countText);
  const total = /(?:来場(?:は|が)?\s*)?(\d+)\s*人/.exec(countText);
  const peopleCount = notAttending ? 0 : adults || children || seniors ? Number(adults?.[1] ?? 0) + Number(children?.[1] ?? 0) + Number(seniors?.[1] ?? 0) : Number(total?.[1]);
  if (!meeting && (!Number.isInteger(peopleCount) || peopleCount < 0)) return;
  const sourceOriginal = await db.prepare("SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ? AND withdrawn_at IS NULL ORDER BY position LIMIT 1")
    .bind(wardId, jobId).first<{ original_id: string }>();
  const helperPhrase = /([^。\n]{1,40}?)(?:なら|は)(?:手伝え|手伝い|手伝)/.exec(text)?.[1]?.trim() ?? "";
  // 「大人1人です」のように、人数だけを述べた文を名前として扱わない。
  const nameIsCount = statedName !== undefined && ([adults, children, seniors, total]
    .some((count) => count?.[0] === statedName.normalize("NFKC")) || (meeting && /^(?:出席|欠席|委任)$/.test(statedName)));
  const name = household?.household ?? (statedName && !nameIsCount ? statedName : matches[0]?.household ?? "名前の分からない答え");
  if (meetingAnswer) {
    await addAnswer(db, wardId, {
      projectId, household: name, district: household?.district ?? "", peopleCount: 0,
      ...meetingAnswer, source: "line", ...(sourceOriginal ? { originalId: sourceOriginal.original_id } : {}),
    });
    return;
  }
  await addAnswer(db, wardId, {
    projectId,
    household: name,
    district: household?.district ?? "",
    peopleCount,
    ...(notAttending ? { childrenCount: 0, adultsCount: 0, seniorsCount: 0 } : adults || children || seniors ? { childrenCount: Number(children?.[1] ?? 0), adultsCount: Number(adults?.[1] ?? 0), seniorsCount: Number(seniors?.[1] ?? 0) } : {}),
    ...(helperPhrase ? { helperName: name, helperTimes: helperPhrase } : {}),
    source: "line",
    ...(sourceOriginal ? { originalId: sourceOriginal.original_id } : {}),
  });
}

/** 役員が関係ない物として消した時、受け箱から外して日ごとの数だけ残す。原本は呼び出し側で取り下げる。 */
export async function markInboxItemUnrelated(db: D1Database, wardId: string, itemId: string): Promise<void> {
  const item = await db.prepare("SELECT received_at FROM line_inbox_items WHERE ward_id = ? AND item_id = ?")
    .bind(wardId, itemId).first<{ received_at: string }>();
  if (!item) return;
  await db.prepare(`INSERT INTO line_unrelated_daily_counts (ward_id, day, item_count)
    VALUES (?, ?, 1) ON CONFLICT (ward_id, day) DO UPDATE SET item_count = item_count + 1`)
    .bind(wardId, item.received_at.slice(0, 10)).run();
  await db.prepare("DELETE FROM line_inbox_items WHERE ward_id = ? AND item_id = ?").bind(wardId, itemId).run();
}

/** LINE の本文と写真を束 2 の受け口へ渡し、開いているプロジェクトの候補から当て先を選ぶ。 */
export function createLineIntakePorts(
  env: Env,
  ctx: Waitable,
  match?: (wardId: string, original: LineOriginal) => Promise<MatchResult>,
): LineIntakePorts {
  return {
    readPhoto: (wardId, jobId) => runRead(env, wardId, jobId),
    async checkPhoto(wardId, original, jobId) {
      if (!original.bytes) return;
      if ((await getWardAiLimits(env.DB, wardId)).monthlyBlocked || original.aiLimitReason) return;
      await quickCheckPhotos(env, { wardId, via: original.sourceType === "user" ? "line_direct" : "line_group",
        parts: [{ kind: "photo", filename: "LINEの写真", mediaType: original.contentType ?? "application/octet-stream", bytes: new Uint8Array(original.bytes) }] },
      jobId);
    },
    async receiveOriginal(wardId, original) {
      const bytes = original.kind === "text"
        ? new TextEncoder().encode(original.text ?? "")
        : original.bytes ? new Uint8Array(original.bytes) : null;
      if (!bytes) throw new Error("LINEの写真データがありません。");
      // 写真は共通の受付で2400pxのJPEGに整えて保管する。受領を返したあと、その写真を読む。
      const input: ReceiveInput = {
        wardId,
        via: original.sourceType === "user" ? "line_direct" : "line_group",
        senderLabel: original.senderId,
        parts: [{
          kind: original.kind === "text" ? "text" : "photo",
          filename: original.kind === "text" ? "LINEの文.txt" : "LINEの写真",
          mediaType: original.kind === "text" ? "text/plain; charset=utf-8" : original.contentType ?? "application/octet-stream",
          bytes,
        }],
      };
      const outcome = original.kind === "image" || original.aiLimitReason ? await receive(env, input) : await receiveIntakeOriginal(env, ctx, input);
      if (outcome.jobId && original.aiLimitReason) await env.DB.prepare(`UPDATE jobs SET ai_limit_reason = ?,
        status = 'received', read_at = NULL WHERE ward_id = ? AND job_id = ?`)
        .bind(original.aiLimitReason, wardId, outcome.jobId).run();
      return outcome.jobId;
    },
    async assignProject(wardId, jobId, projectId) {
      await assignIntakeProject(env, ctx, wardId, jobId, projectId);
    },
    async discard(wardId, jobId) {
      await withdrawIntakeJob(env, wardId, jobId);
    },
    async saveAnswerReply(wardId, projectId, original, jobId) {
      if (original.kind === "text") await saveLineAnswer(env.DB, wardId, projectId, original, jobId);
    },
    async matchInboxItem(wardId, original) {
      if (original.aiLimitReason || (await getWardAiLimits(env.DB, wardId)).monthlyBlocked) return { disposition: "unmatched" };
      const open = await projectApi().listOpenProjects(env, wardId);
      const candidates = open.map((project) => ({
        id: project.projectId,
        title: project.title,
        detail: `${project.kind} ${project.year ?? ""}`.trim(),
      }));
      const result = await (match ?? (async (_wardId, item) => matchProject(createAnthropic(env, { maxRetries: 0, timeoutMs: 5000 }), {
        candidates,
        summary: item.kind === "text" ? (item.text ?? "") : "LINEから写真が届きました",
        ...(item.kind === "text" && item.text ? { excerpt: item.text } : {}),
        senderLabel: item.senderDisplayName || item.senderId,
        officialAddressed: item.officialAddressed,
      })))(wardId, original);
      await recordAiMatchUsage(env.DB, wardId, result.usage);
      if (result.choice === MATCH_UNRELATED) return { disposition: original.kind === "text" ? "unrelated" : "unmatched", reason: result.reason, inquiry: false };
      // 出欠の答えは、一対一でも問い合わせに回さず数える。
      if (original.officialAddressed && result.attendanceAnswer !== true && result.intent === "inquiry") return { disposition: "unmatched", reason: result.reason, inquiry: true };
      if (result.choice === MATCH_NEW) return { disposition: "unmatched", reason: result.reason, inquiry: false };
      const project = open.find((candidate) => candidate.projectId === result.choice);
      return project
        ? { disposition: "matched", projectId: project.projectId, projectName: project.title, reason: result.reason, inquiry: false, attendanceAnswer: result.attendanceAnswer === true }
        : { disposition: "unmatched", reason: result.reason, inquiry: false };
    },
  };
}
