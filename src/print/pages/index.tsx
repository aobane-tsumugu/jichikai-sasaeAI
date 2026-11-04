import { Hono } from "hono";
import { AdminPage } from "../../core/admin-ui";
import { adminPath } from "../../core/auth";
import type { Bundle } from "../../core/bundle";
import { getSquads } from "../../settings/store";
import { ArticleBody } from "../../publish";
import type { AdminEnv } from "../../env";
import { CutLine, FieldBox, PrintDocument, PrintQr, Sheet } from "../a4";
import { printQrUrl } from "../qr";

const printKinds = ["announcement", "answer", "leader", "duty", "meeting", "sponsors"] as const;
type PrintKind = (typeof printKinds)[number];

interface PrintData {
  project_id: string;
  title: string;
  document_id: string;
  document_title: string;
  version_id: string;
  version_no: number;
  body: string;
  kind: string;
}

const admin = new Hono<AdminEnv>();

admin.get("/print/:projectId/:documentId/:versionNo/preview", async (c) => {
  const { ward } = c.var;
  const row = await c.env.DB.prepare(`SELECT d.title, v.body, v.version_no FROM documents d
    JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.document_id = ? AND v.version_no = ?`)
    .bind(ward.wardId, c.req.param("projectId"), c.req.param("documentId"), Number(c.req.param("versionNo")))
    .first<{ title: string; body: string; version_no: number }>();
  if (!row) return c.notFound();
  return c.html(<PrintDocument title={`${row.title} 印刷の見え方`}>
    <Sheet footer={<><span>{ward.name}</span><span>確認用</span></>}><h1>{row.title}</h1><ArticleBody body={row.body} /></Sheet>
  </PrintDocument>);
});

