import type { MiddlewareHandler } from "hono";
import { publishedItem } from "../answers/resident";
import { listHelpOpportunities } from "../answers/help";
import { formatDateText } from "../core/time";
import { baseUrl } from "../core/ward";
import { documentTitle } from "../project/heading";
import type { WardEnv } from "../env";
import { publicDocuments, type PublicDocument } from "./publications";

interface Metadata { title: string; description: string; url: string; image: string; type: "website" | "article"; }

function MetadataHead({ value }: { value: Metadata }) {
  return <>
    <meta name="description" content={value.description} />
    <meta property="og:title" content={value.title} />
    <meta property="og:description" content={value.description} />
    <meta property="og:url" content={value.url} />
    <meta property="og:type" content={value.type} />
    <meta property="og:image" content={value.image} />
    <meta property="og:image:type" content="image/png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta property="og:image:alt" content="SasaeAI" />
    <link rel="canonical" href={value.url} />
  </>;
}

// 自由記述の本文や公開用の連絡先は転送用の説明にコピーしない。
function eventDescription(documents: PublicDocument[]): string {
  // 知らせは本文が正。項目や以前の案内から日時・場所を足し戻さず、ページへ案内する。
  if (documents.some((document) => document.kind === "notice")) return "";
  const ordered = ["notice", "announcement", "recruitment", "report"]
    .flatMap((kind) => documents.filter((document) => document.kind === kind));
  return ["date_time", "place"].map((key) => {
    const value = ordered.map((document) => publishedItem(document.body, key)).find(Boolean);
    return value ? `${key === "date_time" ? "日時" : "場所"}: ${formatDateText(value)}` : "";
  }).filter(Boolean).join("。 ");
}

/** 住民向けの既存HTMLのheadだけを補う。フォームや画面の見た目は変えない。 */
export const publicMetadata: MiddlewareHandler<WardEnv> = async (c, next) => {
  const root = `/${c.var.ward.slug}`;
  const path = c.req.path.replace(/\/$/, "");
  const detail = path.slice(root.length).match(/^\/(p|work|help|answer)\/([^/]+)$/);
  if (path !== root && path !== `${root}/help` && !detail) return next();
  await next();
  if (!c.res.headers.get("Content-Type")?.includes("text/html")) return;
  c.header("Cache-Control", "private, no-store");
  // 入力を返すPOSTには、住民が書いた名前が含まれる。転送用の情報を付けない。
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    c.header("X-Robots-Tag", "noindex");
    return;
  }
  if (c.res.status !== 200) return;
  const ward = c.var.ward;
  const state = await c.env.DB.prepare("SELECT is_active FROM wards WHERE ward_id = ?")
    .bind(ward.wardId).first<{ is_active: number }>();
  let title = `${ward.name}のお知らせ`;
  let description = `${ward.name}の案内、募集、変更、報告をご覧ください。登録せずに読めます。`;
  let visible = state?.is_active === 1;
  if (detail) {
    const [, kind, encodedId] = detail;
    const projectId = decodeURIComponent(encodedId!);
    const documents = await publicDocuments(c.env.DB, ward.wardId, projectId);
    if (kind === "work") {
      const activity = await c.env.DB.prepare(`SELECT p.title FROM project_activity_pages a
        JOIN projects p ON p.ward_id = a.ward_id AND p.project_id = a.project_id
        WHERE a.ward_id = ? AND a.project_id = ? AND a.published_at IS NOT NULL AND a.published_body IS NOT NULL`)
        .bind(ward.wardId, projectId).first<{ title: string }>();
      visible &&= !!activity;
      title = `${ward.name}｜${activity?.title ?? "活動"}で役員がしたこと`;
      description = `${title}をご覧ください。自治会の仕事と関わり方を紹介します。`;
    } else {
      visible &&= documents.length > 0;
      const labels = [...new Set(documents.filter((document) => ["announcement", "recruitment", "notice", "report"].includes(document.kind))
        .map((document) => documentTitle(document.project_kind, document.kind)))];
      title = `${ward.name}｜${documents[0]?.project_title ?? "お知らせ"}の${kind === "help" ? "手伝いの募集" : kind === "answer" ? "出欠の返事" : labels.join("・") || "お知らせ"}`;
      description = `${title}をご覧ください。${eventDescription(documents)}`;
      if (kind === "help") visible &&= (await listHelpOpportunities(c.env.DB, ward.wardId, projectId)).length > 0;
    }
  } else if (path === `${root}/help`) {
    title = `${ward.name}｜一回だけ手伝う`;
    description = `${ward.name}の手伝いの募集をご覧ください。自治会に加入していなくても申し込めます。`;
  }
  if (!visible) {
    c.header("X-Robots-Tag", "noindex");
    c.res = new HTMLRewriter().on("head", { element(element) {
      element.append('<meta name="robots" content="noindex">', { html: true });
    } }).transform(c.res);
    return;
  }
  const origin = baseUrl(c.env, c.req.url);
  const metadata: Metadata = { title, description, url: `${origin}${path === root ? `${root}/` : path}`,
    image: `${origin}/share.png`, type: detail ? "article" : "website" };
  const head = (<MetadataHead value={metadata} />).toString();
  c.res = new HTMLRewriter()
    .on("title", { element(element) { element.setInnerContent(title); } })
    .on("head", { element(element) { element.append(head, { html: true }); } })
    .transform(c.res);
};
