import { Hono } from "hono";
import { AdminPage } from "../../core/admin-ui";
import { Hint } from "../../core/ui";
import { adminPath } from "../../core/auth";
import type { Bundle } from "../../core/bundle";
import { getSquads } from "../../settings/store";
import { ArticleBody, articleParagraphs } from "../../publish";
import type { AdminEnv } from "../../env";
import { CutLine, FieldBox, PrintDocument, PrintQr, Sheet, paperHeading } from "../a4";
import { makePaperCode, makeProjectPaperCode, printQrUrl, projectPaperQrUrl } from "../qr";
import { getProjectState, getProjectSummary } from "../../project/api";
import { createInvite, getSpace } from "../../space/api";
import { TABLES, displayFieldValue, type TableKey } from "../../project/model";
import type { RowView } from "../../project/types";
import { readPublicationTables } from "../../space/publication-tables";
import { PosterPage } from "./poster";

const printKinds = ["poster", "announcement", "answer", "leader", "duty", "meeting", "sponsors"] as const;
type PrintKind = (typeof printKinds)[number];

interface PrintData {
  tables_snapshot: string | null;
  project_id: string;
  title: string;
  closed_at: string | null;
  document_id: string;
  document_title: string;
  version_id: string;
  version_no: number;
  body: string;
  kind: string;
  scope: string;
}

const admin = new Hono<AdminEnv>();

admin.get("/print/:projectId", async (c) => {
  const { ward, account } = c.var;
  const id = c.req.param("projectId");
  const project = await getProjectSummary(c.env.DB, ward.wardId, id);
  if (!project) return c.notFound();
  return c.html(<AdminPage ward={ward} account={account} title="紙を印刷する" back={{ href: adminPath(ward, `/projects/${id}/map`), label: "地図へ戻る" }}>
    <h1>紙を印刷する <Hint text="案内を配る前から使えます。電話や役員会で決まったことを紙に書き、番号と一緒に撮って送ってください。" /></h1>
    <p>{project.title}</p>
    <ul>{(["meeting", "sponsors"] as const).map((kind) => <li><a href={adminPath(ward, `/print/${id}/paper/${kind}`)}>{kindLabel(kind)}</a></li>)}</ul>
    <p><a href={adminPath(ward, `/intake?project=${encodeURIComponent(id)}#send-form`)}>書いた紙を撮って送る</a></p>
    <p><a href={adminPath(ward, `/publish/${id}`)}>配った案内や回答票を印刷する</a></p>
  </AdminPage>);
});

admin.get("/print/:projectId/paper/:kind", async (c) => {
  const { ward } = c.var;
  const id = c.req.param("projectId");
  const kind = c.req.param("kind");
  if (kind !== "meeting" && kind !== "sponsors") return c.notFound();
  const state = await getProjectState(c.env.DB, ward.wardId, id);
  if (!state) return c.notFound();
  const baseUrl = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  if (kind === "meeting") {
    const projects = await c.env.DB.prepare(`SELECT project_id, title FROM projects
      WHERE ward_id = ? AND (closed_at IS NULL OR project_id = ?) ORDER BY created_at, project_id`)
      .bind(ward.wardId, id).all<{ project_id: string; title: string }>();
    const papers = await Promise.all(projects.results.map(async (project) => ({ ...project,
      code: await makeProjectPaperCode(c.env.DB, ward.wardId, project.project_id),
      url: projectPaperQrUrl(baseUrl, ward.slug, project.project_id),
    })));
    return c.html(<PrintDocument title="役員会の記入欄">{papers.map((paper) => <Sheet footer={<>{ward.name} 役員会の記入欄</>}>
      <h1>{paper.title}</h1><h2>役員会の記入欄</h2>
      <p>決まったことを書き、紙の番号と一緒に撮って送ってください。</p>
      <PaperField label="決めたこと" heightMm={42} code={paper.code} text={paper.url} />
      <PaperField label="日時・場所・変更" heightMm={42} code={paper.code} text={paper.url} />
      <PaperField label="次にすること" heightMm={42} code={paper.code} text={paper.url} />
    </Sheet>)}</PrintDocument>);
  }
  const code = await makeProjectPaperCode(c.env.DB, ward.wardId, id);
  const url = projectPaperQrUrl(baseUrl, ward.slug, id);
  const rows = state.tables.sponsors.filter((entry) => entry.scope === "current");
  // 去年しか無い相手も打診できるように載せる。去年の返事や額を今年の返事にしない。
  const names = new Set(rows.map((entry) => entry.matchKey));
  for (const entry of state.tables.sponsors.filter((entry) => entry.scope === "reference").sort((a, b) => (b.refYear ?? 0) - (a.refYear ?? 0))) {
    if (names.has(entry.matchKey)) continue;
    names.add(entry.matchKey);
    rows.push({ ...entry, data: { name: entry.data.name ?? "", lastYearAmount: entry.data.amount ?? entry.data.lastYearAmount ?? "" } });
  }
  return c.html(<PrintDocument title={`${state.project.title} 協賛先の一覧`}>
    <Sheet footer={<>{ward.name} 協賛先の一覧 {code}</>}>
      <h1>{state.project.title} 協賛先の一覧</h1>
      <p>電話しながら返事と額を書き、紙の番号と一緒に撮って送ってください。紙の番号: {code}</p>
      <PrintQr text={url} sizeMm={26} />
      <RowsTable table="sponsors" rows={rows} paperCode={code} />
      {Array.from({ length: 3 }, (_, index) => <FieldBox key={index} label={`協賛先・返事・額・メモ　${code ?? ""}`} heightMm={22} />)}
    </Sheet>
  </PrintDocument>);
});