admin.get("/print/:projectId/:documentId/:versionNo/:kind", async (c) => {
  const { ward } = c.var;
  const projectId = c.req.param("projectId");
  const documentId = c.req.param("documentId");
  const kind = c.req.param("kind") as PrintKind;
  const versionNo = Number(c.req.param("versionNo"));
  if (!printKinds.includes(kind) || !Number.isInteger(versionNo)) return c.notFound();
  const row = await c.env.DB.prepare(`SELECT p.project_id, p.title, d.document_id, d.title AS document_title,
      v.version_id, v.version_no, v.body, d.kind
    FROM publication_records r JOIN projects p ON p.ward_id = r.ward_id AND p.project_id = r.project_id
    JOIN documents d ON d.ward_id = r.ward_id AND d.document_id = r.document_id
    JOIN document_versions v ON v.ward_id = r.ward_id AND v.version_id = r.version_id
    WHERE r.ward_id = ? AND r.project_id = ? AND r.document_id = ? AND v.version_no = ?
    ORDER BY r.published_at DESC LIMIT 1`).bind(ward.wardId, projectId, documentId, versionNo).first<PrintData>();
  if (!row) return c.notFound();
  const squads = await getSquads(c.env.DB, ward.wardId);
  const baseUrl = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  const url = printQrUrl(baseUrl, ward.slug, { projectId, documentId: row.document_id, version: versionNo });
  const named = (squad?: string) => printQrUrl(baseUrl, ward.slug, {
    projectId, documentId: row.document_id, version: versionNo, ...(squad ? { squad } : {}),
  });
  const printTitle = `${row.title} ${kindLabel(kind)}`;
  return c.html(<PrintDocument title={printTitle}>
    {kind === "announcement" ? <>
      <Sheet footer={<><span>{ward.name}</span><span>案内 {versionNo}</span></>}>
        <h1>{row.document_title}</h1><ArticleBody body={row.body} />
        <PrintQr text={url} caption={url} />
      </Sheet>
      {squads.map((squad) => <Sheet key={squad} footer={<><span>{ward.name} {squad}</span><span>回答票</span></>}>
        <h1>{row.title} 回答票</h1><p>班: {squad}</p><CutLine />
        <FieldBox label="世帯名" heightMm={20} /><FieldBox label="人数" heightMm={16} /><FieldBox label="手伝いの名前と時間帯" heightMm={28} />
        <p>回答の入口: {`/${ward.slug}/answer/${projectId}`}</p><PrintQr text={named(squad)} caption={named(squad)} sizeMm={25} />
      </Sheet>)}
    </> : null}
    {kind === "answer" ? squads.map((squad) => <Sheet key={squad} footer={<>{ward.name} {squad} 回答票</>}>
      <h1>{row.title} 回答票</h1><p>班: {squad}</p><FieldBox label="世帯名" heightMm={20} /><FieldBox label="人数" heightMm={16} /><FieldBox label="手伝いの名前と時間帯" heightMm={35} />
      <PrintQr text={named(squad)} caption={named(squad)} />
    </Sheet>) : null}
    {kind === "leader" ? squads.map((squad) => <Sheet key={squad} footer={<>{ward.name} {squad}</>}>
      <h1>班長へのお知らせ</h1><p>{row.title}</p><ArticleBody body={row.body} /><p>班: {squad}</p>
      <p>この案内を班の世帯へお渡しください。</p><PrintQr text={named(squad)} caption={named(squad)} />
    </Sheet>) : null}
    {kind === "duty" ? <Sheet footer={<>{ward.name} 当番表と配置図</>}>
      <h1>{row.title} 当番表と配置図</h1><ArticleBody body={row.body} />
      {Array.from({ length: 8 }, (_, index) => <FieldBox key={index} label={index < 5 ? `時間帯 ${index + 1}・持ち場・担当` : `配置 ${index - 4}・場所・メモ`} heightMm={16} />)}
      <PrintQr text={url} caption={url} sizeMm={22} />
    </Sheet> : null}
    {kind === "meeting" ? <Sheet footer={<>{ward.name} 役員会の記入欄</>}>
      <h1>役員会の記入欄</h1><p>{row.title}</p><FieldBox label="決めたこと" heightMm={30} /><FieldBox label="日時・場所・変更" heightMm={30} />
      <FieldBox label="次にすること" heightMm={30} /><PrintQr text={url} caption={url} />
    </Sheet> : null}
    {kind === "sponsors" ? <Sheet footer={<>{ward.name} 協賛先</>}>
      <h1>{row.title} 協賛先の一覧</h1><ArticleBody body={row.body} />
      {Array.from({ length: 10 }, (_, index) => <FieldBox key={index} label={`協賛先 ${index + 1}・返事・連絡`} heightMm={18} />)}
      <PrintQr text={url} caption={url} sizeMm={22} />
    </Sheet> : null}
  </PrintDocument>);
});

admin.get("/print/:projectId/:documentId/:versionNo", async (c) => PrintChooser({ c }));

async function PrintChooser({ c }: { c: import("hono").Context<AdminEnv> }) {
  const { ward, account } = c.var;
  const projectId = c.req.param("projectId");
  const documentId = c.req.param("documentId");
  const versionNo = c.req.param("versionNo");
  const row = await c.env.DB.prepare(`SELECT d.title FROM documents d JOIN publication_records r
    ON r.ward_id = d.ward_id AND r.document_id = d.document_id
    WHERE r.ward_id = ? AND r.project_id = ? AND r.document_id = ? AND r.version_no = ?`)
    .bind(ward.wardId, projectId, documentId, Number(versionNo)).first<{ title: string }>();
  if (!row) return c.notFound();
  return c.html(<AdminPage ward={ward} account={account} title="印刷用ページ" back={{ href: adminPath(ward, `/publish/${projectId}`), label: "配る画面へ戻る" }}>
    <h1>{row.title} 印刷用ページ</h1>
    <ul>{printKinds.map((kind) => <li key={kind}><a href={adminPath(ward, `/print/${projectId}/${documentId}/${versionNo}/${kind}`)}>{kindLabel(kind)}</a></li>)}</ul>
  </AdminPage>);
}

function kindLabel(kind: PrintKind): string {
  const labels: Record<PrintKind, string> = { announcement: "案内と回答票", answer: "回答票", leader: "班長への一枚", duty: "当番表と配置図", meeting: "役員会の記入欄", sponsors: "協賛先の一覧" };
  return labels[kind];
}

export const printPages: Bundle = { admin };
