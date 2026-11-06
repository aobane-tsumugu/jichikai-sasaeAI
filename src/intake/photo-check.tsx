import { Hint } from "../core/ui";
import type { Env } from "../env";
import { getClient } from "../ai/deps";
import { checkPhoto, type PhotoCheck } from "../ai/photo-check";
import type { ReceiveInput } from "./receive";
import { classifyUpload, sha256Hex } from "./media";

/** 画像の見出しだけを読む。画素の展開や画像処理の依存は足さない。 */
export function imageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const size = (width: number, height: number) => width > 0 && height > 0 ? { width, height } : null;
  if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50) return size(view.getUint32(16), view.getUint32(20));
  if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49) return size(view.getUint16(6, true), view.getUint16(8, true));
  if (bytes.length >= 30 && bytes[0] === 0x52 && bytes[8] === 0x57) {
    const tag = String.fromCharCode(...bytes.subarray(12, 16));
    if (tag === "VP8X") return size(1 + (view.getUint32(24, true) & 0xffffff), 1 + ((view.getUint32(26, true) >>> 8) & 0xffffff));
    if (tag === "VP8 ") return size(view.getUint16(26, true) & 0x3fff, view.getUint16(28, true) & 0x3fff);
    if (tag === "VP8L" && bytes[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      return size(1 + (bits & 0x3fff), 1 + ((bits >>> 14) & 0x3fff));
    }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2;
    while (offset + 4 < bytes.length) {
      if (bytes[offset] !== 0xff) break;
      const marker = bytes[offset + 1]!;
      if (marker === 0xff) { offset++; continue; }
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
      const length = view.getUint16(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && length >= 7) {
        return size(view.getUint16(offset + 7), view.getUint16(offset + 5));
      }
      offset += length + 2;
    }
  }
  return null;
}

export interface StoredPhotoCheck extends PhotoCheck {
  original_id: string;
  job_id: string;
  width: number | null;
  height: number | null;
}

export async function quickCheckPhotos(env: Env, input: ReceiveInput, jobId: string): Promise<void> {
  const originals = await env.DB.prepare("SELECT original_id, content_hash, media_type FROM originals WHERE ward_id = ? AND job_id = ? AND withdrawn_at IS NULL ORDER BY position")
    .bind(input.wardId, jobId).all<{ original_id: string; content_hash: string; media_type: string }>();
  const parts = await Promise.all(input.parts.filter((part) => classifyUpload(part.bytes, part.mediaType, part.filename)?.mediaClass === "image")
    .map(async (part) => ({ part, hash: await sha256Hex(part.bytes) })));
  // 全体で数秒に収める。確認が間に合わなければ通常の読み取りへ任せる。
  await Promise.all(originals.results.map(async (original) => {
    if (!original.media_type.startsWith("image/")) return;
    const part = parts.find((candidate) => candidate.hash === original.content_hash)?.part;
    if (!part) return;
    const dimensions = imageDimensions(part.bytes);
    let check: PhotoCheck = { readability: "unknown", paperKind: "other", reason: "other" };
    if (dimensions && Math.min(dimensions.width, dimensions.height) < 480) check = { readability: "unreadable", paperKind: "other", reason: "small" };
    else if (dimensions && part.bytes.length <= 5 * 1024 * 1024) {
      try {
        check = await checkPhoto(getClient(env), part.bytes, original.media_type as "image/jpeg" | "image/png" | "image/gif" | "image/webp");
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
  return rows.results;
}

export function photoCheckMessage(check: PhotoCheck): string {
  if (check.readability === "unknown") return "写真は預かっています。読み取れた分から進めます。";
  if (check.readability === "readable") return "文字は読めそうです。";
  return ({ dark: "暗くて読めません", blurred: "ぶれていて読めません", cut: "紙の一部が切れていて読めません", small: "写真が小さくて読めません", other: "読めないところがあります" })[check.reason];
}

const PAPER_LABEL: Record<PhotoCheck["paperKind"], string> = {
  announcement: "案内", roster: "名簿", sponsors: "協賛先の一覧", receipt: "領収書", layout: "配置図", rota: "当番表", report: "報告", notice: "通知", memo: "メモ", answer_sheet: "回答票", photo: "写真", other: "紙の種類はまだ分かりません",
};

export function PhotoCheckNotice({ checks, retakeHref, continueHref }: { checks: StoredPhotoCheck[]; retakeHref: string; continueHref: string }) {
  if (!checks.length) return null;
  const needsRetake = checks.some((check) => check.readability === "unreadable" || check.readability === "partial");
  return <section class="panel" role="status"><h2>写真を受け取りました</h2><p class="lead">読めたかどうかを先に確かめています。撮り直さなくても、読み取れた分から進みます。</p>
    {checks.map((check, index) => <p>{checks.length > 1 ? `${index + 1}枚目: ` : ""}{photoCheckMessage(check)}{check.paperKind !== "other" ? ` ${PAPER_LABEL[check.paperKind]}のようです。` : ""}</p>)}
    {needsRetake ? <><p>明るい場所で、紙の全体が入るように撮れますか。</p><section class="next"><strong>次は</strong><p>もう一度撮ってください。撮れないときは、このままでかまいません。</p><a class="button" href={retakeHref}>撮り直す</a> <a class="quiet" href={continueHref}>このままにする</a></section></> : null}
  </section>;
}