admin.get("/print/:projectId/:documentId/:versionNo/preview", async (c) => {
  const { ward } = c.var;
  const row = await c.env.DB.prepare(`SELECT COALESCE(v.title, d.title) AS title, p.title AS project_title, v.body, v.version_no FROM documents d
    JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    JOIN projects p ON p.ward_id = d.ward_id AND p.project_id = d.project_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.document_id = ? AND v.version_no = ?`)
    .bind(ward.wardId, c.req.param("projectId"), c.req.param("documentId"), Number(c.req.param("versionNo")))
    .first<{ title: string; project_title: string; body: string; version_no: number }>();
  if (!row) return c.notFound();
  const heading = paperHeading(row.project_title, row.title);
  return c.html(<PrintDocument title={`${heading} 印刷の見え方`}>
    <Sheet footer={<><span>{ward.name}</span><span>確認用</span></>}><h1>{heading}</h1><ArticleBody body={row.body} /></Sheet>
  </PrintDocument>);
});

const renderPublishedPaper: import("hono").Handler<AdminEnv> = async (c) => {
  const { ward } = c.var;
  const projectId = c.req.param("projectId");
  const documentId = c.req.param("documentId");
  if (!projectId || !documentId) return c.notFound();
  const kind = (c.req.method === "POST" ? "leader" : c.req.param("kind")) as PrintKind;
  const versionNo = Number(c.req.param("versionNo"));
  if (!printKinds.includes(kind) || !Number.isInteger(versionNo)) return c.notFound();
  const row = await c.env.DB.prepare(`SELECT p.project_id, p.title, p.closed_at, d.document_id, COALESCE(v.title, d.title) AS document_title,
      v.version_id, v.version_no, v.body, d.kind, v.scope, v.tables_snapshot
    FROM document_versions v JOIN projects p ON p.ward_id = v.ward_id AND p.project_id = v.project_id
    JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
    LEFT JOIN publication_records r ON r.ward_id = v.ward_id AND r.version_id = v.version_id
    WHERE v.ward_id = ? AND v.project_id = ? AND v.document_id = ? AND v.version_no = ?
      AND (r.publication_id IS NOT NULL OR (v.scope = 'space' AND v.published_at IS NOT NULL))
    ORDER BY r.published_at DESC LIMIT 1`).bind(ward.wardId, projectId, documentId, versionNo).first<PrintData>();
  if (!row) return c.notFound();
  if (kind === "meeting" || kind === "sponsors") return c.redirect(adminPath(ward, `/print/${projectId}/paper/${kind}`), 303);
  const baseUrl = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  if (kind === "poster") {
    if (row.scope !== "public") return c.notFound();
    const wardUrl = `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(ward.slug)}/`;
    return c.html(<PosterPage title={paperHeading(row.title, row.document_title)} body={row.body} wardUrl={wardUrl} />);
  }
  const squads = await getSquads(c.env.DB, ward.wardId);
  const leaderUrls = new Map<string, string>();
  if (kind === "leader") {
    if (row.closed_at) return c.html(<AdminPage ward={ward} account={c.var.account} title="班長への一枚"><h1>この行事の受付は終わりました</h1><p>班長の専用 QR は使えません。</p></AdminPage>);
    const space = await getSpace(c.env.DB, ward.wardId, projectId);
    if (c.req.method !== "POST" || !space || space.closed_at || !squads.length) {
      return c.html(<AdminPage ward={ward} account={c.var.account} title="班長への一枚">
        <h1>班長への一枚 <Hint text="班長が自分の班の答えを見たり、回答票を撮って送ったりできる専用の QR を印刷します。その班長にだけ渡してください。" /></h1>
        {!space || space.closed_at ? <p><a href={adminPath(ward, `/space/${projectId}`)}>空間を開いてから印刷する</a></p>
          : !squads.length ? <p><a href={adminPath(ward, "/settings")}>区の設定で班の名前を入れる</a></p>
          : <form method="post"><button>班長の専用 QR を作って印刷する</button></form>}
      </AdminPage>);
    }
    for (const squad of squads) {
      const token = await createInvite(c.env.DB, ward.wardId, projectId, "leader", squad, c.var.account.accountId, true);
      leaderUrls.set(squad, `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(ward.slug)}/space/${encodeURIComponent(projectId)}/person/${token}`);
    }
  }
  const named = (squad?: string) => printQrUrl(baseUrl, ward.slug, {
    projectId, documentId: row.document_id, version: versionNo, ...(squad ? { squad } : {}),
  });
  const paperCode = await makePaperCode(c.env.DB, ward.wardId, projectId, row.document_id, versionNo);
  const paperQr = (squad?: string) => <div style="text-align:center"><PrintQr text={named(squad)} sizeMm={26} />
    <div class="paper-code">{paperCode}</div></div>;
  const answerSheet = (squad: string, helperMm: number) => <div style="display:flex;gap:4mm;align-items:flex-start">
    <div style="flex:1"><FieldBox label="世帯名" heightMm={16} /><FieldBox label="人数" heightMm={12} /><FieldBox label="手伝いの名前と時間帯" heightMm={helperMm} /></div>
    {paperQr(squad)}
  </div>;
  const onOneSheet = fitsAboveAnswer(row.body);
  const dense = bodyLines(row.body) > 30;
  const tables = readPublicationTables(row.tables_snapshot);
  const published = (table: TableKey) => (tables ?? []).filter((entry) => entry.kind === table);
  const printTitle = `${row.title} ${kindLabel(kind)}`;
  return c.html(<PrintDocument title={printTitle}>
    {kind === "announcement" && onOneSheet ? (squads.length ? squads : [""]).map((squad) => <Sheet key={squad} footer={<><span>{ward.name} {squad}</span><span>案内 {versionNo}</span></>}>
      <h1>{paperHeading(row.title, row.document_title)}</h1><ArticleBody body={row.body} /><CutLine />
      <h2>{row.title} 回答票 {squad}</h2>{answerSheet(squad, 24)}
      <p>QR を読むと案内のページが開き、Web でも回答できます。</p>
    </Sheet>) : null}
    {kind === "announcement" && !onOneSheet ? <>
      <Sheet dense={dense} footer={<><span>{ward.name}</span><span>案内 {versionNo}</span></>}>
        <div class="float-qr">{paperQr()}</div>
        <h1>{paperHeading(row.title, row.document_title)}</h1><ArticleBody body={row.body} />
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
      <p>この案内を班の世帯へお渡しください。下の QR は班長だけが使います。ほかの人には渡さないでください。</p>
      <PrintQr text={leaderUrls.get(squad)!} sizeMm={32} /><p>QR から班の答えを見たり、回答票を撮って送ったりできます。</p>
    </Sheet>) : null}
    {kind === "duty" ? <Sheet footer={<>{ward.name} 当番表と配置図 {paperCode}</>}>
      <h1>{row.title} 当番表と配置図</h1>
      <p>紙の番号: {paperCode}</p>{paperQr()}
      {tables === null ? <p>配った時の表の記録がありません。表を確かめて配り直してください。</p> : <>
        <RowsTable table="duties" rows={published("duties")} paperCode={paperCode} />
        <RowsTable table="layout" rows={published("layout")} paperCode={paperCode} />
      </>}
      {Array.from({ length: 3 }, (_, index) => <FieldBox key={index} label={"時間帯・持ち場・担当、配置・場所・メモ　" + (paperCode ?? "")} heightMm={22} />)}
    </Sheet> : null}
  </PrintDocument>);
};

