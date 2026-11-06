import { createAnthropic } from "../ai/anthropic";
import { MATCH_NEW, MATCH_UNRELATED, matchProject, type MatchResult } from "../ai/match";
import { projectApi } from "../ai/project-binding";
import { assignProject as assignIntakeProject, receiveOriginal as receiveIntakeOriginal, withdrawJob as withdrawIntakeJob } from "../intake/api";
import type { Waitable } from "../intake/types";
import type { Env } from "../env";
import { addAnswer, getRoster, normalizeHousehold } from "../answers/api";
import { quickCheckPhotos } from "../intake/photo-check";

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
}

export interface InboxMatch {
  disposition: "unmatched" | "matched" | "unrelated";
  projectId?: string;
  projectName?: string;
  reason?: string;
  inquiry?: boolean;
}

export interface LineIntakePorts {
  checkPhoto?: (wardId: string, original: LineOriginal, jobId: string) => Promise<void>;
  receiveOriginal: (wardId: string, original: LineOriginal) => Promise<string | null>;
  matchInboxItem: (wardId: string, original: LineOriginal) => Promise<InboxMatch>;
  assignProject: (wardId: string, jobId: string, projectId: string) => Promise<void>;
  discard: (wardId: string, jobId: string) => Promise<void>;
  saveAnswerReply?: (wardId: string, projectId: string, original: LineOriginal, jobId: string) => Promise<void>;
}

async function saveLineAnswer(db: D1Database, wardId: string, projectId: string, original: LineOriginal, jobId: string): Promise<void> {
  const text = original.text ?? "";
  const roster = await getRoster(db, wardId);
  const matches = roster.filter((entry) => text.includes(entry.household)).sort((a, b) => b.household.length - a.household.length);
  let candidates = matches.filter((entry) => entry.household.length === matches[0]?.household.length);
  const namedDistricts = candidates.filter((entry) => text.includes(entry.district)).sort((a, b) => b.district.length - a.district.length);
  if (namedDistricts.length) candidates = namedDistricts.filter((entry) => entry.district.length === namedDistricts[0]!.district.length);
  // 同名の世帯は、班も使って一つの候補に絞れた時だけ回答に入れる。
  const household = candidates[0];
  if (!household || candidates.some((entry) => entry.district !== household.district || normalizeHousehold(entry.household) !== normalizeHousehold(household.household))) return;
  // 人数だけ文字の幅をそろえる。原本や手伝える時間の文は書き換えない。
  const countText = text.normalize("NFKC");
  const adults = /大人\s*(\d+)\s*人/.exec(countText);
  const children = /子(?:ども|供)\s*(\d+)\s*人/.exec(countText);
  const seniors = /(?:高齢(?:の方|者)?|シニア)\s*(\d+)\s*人/.exec(countText);
  const total = /(?:来場(?:は|が)?\s*)?(\d+)\s*人/.exec(countText);
  const peopleCount = adults || children || seniors ? Number(adults?.[1] ?? 0) + Number(children?.[1] ?? 0) + Number(seniors?.[1] ?? 0) : Number(total?.[1]);
  if (!Number.isInteger(peopleCount) || peopleCount < 0) return;
  const sourceOriginal = await db.prepare("SELECT original_id FROM originals WHERE ward_id = ? AND job_id = ? AND withdrawn_at IS NULL ORDER BY position LIMIT 1")
    .bind(wardId, jobId).first<{ original_id: string }>();
  const helperPhrase = /([^。\n]{1,40}?)(?:なら|は)(?:手伝え|手伝い|手伝)/.exec(text)?.[1]?.trim() ?? "";
  await addAnswer(db, wardId, {
    projectId,
    household: household.household,
    district: household.district,
    peopleCount,
    ...(adults || children || seniors ? { childrenCount: Number(children?.[1] ?? 0), adultsCount: Number(adults?.[1] ?? 0), seniorsCount: Number(seniors?.[1] ?? 0) } : {}),
    ...(helperPhrase ? { helperName: household.household, helperTimes: helperPhrase } : {}),
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
    async checkPhoto(wardId, original, jobId) {
      if (!original.bytes) return;
      await quickCheckPhotos(env, { wardId, via: original.sourceType === "user" ? "line_direct" : "line_group",
        parts: [{ kind: "photo", filename: "LINE の写真", mediaType: original.contentType ?? "application/octet-stream", bytes: new Uint8Array(original.bytes) }] },
      jobId);
    },
    async receiveOriginal(wardId, original) {
      const bytes = original.kind === "text"
        ? new TextEncoder().encode(original.text ?? "")
        : original.bytes ? new Uint8Array(original.bytes) : null;
      if (!bytes) throw new Error("LINE の写真データがありません。");
      const outcome = await receiveIntakeOriginal(env, ctx, {
        wardId,
        via: original.sourceType === "user" ? "line_direct" : "line_group",
        senderLabel: original.senderId,
        parts: [{
          kind: original.kind === "text" ? "text" : "photo",
          filename: original.kind === "text" ? "LINE の文.txt" : "LINE の写真",
          mediaType: original.kind === "text" ? "text/plain; charset=utf-8" : original.contentType ?? "application/octet-stream",
          bytes,
        }],
      });
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
      const open = await projectApi().listOpenProjects(env, wardId);
      const candidates = open.map((project) => ({
        id: project.projectId,
        title: project.title,
        detail: `${project.kind} ${project.year ?? ""}`.trim(),
      }));
      const result = await (match ?? (async (_wardId, item) => matchProject(createAnthropic(env, { maxRetries: 0, timeoutMs: 5000 }), {
        candidates,
        summary: item.kind === "text" ? (item.text ?? "") : "LINE から写真が届きました",
        ...(item.kind === "text" && item.text ? { excerpt: item.text } : {}),
        senderLabel: item.senderDisplayName || item.senderId,
        officialAddressed: item.officialAddressed,
      })))(wardId, original);
      if (original.officialAddressed && result.intent === "inquiry") return { disposition: "unmatched", reason: result.reason, inquiry: true };
      if (result.choice === MATCH_UNRELATED) return { disposition: "unrelated", reason: result.reason };
      if (result.choice === MATCH_NEW) return { disposition: "unmatched", reason: result.reason };
      const project = open.find((candidate) => candidate.projectId === result.choice);
      return project
        ? { disposition: "matched", projectId: project.projectId, projectName: project.title, reason: result.reason }
        : { disposition: "unmatched", reason: result.reason };
    },
  };
}
