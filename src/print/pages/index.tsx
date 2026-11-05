import { Hono } from "hono";
import { AdminPage } from "../../core/admin-ui";
import { adminPath } from "../../core/auth";
import type { Bundle } from "../../core/bundle";
import { getSquads } from "../../settings/store";
import { ArticleBody, articleParagraphs } from "../../publish";
import type { AdminEnv } from "../../env";
import { CutLine, FieldBox, PrintDocument, PrintQr, Sheet } from "../a4";
import { makePaperCode, printQrUrl } from "../qr";
import { getProjectState } from "../../project/api";
import { TABLES, displayFieldValue, type TableKey } from "../../project/model";
import type { RowView } from "../../project/types";

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
  const paperCode = await makePaperCode(c.env.DB, ward.wardId, projectId, row.document_id, versionNo);
  const meetingTargets = kind === "meeting" ? await c.env.DB.prepare(`SELECT p.project_id, p.title, d.document_id, r.version_no
    FROM projects p JOIN publication_records r ON r.ward_id = p.ward_id AND r.project_id = p.project_id
    JOIN documents d ON d.ward_id = r.ward_id AND d.document_id = r.document_id
    WHERE p.ward_id = ? AND p.closed_at IS NULL AND r.unpublished_at IS NULL
      AND r.publication_id = (SELECT latest.publication_id FROM publication_records latest
        WHERE latest.ward_id = p.ward_id AND latest.project_id = p.project_id AND latest.unpublished_at IS NULL
        ORDER BY latest.published_at DESC, latest.publication_id DESC LIMIT 1)
    ORDER BY p.created_at, p.project_id`).bind(ward.wardId).all<{
      project_id: string; title: string; document_id: string; version_no: number;
    }>() : { results: [] };
  const meetingSheets = await Promise.all(meetingTargets.results.map(async (target) => ({
    ...target,
    paperCode: await makePaperCode(c.env.DB, ward.wardId, target.project_id, target.document_id, target.version_no),
    url: printQrUrl(baseUrl, ward.slug, { projectId: target.project_id, documentId: target.document_id, version: target.version_no }),
  })));
  const paperQr = (squad?: string) => <div style="text-align:center"><PrintQr text={named(squad)} sizeMm={26} />
    <div class="paper-code">{paperCode}</div></div>;
  const answerSheet = (squad: string, helperMm: number) => <div style="display:flex;gap:4mm;align-items:flex-start">
    <div style="flex:1"><FieldBox label="世帯名" heightMm={16} /><FieldBox label="人数" heightMm={12} /><FieldBox label="手伝いの名前と時間帯" heightMm={helperMm} /></div>
    {paperQr(squad)}
  </div>;
  const onOneSheet = fitsAboveAnswer(row.body);
  const dense = bodyLines(row.body) > 30;
  // 当番表と協賛先の紙は、案内の本文ではなく今年の中身の表から作る。
  const state = kind === "duty" || kind === "sponsors" ? await getProjectState(c.env.DB, ward.wardId, projectId) : null;
  const current = (table: TableKey) => (state?.tables[table] ?? []).filter((entry) => entry.scope === "current");
  const tableRows = kind === "duty" ? [...current("duties"), ...current("layout")] : kind === "sponsors" ? current("sponsors") : [];
  const listed = tableRows.slice(0, 20);
  // 表の行は折り返すと高さが読めないので、表がある時の書き込む欄は残りの高さを埋める一つの欄にし、一枚から溢れないようにする。
  const blankArea = (label: string, count: number) => listed.length === 0
    ? Array.from({ length: count }, (_, index) => <FieldBox key={index} label={label} heightMm={16} />)
    : <div class="field fill"><span class="field-label">書き足す欄（{label}）</span></div>;
  const printTitle = `${row.title} ${kindLabel(kind)}`;
  return c.html(<PrintDocument title={printTitle}>
    {kind === "announcement" && onOneSheet ? (squads.length ? squads : [""]).map((squad) => <Sheet key={squad} footer={<><span>{ward.name} {squad}</span><span>案内 {versionNo}</span></>}>
      <h1>{row.document_title}</h1><ArticleBody body={row.body} /><CutLine />
      <h2>{row.title} 回答票 {squad}</h2>{answerSheet(squad, 24)}
      <p>QR を読むと案内のページが開き、Web でも回答できます。</p>
    </Sheet>) : null}
    {kind === "announcement" && !onOneSheet ? <>
      <Sheet dense={dense} footer={<><span>{ward.name}</span><span>案内 {versionNo}</span></>}>
        <div class="float-qr">{paperQr()}</div>
        <h1>{row.document_title}</h1><ArticleBody body={row.body} />
      </Sheet>
      {squads.map((squad) => <Sheet key={squad} footer={<><span>{ward.name} {squad}</span><span>回答票</span></>}>
        <h1>{row.title} 回答票</h1><p>班: {squad}</p>{answerSheet(squad, 28)}
        <p>QR を読むと案内のページが開き、Web でも回答できます。</p>
      </Sheet>)}
    </> : null}
    {kind === "answer" ? squads.map((squad) => <Sheet key={squad} footer={<>{ward.name} {squad} 回答票</>}>
      <h1>{row.title} 回答票</h1><p>班: {squad}</p>{answerSheet(squad, 35)}
    </Sheet>) : null}
    {kind === "leader" ? squads.map((squad) => <Sheet key={squad} footer={<>{ward.name} {squad}</>}>
      <h1>班長へのお知らせ</h1><p>{row.title}</p><ArticleBody body={row.body} /><p>班: {squad}</p>
      <p>この案内を班の世帯へお渡しください。</p>{paperQr(squad)}
    </Sheet>) : null}
    {kind === "duty" ? <Sheet fill footer={<>{ward.name} 当番表と配置図</>}>
      <div class="float-qr">{paperQr()}</div>
      <h1>{row.title} 当番表と配置図</h1>
      <RowsTable table="duties" rows={listed.filter((entry) => entry.table === "duties")} />
      <RowsTable table="layout" rows={listed.filter((entry) => entry.table === "layout")} />
      {tableRows.length > listed.length ? <p>ほかに {tableRows.length - listed.length} 行あります。役員画面で見られます。</p> : null}
      {blankArea("時間帯・持ち場・担当、配置・場所・メモ", 8)}
    </Sheet> : null}
    {kind === "meeting" ? Array.from({ length: Math.max(1, Math.ceil(meetingSheets.length / 3)) }, (_, page) => {
      const targets = meetingSheets.slice(page * 3, page * 3 + 3);
      return <Sheet key={page} footer={<>{ward.name} 役員会の記入欄</>}>
        <h1>役員会の記入欄</h1><p>{row.title}</p>{paperQr()}
        {targets.length ? targets.map((target) => {
          return <section key={target.project_id} style="margin:2mm 0">
            <h2>{target.title}</h2>
            <PaperField label="決めたこと" heightMm={16} code={target.paperCode} text={target.url} />
            <PaperField label="日時・場所・変更" heightMm={16} code={target.paperCode} text={target.url} />
            <PaperField label="次にすること" heightMm={16} code={target.paperCode} text={target.url} />
          </section>;
        }) : <>
          <PaperField label="決めたこと" heightMm={30} code={paperCode} text={url} />
          <PaperField label="日時・場所・変更" heightMm={30} code={paperCode} text={url} />
          <PaperField label="次にすること" heightMm={30} code={paperCode} text={url} />
        </>}
      </Sheet>;
    }) : null}
    {kind === "sponsors" ? <Sheet fill footer={<>{ward.name} 協賛先</>}>
      <div class="float-qr">{paperQr()}</div>
      <h1>{row.title} 協賛先の一覧</h1>
      <RowsTable table="sponsors" rows={listed} />
      {tableRows.length > listed.length ? <p>ほかに {tableRows.length - listed.length} 行あります。役員画面で見られます。</p> : null}
      {blankArea("協賛先・返事・連絡", 10)}
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

/** 案内と切り取る回答票を一枚に載せられるか。A4 の文字幅で約 42 字、案内に使える高さで約 20 行。 */
/** 本文が一枚の中で何行分になるかの見積もり（一行は全角 42 字、段落の間を 0.4 行）。 */
function bodyLines(body: string): number {
  const paragraphs = articleParagraphs(body);
  const lines = paragraphs.flatMap((paragraph) => paragraph.split("\n")).reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 42)), 0);
  return lines + paragraphs.length * 0.4;
}

function fitsAboveAnswer(body: string): boolean {
  return bodyLines(body) <= 20;
}

/** 今年の中身の表を紙に並べる。空なら何も出さない。 */
function RowsTable({ table, rows }: { table: TableKey; rows: RowView[] }) {
  if (!rows.length) return null;
  const fields = Object.entries(TABLES[table].fields).filter(([key]) => rows.some((entry) => entry.data[key] !== undefined && entry.data[key] !== ""));
  return <>
    <h2>{TABLES[table].label}</h2>
    <table><thead><tr>{fields.map(([, field]) => <th>{field.label}</th>)}</tr></thead>
      <tbody>{rows.map((entry) => <tr>{fields.map(([key]) => <td>{displayFieldValue(table, key, entry.data[key])}</td>)}</tr>)}</tbody></table>
  </>;
}

function PaperField({ label, heightMm, code, text }: { label: string; heightMm: number; code: string | null; text: string }) {
  return <div class="meeting-field" style="display:flex;align-items:flex-start;gap:3mm;margin:2mm 0">
    <FieldBox label={label} heightMm={heightMm} code={code ?? undefined} />
    <PrintQr text={text} sizeMm={18} />
  </div>;
}