admin.get("/print/:projectId/:documentId/:versionNo/:kind", renderPublishedPaper);
admin.post("/print/:projectId/:documentId/:versionNo/leader", renderPublishedPaper);

admin.get("/print/:projectId/:documentId/:versionNo", async (c) => PrintChooser({ c }));

async function PrintChooser({ c }: { c: import("hono").Context<AdminEnv> }) {
  const { ward, account } = c.var;
  const projectId = c.req.param("projectId");
  const documentId = c.req.param("documentId");
  const versionNo = c.req.param("versionNo");
  const row = await c.env.DB.prepare(`SELECT COALESCE(v.title, d.title) AS title, v.scope FROM documents d JOIN document_versions v
    ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    LEFT JOIN publication_records r ON r.ward_id = v.ward_id AND r.version_id = v.version_id
    WHERE v.ward_id = ? AND v.project_id = ? AND v.document_id = ? AND v.version_no = ?
      AND (r.publication_id IS NOT NULL OR (v.scope = 'space' AND v.published_at IS NOT NULL))`)
    .bind(ward.wardId, projectId, documentId, Number(versionNo)).first<{ title: string; scope: string }>();
  if (!row) return c.notFound();
  return c.html(<AdminPage ward={ward} account={account} title="印刷用ページ" back={{ href: adminPath(ward, `/publish/${projectId}`), label: "配る画面へ戻る" }}>
    <h1>{row.title} 印刷用ページ</h1>
    <ul>{(row.scope === "space" ? ["duty"] as const : printKinds).map((kind) => <li key={kind}><a href={adminPath(ward, `/print/${projectId}/${documentId}/${versionNo}/${kind}`)}>{kindLabel(kind)}</a>{kind === "poster" ? <> <Hint text="配った案内の題、日時、場所と、区のページへの QR を大きく出します。印刷や画面の撮影で使えます。" /></> : null}</li>)}</ul>
  </AdminPage>);
}

