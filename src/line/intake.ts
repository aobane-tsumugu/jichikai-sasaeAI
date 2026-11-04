import { createAnthropic } from "../ai/anthropic";
import { MATCH_NEW, MATCH_UNRELATED, matchProject, type MatchResult } from "../ai/match";
import { projectApi } from "../ai/project-binding";
import { assignProject as assignIntakeProject, receiveOriginal as receiveIntakeOriginal, withdrawJob as withdrawIntakeJob } from "../intake/api";
import type { Waitable } from "../intake/types";
import type { Env } from "../env";

export interface LineOriginal {
  eventId: string;
  senderId: string;
  sourceType: "user" | "group" | "room";
  receivedAt: string;
  kind: "text" | "image";
  text?: string;
  bytes?: ArrayBuffer;
  contentType?: string;
}

export interface InboxMatch {
  disposition: "unmatched" | "matched" | "unrelated";
  projectId?: string;
  projectName?: string;
  reason?: string;
}

export interface LineIntakePorts {
  receiveOriginal: (wardId: string, original: LineOriginal) => Promise<string | null>;
  matchInboxItem: (wardId: string, original: LineOriginal) => Promise<InboxMatch>;
  assignProject: (wardId: string, jobId: string, projectId: string) => Promise<void>;
  discard: (wardId: string, jobId: string) => Promise<void>;
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
    async matchInboxItem(wardId, original) {
      const open = await projectApi().listOpenProjects(env, wardId);
      const candidates = open.map((project) => ({
        id: project.projectId,
        title: project.title,
        detail: `${project.kind} ${project.year ?? ""}`.trim(),
      }));
      const result = await (match ?? (async (_wardId, item) => matchProject(createAnthropic(env), {
        candidates,
        summary: item.kind === "text" ? (item.text ?? "") : "LINE から写真が届きました",
        ...(item.kind === "text" && item.text ? { excerpt: item.text } : {}),
        senderLabel: item.senderId,
      })))(wardId, original);
      if (result.choice === MATCH_UNRELATED) return { disposition: "unrelated", reason: result.reason };
      if (result.choice === MATCH_NEW) return { disposition: "unmatched", reason: result.reason };
      const project = open.find((candidate) => candidate.projectId === result.choice);
      return project
        ? { disposition: "matched", projectId: project.projectId, projectName: project.title, reason: result.reason }
        : { disposition: "unmatched", reason: result.reason };
    },
  };
}
