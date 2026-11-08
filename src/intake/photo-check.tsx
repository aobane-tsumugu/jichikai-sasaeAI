import { Hint } from "../core/ui";
import type { Env } from "../env";
import { getClient } from "../ai/deps";
import { checkPhoto, type PhotoCheck } from "../ai/photo-check";
import type { ReceiveInput } from "./receive";
import { WardBucket } from "../core/storage";
import { getReadings } from "./store";
import { imageDimensions } from "./photo";
export { imageDimensions } from "./photo";

export interface StoredPhotoCheck extends PhotoCheck {
  original_id: string;
  job_id: string;
  width: number | null;
  height: number | null;
}

export async function quickCheckPhotos(env: Env, input: ReceiveInput, jobId: string): Promise<void> {
  const originals = await env.DB.prepare("SELECT original_id, r2_path, media_type FROM originals WHERE ward_id = ? AND job_id = ? AND withdrawn_at IS NULL ORDER BY position")
    .bind(input.wardId, jobId).all<{ original_id: string; r2_path: string | null; media_type: string }>();
  const bucket = new WardBucket(env.ORIGINALS, input.wardId);
  // 全体で数秒に収める。確認が間に合わなければ通常の読み取りへ任せる。
  await Promise.all(originals.results.map(async (original) => {
    if (!original.media_type.startsWith("image/")) return;
    const object = original.r2_path ? await bucket.get(original.r2_path) : null;
    if (!object) return;
    const bytes = new Uint8Array(await object.arrayBuffer());
    const mediaType = original.media_type;
    const dimensions = imageDimensions(bytes);
    let check: PhotoCheck = { readability: "unknown", paperKind: "other", reason: "other" };
    if (object.customMetadata?.photoResizeFailed === "1") check = { readability: "unreadable", paperKind: "other", reason: "other" };
    else if (dimensions && Math.min(dimensions.width, dimensions.height) < 480) check = { readability: "unreadable", paperKind: "other", reason: "small" };
    else if (dimensions && bytes.length <= 5 * 1024 * 1024) {
      try {
        check = await checkPhoto(getClient(env), bytes, mediaType as "image/jpeg" | "image/png" | "image/gif" | "image/webp");
      } catch { /* 受け取った原本と通常の読み取りは残す。 */ }
    }
    await env.DB.prepare(`INSERT OR IGNORE INTO intake_photo_checks (ward_id, original_id, job_id, width, height, readability, paper_kind, reason)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(input.wardId, original.original_id, jobId, dimensions?.width ?? null, dimensions?.height ?? null, check.readability, check.paperKind, check.reason).run();
  }));
}

export async function photoChecks(db: D1Database, wardId: string, jobId: string): Promise<StoredPhotoCheck[]> {
  const rows = await db.prepare(`SELECT c.original_id, c.job_id, c.width, c.height, c.readability, c.paper_kind AS paperKind, c.reason
    FROM intake_photo_checks c JOIN originals o ON o.ward_id = c.ward_id AND o.original_id = c.original_id
    WHERE c.ward_id = ? AND c.job_id = ? AND o.withdrawn_at IS NULL ORDER BY o.position`).bind(wardId, jobId).all<StoredPhotoCheck>();
  const checks = rows.results;
  const unreadable = (await getReadings(db, wardId, jobId)).flatMap((reading) => reading.body.unreadable);
  for (const item of unreadable) {
    const check = checks.find((entry) => entry.original_id === item.original_id);
    if (check) { check.readability = "unreadable"; check.reason = "other"; }
    else checks.push({ original_id: item.original_id, job_id: jobId, width: null, height: null,
      readability: "unreadable", paperKind: "other", reason: "other" });
  }
  return checks;
}

export function photoCheckMessage(check: PhotoCheck): string {
  if (check.readability === "unknown") return "写真は預かっています。読み取れた分から進めます。";
  if (check.readability === "readable") return "文字は読めそうです。";
  return ({ dark: "暗くて読めません", blurred: "ぶれていて読めません", cut: "紙の一部が切れていて読めません", small: "写真が小さくて読めません", other: "読めないところがあります" })[check.reason];
}

const PAPER_LABEL: Record<PhotoCheck["paperKind"], string> = {
  announcement: "案内", roster: "名簿", sponsors: "協賛先の一覧", receipt: "領収書", layout: "配置図", rota: "当番表", report: "報告", notice: "通知", memo: "メモ", answer_sheet: "回答票", rules: "規約", meeting_papers: "総会の資料", year_plan: "年間の予定", officers: "役員の一覧", photo: "写真", other: "紙の種類はまだ分かりません",
};

export function PhotoCheckNotice({ checks, retakeHref, continueHref, read = false }: { checks: StoredPhotoCheck[]; retakeHref: string; continueHref: string; read?: boolean }) {
  if (!checks.length) return null;
  const needsRetake = checks.some((check) => check.readability === "unreadable" || check.readability === "partial");
  // 読み終わったあとは「確かめています」と書き続けない。読みにくい所がある時だけ、撮り直すかを聞く。
  if (read && !needsRetake) return null;
  return <section class="panel" role="status"><h2>{read ? "読み取りにくい写真がありました" : "写真を受け取りました"}</h2><p class="lead">{read ? "撮り直さなくても、読み取れた分から進みます。" : "読めたかどうかを先に確かめています。撮り直さなくても、読み取れた分から進みます。"}</p>
    {checks.map((check, index) => <p>{checks.length > 1 ? `${index + 1}枚目: ` : ""}{photoCheckMessage(check)}{check.paperKind !== "other" ? ` ${PAPER_LABEL[check.paperKind]}のようです。` : ""}</p>)}
    {needsRetake ? <><p>明るい場所で、紙の全体が入るように撮れますか。</p><div class="action-links"><a class="button secondary" href={retakeHref}>撮り直す</a><a class="quiet" href={continueHref}>このままにする</a></div></> : null}
  </section>;
}
