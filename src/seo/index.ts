import { Hono } from "hono";
import { baseUrl } from "../core/ward";
import type { AppEnv } from "../env";
import { publicDocuments } from "./publications";
import { shareImage } from "./share-image";

export { publicMetadata } from "./metadata";

const xmlText = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");

export const seoRoutes = new Hono<AppEnv>();

seoRoutes.get("/share.png", (c) => c.body(shareImage(), 200, {
  "Content-Type": "image/png", "Cache-Control": "public, max-age=86400",
}));

seoRoutes.get("/sitemap.xml", async (c) => {
  // 区を列挙する入口だけは区のIDを先に取り、文書は必ずその区に絞って読む。
  const wards = await c.env.DB.prepare("SELECT ward_id, slug FROM wards WHERE ward_id IS NOT NULL AND is_active = 1 ORDER BY slug")
    .all<{ ward_id: string; slug: string }>();
  const origin = baseUrl(c.env, c.req.url);
  const urls: string[] = [];
  for (const ward of wards.results) {
    const root = `${origin}/${encodeURIComponent(ward.slug)}`;
    urls.push(`${root}/`);
    const documents = await publicDocuments(c.env.DB, ward.ward_id);
    for (const id of new Set(documents.map((document) => document.project_id))) urls.push(`${root}/p/${encodeURIComponent(id)}`);
    const activities = await c.env.DB.prepare(`SELECT project_id FROM project_activity_pages
      WHERE ward_id = ? AND published_at IS NOT NULL AND published_body IS NOT NULL ORDER BY project_id`)
      .bind(ward.ward_id).all<{ project_id: string }>();
    for (const activity of activities.results) urls.push(`${root}/work/${encodeURIComponent(activity.project_id)}`);
  }
  return c.body(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map((url) => `<url><loc>${xmlText(url)}</loc></url>`).join("\n")}\n</urlset>`, 200,
    { "Content-Type": "application/xml; charset=UTF-8", "Cache-Control": "no-store" });
});