function kindLabel(kind: PrintKind): string {
  const labels: Record<PrintKind, string> = { poster: "貼れる一枚", announcement: "案内と回答票", answer: "回答票", leader: "班長への一枚", duty: "当番表と配置図", meeting: "役員会の記入欄", sponsors: "協賛先の一覧" };
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

/** 表に出す列（どれかの行に値がある列）。 */
function shownFields(table: TableKey, rows: Pick<RowView, "data">[]) {
  return Object.entries(TABLES[table].fields).filter(([key]) => rows.some((entry) => entry.data[key] !== undefined && entry.data[key] !== ""));
}

/** 今年の中身の表を紙に並べる。空なら何も出さない。 */
function RowsTable({ table, rows, paperCode }: { table: TableKey; rows: Pick<RowView, "data">[]; paperCode?: string | null }) {
  if (!rows.length && table !== "sponsors") return null;
  const fields = table === "sponsors" ? Object.entries(TABLES.sponsors.fields) : shownFields(table, rows);
  return <>
    <h2>{TABLES[table].label}</h2>
    <table><thead>{paperCode ? <tr><th colspan={fields.length}>紙の番号: {paperCode}</th></tr> : null}<tr>{fields.map(([, field]) => <th>{field.label}</th>)}</tr></thead>
      <tbody>{rows.map((entry) => <tr style={table === "sponsors" ? "height:18mm" : undefined}>{fields.map(([key]) => <td>{displayFieldValue(table, key, entry.data[key])}</td>)}</tr>)}</tbody></table>
  </>;
}

function PaperField({ label, heightMm, code, text }: { label: string; heightMm: number; code: string | null; text: string }) {
  return <div class="meeting-field" style="display:flex;align-items:flex-start;gap:3mm;margin:2mm 0">
    <FieldBox label={label} heightMm={heightMm} code={code ?? undefined} />
    <PrintQr text={text} sizeMm={18} />
  </div>;
}

