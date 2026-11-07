import type { Env } from "../env";
import type { MatchResult } from "../ai/match";
import { officerGroupId } from "./api";
import { getReadings } from "../intake/store";
import { applyWardReading } from "../know/apply";

export type BundleAction = "material" | "reference" | "inquiry" | "know" | "unrelated" | "confirm_share" | "confirm_purpose";
export interface BundleDecision {
  bundle_id: string;
  summary: string;
  action: BundleAction;
  project_id: string | null;
  decided_by: "ai" | "officer";
  clarification_id: string | null;
  decided_at: string | null;
}

export const PURPOSE_QUESTION = "参考にする資料ですか、この準備の資料ですか";
export const SHARE_QUESTION = "住民に知らせますか";
export const isPurposeQuestion = (text: string) => text === PURPOSE_QUESTION || text === SHARE_QUESTION;

/** 一対一の利用者IDから役員を推測しない。 */
export async function isOfficerSource(env: Env, wardId: string, sourceType: string, sourceId: string): Promise<boolean> {
  return sourceType === "group" && sourceId === await officerGroupId(env, wardId);
}

export function getBundleDecision(db: D1Database, wardId: string, bundleId: string): Promise<BundleDecision | null> {
  return db.prepare("SELECT * FROM line_bundle_decisions WHERE ward_id = ? AND bundle_id = ?")
    .bind(wardId, bundleId).first<BundleDecision>();
}

/** 受信直後は今年の中身に入れず、同じ人が添える言葉を待つ。 */
export async function holdOfficerBundle(db: D1Database, wardId: string, bundleId: string, now: Date): Promise<void> {
  await db.prepare(`INSERT INTO line_bundle_decisions
    (ward_id, bundle_id, summary, action, project_id, decided_by, created_at, updated_at)
    VALUES (?, ?, ?, 'confirm_purpose', NULL, 'ai', ?, ?)
    ON CONFLICT (ward_id, bundle_id) DO UPDATE SET action = 'confirm_purpose', decided_at = NULL,
      updated_at = excluded.updated_at
    WHERE line_bundle_decisions.decided_by = 'ai' AND line_bundle_decisions.action = 'material'`)
    .bind(wardId, bundleId, "写真と言葉を確認しています。", now.toISOString(), now.toISOString()).run();
}

export function bundleAction(result: MatchResult): BundleAction {
  if (result.intent === "reference") return "reference";
  if (result.intent === "share") return "confirm_share";
  if (result.intent === "purpose_uncertain" || !result.intent) return "confirm_purpose";
  if (result.intent === "inquiry") return "inquiry";
  return "material";
}

/** 人の直しを条件付き更新で守る。返すのも保存された判断。 */
export async function saveAiBundleDecision(db: D1Database, wardId: string, bundleId: string,
  summary: string, action: BundleAction, projectId: string | null, now: Date): Promise<BundleDecision> {
  await db.prepare(`INSERT INTO line_bundle_decisions
    (ward_id, bundle_id, summary, action, project_id, decided_by, created_at, updated_at, decided_at)
    VALUES (?, ?, ?, ?, ?, 'ai', ?, ?, ?)
    ON CONFLICT (ward_id, bundle_id) DO UPDATE SET summary = excluded.summary, action = excluded.action,
      project_id = excluded.project_id, updated_at = excluded.updated_at, decided_at = excluded.decided_at
    WHERE line_bundle_decisions.decided_by = 'ai'`)
    .bind(wardId, bundleId, summary, action, projectId, now.toISOString(), now.toISOString(), now.toISOString()).run();
  const saved = await getBundleDecision(db, wardId, bundleId);
  if (!saved) throw new Error("写真と言葉の判断を保存できませんでした");
  return saved;
}

export async function jobBundleDecision(db: D1Database, wardId: string, jobId: string): Promise<BundleDecision | null> {
  return db.prepare(`SELECT d.* FROM line_bundle_decisions d JOIN line_inbox_items i
    ON i.ward_id = d.ward_id AND i.bundle_id = d.bundle_id WHERE d.ward_id = ? AND i.job_id = ?
    AND NOT (COALESCE(i.source_type, '') = 'admin' AND d.action = 'material')
    AND (d.decided_by = 'officer' OR d.action = 'inquiry' OR EXISTS (SELECT 1 FROM ward_settings s
      WHERE s.ward_id = i.ward_id AND s.key = 'line.officer_group' AND s.value = i.source_id AND i.source_type = 'group')) LIMIT 1`)
    .bind(wardId, jobId).first<BundleDecision>();
}

/** 元の読み取りは残し、参考や確かめ待ちから基本情報・一年の予定を取り込まない。 */
export async function applyLineWardReading(db: D1Database, wardId: string, jobId: string): Promise<void> {
  const decision = await jobBundleDecision(db, wardId, jobId);
  if (decision && (decision.action !== "material" || !decision.decided_at)) return;
  for (const reading of await getReadings(db, wardId, jobId)) await applyWardReading(db, wardId, reading.body);
}

/** 再処理で以前の道から足された予定も、元の資料が同じものだけ外す。 */
export async function removeReferenceYearItems(db: D1Database, wardId: string): Promise<void> {
  await db.prepare(`DELETE FROM ward_year_items WHERE ward_id = ? AND added = 1 AND removed_at IS NULL
    AND source_original_id IN (SELECT o.original_id FROM originals o JOIN line_inbox_items i
      ON i.ward_id = o.ward_id AND i.job_id = o.job_id JOIN line_bundle_decisions d
      ON d.ward_id = i.ward_id AND d.bundle_id = i.bundle_id WHERE o.ward_id = ?
      AND d.action IN ('reference', 'confirm_share', 'confirm_purpose') AND o.withdrawn_at IS NULL)`)
    .bind(wardId, wardId).run();
}

/** 写真の当て先と同じ質問の保存先を使い、一つのまとまりに一問だけ置く。 */
export async function ensureBundleQuestion(db: D1Database, wardId: string, decision: BundleDecision): Promise<void> {
  if (decision.action !== "confirm_purpose" && decision.action !== "confirm_share") return;
  if (decision.clarification_id) return;
  const photo = await db.prepare(`SELECT p.batch_id, p.job_id, o.original_id FROM line_inbox_items i
    JOIN line_photo_items p ON p.ward_id = i.ward_id AND p.job_id = i.job_id
    JOIN originals o ON o.ward_id = i.ward_id AND o.job_id = i.job_id
    WHERE i.ward_id = ? AND i.bundle_id = ? AND i.original_kind = 'image' AND o.withdrawn_at IS NULL
    ORDER BY i.received_at, i.event_id, o.position LIMIT 1`)
    .bind(wardId, decision.bundle_id).first<{ batch_id: string; job_id: string; original_id: string }>();
  if (!photo) return;
  const id = `purpose:${decision.bundle_id}`;
  const text = decision.action === "confirm_share" ? SHARE_QUESTION : PURPOSE_QUESTION;
  const options = decision.action === "confirm_share" ? ["知らせる", "今回は知らせない"] : ["参考資料", "この準備の資料"];
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO line_clarifications
      (ward_id, clarification_id, batch_id, job_id, original_id, topic, text, options)
      VALUES (?, ?, ?, ?, ?, 'project', ?, ?)`)
      .bind(wardId, id, photo.batch_id, photo.job_id, photo.original_id, text, JSON.stringify(options)),
    db.prepare(`UPDATE line_bundle_decisions SET clarification_id = ? WHERE ward_id = ? AND bundle_id = ?
      AND clarification_id IS NULL AND action = ?`)
      .bind(id, wardId, decision.bundle_id, decision.action),
  ]);
}
