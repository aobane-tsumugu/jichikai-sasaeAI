import type { NoticeFlyer } from "../draft/notice-flyers";
import { plainText, withoutPending } from "../project/document-body";

export function getNoticeFlyer(db: D1Database, wardId: string, versionId: string): Promise<NoticeFlyer | null> {
  return db.prepare("SELECT * FROM notice_flyers WHERE ward_id = ? AND version_id = ?")
    .bind(wardId, versionId).first<NoticeFlyer>();
}

export function noticeFlyerPath(slug: string, versionId: string, flyerId: string, preview = false): string {
  return `/${encodeURIComponent(slug)}/flyers/${encodeURIComponent(versionId)}/${encodeURIComponent(flyerId)}/${preview ? "preview" : "image"}.jpg`;
}

/** 日時・場所は保存した文と文書の欄から読む。画像や現在のプロジェクトの項目から推測しない。 */
export function noticeLineText(title: string, body: string, url: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch { parsed = { text: body }; }
  const value = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as { text?: unknown; items?: unknown } : {};
  const text = withoutPending(plainText(typeof value.text === "string" ? value.text : ""));
  const items = Array.isArray(value.items) ? value.items : [];
  const read = (key: string, labels: string) => {
    const labelled = text.match(new RegExp(`(?:^|\\n)(?:${labels})[：: \\t]+([^\\n]+)`))?.[1]?.trim();
    if (labelled) return labelled;
    // 本文に見出しがなければ、住民のページでも読む保存済みの文書の欄を使う。
    for (const item of items) {
      if (item && typeof item === "object" && "key" in item && item.key === key && "content" in item && typeof item.content === "string") {
        const content = withoutPending(plainText(item.content)).trim();
        if (content) return content;
      }
    }
    return "";
  };
  return [title, read("date_time", "日時|日とき|いつ"), read("place", "場所|会場|どこで"), url].filter(Boolean).join("\n");
}
