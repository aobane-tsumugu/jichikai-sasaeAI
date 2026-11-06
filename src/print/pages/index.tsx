import { listPublicPhotos } from "../../photos/public";
import { formatDateText } from "../../core/time";
import { plainText, withoutPending, writtenInText } from "../../project/document-body";
import { collectsAttendance, withoutTitleLine } from "../../project/heading";
import { labelsFromBody } from "../../answers/counts";
import { getAnswerLabels } from "../../settings/answer-labels";
import { DraftPaper } from "./draft";
import { MeetingSlipFields } from "./meeting";
import { meetingNote, meetingNoteFromBody } from "../../answers/meeting";
import { Hono } from "hono";
import { AdminPage } from "../../core/admin-ui";
import { adminPath } from "../../core/auth";
import type { Bundle } from "../../core/bundle";
import { getPublicContact, getSquads } from "../../settings/store";
import { getAnswerDeadline } from "../../answers/api";
import { ArticleBody, articleParagraphs } from "../../publish";
import type { AdminEnv } from "../../env";
import { CutLine, FieldBox, PrintDocument, PrintQr, Sheet } from "../a4";
import { paperHeading } from "../../project/heading";
import { makePaperCode, makeProjectPaperCode, printQrUrl, projectPaperQrUrl } from "../qr";
import { getProjectState, getProjectSummary } from "../../project/api";
import { createInvite, getSpace } from "../../space/api";
import { DOCUMENT_KIND_LABEL, TABLES, displayFieldValue, type DocumentKind, type TableKey } from "../../project/model";
import type { RowView } from "../../project/types";
import { currentPublicationTables, readPublicationTables } from "../../space/publication-tables";
import { PosterPage } from "./poster";
import { paperCopies, paperDate, paperDeadline, paperGive, paperHelperSlots, publishedItem } from "../content";

const printKinds = ["poster", "announcement", "answer", "leader", "duty", "meeting", "sponsors"] as const;
type PrintKind = (typeof printKinds)[number];

interface PrintData {
  project_kind: string;
  published_at: string | null;
  distribution: string | null;
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
  const papers = await c.env.DB.prepare(`SELECT d.document_id, d.kind, d.scope, d.title, MAX(v.version_no) AS latest,
    MAX(CASE WHEN v.published_at IS NOT NULL THEN v.version_no END) AS published
    FROM documents d JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    WHERE d.ward_id = ? AND d.project_id = ? GROUP BY d.document_id ORDER BY d.created_at`).bind(ward.wardId, id)
    .all<{ document_id: string; kind: string; scope: string; title: string; latest: number; published: number | null }>();
  return c.html(<AdminPage ward={ward} account={account} title="紙を印刷する" back={{ href: adminPath(ward, `/projects/${id}/map`), label: "← 段取りへ" }}>
    <h1>紙を印刷する</h1>
    <p class="lead">行事で使う紙を、全部ここから印刷できます。配る紙と、書き込んで撮って送る紙があります。</p>
    <p>{project.title}</p>
    <h2>配る紙</h2><ul class="rows">{papers.results.map((paper) => {
      const base = `/print/${id}/${paper.document_id}/${paper.published ?? paper.latest}`;
      const withAnswer = collectsAttendance(project.kind, paper.kind);
      const extra = paper.kind === "announcement" ? [
        ...(withAnswer ? [{ href: `${base}${paper.published === null ? "/preview?paper=answer" : "/answer"}`, title: "回答票だけ", note: "答えを書いて渡してもらう紙です" }] : []),
        ...(paper.published !== null ? [{ href: `${base}/poster`, title: "掲示", note: "掲示板に貼る一枚です" }, ...(withAnswer ? [{ href: `${base}/leader`, title: "班長への一枚", note: "班長のページのQRコードが付いています" }] : [])] : []),
      ] : [];
      return <><li><a class="row-link" href={adminPath(ward, `${base}${paper.published === null ? "/preview" : ["duty_roster", "procedure"].includes(paper.kind) || paper.scope === "space" ? "/duty" : "/announcement"}`)}><b>{withAnswer ? "案内と回答票" : paper.title}</b><span>{paper.published === null ? "下書きです。まだ配っていません。" : "配ったときの紙です。"}</span></a>
        </li>{extra.map((row) => <li><a class="row-link" href={adminPath(ward, row.href)}><b>{row.title}</b><span>{row.note}</span></a></li>)}</>;
    })}</ul>{!papers.results.length ? <p>下書きを保存すると、ここから紙を開けます。</p> : null}
    <h2>書き込んで撮って送る紙</h2><p>電話や役員会で決まったことを、紙に書いて撮って送れます。案内を配る前から使えます。</p>
    <ul class="rows">{(["meeting", "sponsors"] as const).map((kind) => <li><a class="row-link" href={adminPath(ward, `/print/${id}/paper/${kind}`)}><b>{kindLabel(kind)}</b></a></li>)}</ul>
    <p class="link-line"><a href={adminPath(ward, `/intake?project=${encodeURIComponent(id)}#send-form`)}>書いた紙を撮って送る</a></p>
    <p class="link-line"><a href={adminPath(ward, `/publish/${id}`)}>配った案内や回答票を印刷する</a></p>
    <details class="fold"><summary>家にプリンタがないとき</summary><div><p>紙を開いて、スマホやパソコンの印刷の画面でPDFに保存します。保存したPDFは、コンビニのコピー機の案内に沿って送ると印刷できます。</p></div></details>
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
    return c.html(<PrintDocument title="役員会の記入欄" back={adminPath(ward, `/print/${id}`)}>{papers.map((paper) => <Sheet footer={<><span>{ward.name} 役員会の記入欄</span><span>{paperDate(new Date().toISOString()).replace("に配りました", "に印刷しました")}　紙の番号{paper.code}</span></>}>
      <h1>{paper.title} 役員会の記入欄</h1>
      <p>役員会や電話で決まったことを、この紙に書いてください。書いたら、紙の番号が写るように撮って、役員の画面の「書いた紙を撮って送る」から送ってください。きれいに書かなくてかまいません。</p>
      <PaperField label="決めたこと" heightMm={66} code={paper.code} text={paper.url} />
      <PaperField label="日時・場所・変更" heightMm={66} code={paper.code} text={paper.url} />
      <PaperField label="次にすること" heightMm={66} code={paper.code} text={paper.url} />
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
  return c.html(<PrintDocument title={`${state.project.title}協賛先の一覧`} back={adminPath(ward, `/print/${id}`)}>
    <Sheet footer={<><span>{ward.name} 協賛先の一覧</span><span>{paperDate(new Date().toISOString()).replace("に配りました", "に印刷しました")}　紙の番号{code}</span></>}>
      <div class="paper-header"><div><h1>{state.project.title} 協賛先の一覧</h1>
      <p>電話しながら、返事と額を書いてください。書いたら、紙の番号と一緒に撮って、役員の画面から送ってください。去年の額は、今年の返事ではありません。</p>
      </div><div class="paper-identity"><PrintQr text={url} sizeMm={24} /><span>紙の番号<br />{code}</span></div></div>
      <RowsTable table="sponsors" rows={rows} paperCode={code} />
      <p>返事は、出す、出さない、待ちのどれかを書きます。一番下の空いた行には、一覧にない協賛先を書けます。</p>
    </Sheet>
  </PrintDocument>);
});

admin.get("/print/:projectId/:documentId/:versionNo/preview", async (c) => {
  const { ward } = c.var;
  const row = await c.env.DB.prepare(`SELECT COALESCE(v.title, d.title) AS title, d.kind, p.kind AS project_kind, p.title AS project_title, v.body, v.version_no, v.scope, v.published_at FROM documents d
    JOIN document_versions v ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    JOIN projects p ON p.ward_id = d.ward_id AND p.project_id = d.project_id
    WHERE d.ward_id = ? AND d.project_id = ? AND d.document_id = ? AND v.version_no = ?`)
    .bind(ward.wardId, c.req.param("projectId"), c.req.param("documentId"), Number(c.req.param("versionNo")))
    .first<{ title: string; kind: string; project_kind: string; project_title: string; body: string; version_no: number; scope: string; published_at: string | null }>();
  if (!row) return c.notFound();
  const tables = row.scope === "space" && ["duty_roster", "procedure"].includes(row.kind)
    ? await currentPublicationTables(c.env.DB, ward.wardId, c.req.param("projectId")) : undefined;
  return c.html(<DraftPaper title={row.title} projectTitle={row.project_title} projectKind={row.project_kind} body={row.body} kind={row.kind}
    tables={tables}
    back={adminPath(ward, `/projects/${c.req.param("projectId")}/draft/${row.kind}`)} wardName={ward.name}
    squads={await getSquads(c.env.DB, ward.wardId)} labels={await getAnswerLabels(c.env.DB, ward.wardId)} answerOnly={collectsAttendance(row.project_kind, row.kind) && c.req.query("paper") === "answer"}
    generalMeeting={row.project_kind === "general_meeting"} meetingNote={row.project_kind === "general_meeting" ? row.published_at ? meetingNoteFromBody(row.body) : await meetingNote(c.env.DB, ward.wardId) : ""} />);
});

const renderPublishedPaper: import("hono").Handler<AdminEnv> = async (c) => {
  const { ward } = c.var;
  const projectId = c.req.param("projectId");
  const documentId = c.req.param("documentId");
  if (!projectId || !documentId) return c.notFound();
  const kind = (c.req.method === "POST" ? "leader" : c.req.param("kind")) as PrintKind;
  const versionNo = Number(c.req.param("versionNo"));
  if (!printKinds.includes(kind) || !Number.isInteger(versionNo)) return c.notFound();
  const row = await c.env.DB.prepare(`SELECT p.project_id, COALESCE(v.project_title, p.title) AS title, p.kind AS project_kind, p.closed_at, d.document_id, COALESCE(v.title, d.title) AS document_title,
      v.version_id, v.version_no, v.body, d.kind, v.scope, v.tables_snapshot,
      COALESCE(r.published_at, v.published_at) AS published_at, r.distribution
    FROM document_versions v JOIN projects p ON p.ward_id = v.ward_id AND p.project_id = v.project_id
    JOIN documents d ON d.ward_id = v.ward_id AND d.document_id = v.document_id
    LEFT JOIN publication_records r ON r.ward_id = v.ward_id AND r.version_id = v.version_id
    WHERE v.ward_id = ? AND v.project_id = ? AND v.document_id = ? AND v.version_no = ?
      AND (r.publication_id IS NOT NULL OR (v.scope = 'space' AND v.published_at IS NOT NULL))
    ORDER BY r.published_at DESC LIMIT 1`).bind(ward.wardId, projectId, documentId, versionNo).first<PrintData>();
  if (!row) return c.notFound();
  if (kind === "meeting" || kind === "sponsors") return c.redirect(adminPath(ward, `/print/${projectId}/paper/${kind}`), 303);
  const withAnswer = collectsAttendance(row.project_kind, row.kind);
  if (!withAnswer && (kind === "answer" || kind === "leader")) return c.notFound();
  const baseUrl = c.env.PUBLIC_BASE_URL || new URL(c.req.url).origin;
  const back = adminPath(ward, `/print/${projectId}/${documentId}/${versionNo}`);
  const due = paperDeadline(await getAnswerDeadline(c.env.DB, ward.wardId, projectId) || publishedItem(row.body, "due"));
  const contact = (publishedItem(row.body, "public_contact") || await getPublicContact(c.env.DB, ward.wardId)).trim();
  const distributed = paperDate(row.published_at);
  const copies = paperCopies(row.distribution);
  if (kind === "poster") {
    if (row.scope !== "public") return c.notFound();
    const wardUrl = `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(ward.slug)}/`;
    return c.html(<PosterPage wardName={ward.name} withAnswer={withAnswer} generalMeeting={row.project_kind === "general_meeting"} title={paperHeading(row.title, row.document_title)} body={row.body} wardUrl={wardUrl} due={due} contact={contact} distributed={distributed} back={back} copies={copies} />);
  }
  const squads = await getSquads(c.env.DB, ward.wardId);
  const paperSquads = squads.length ? squads : [""];
  const leaderUrls = new Map<string, string>();
  if (kind === "leader") {
    if (row.closed_at) return c.html(<AdminPage ward={ward} account={c.var.account} title="班長への一枚" back={{ href: back, label: "印刷用ページへ戻る" }}><h1>この行事の受付は終わりました</h1><p>班長の専用QRは使えません。</p></AdminPage>);
    const space = await getSpace(c.env.DB, ward.wardId, projectId);
    if (c.req.method !== "POST" || !space || space.closed_at) {
      return c.html(<AdminPage ward={ward} account={c.var.account} title="班長への一枚" back={{ href: back, label: "印刷用ページへ戻る" }}>
        <h1>班長への一枚</h1>
        <p class="lead">班長が自分の班の答えを見たり、回答票を撮って送ったりできる専用のQRを印刷します。その班長にだけ渡してください。</p>
        {!space || space.closed_at ? <p class="link-line"><a href={adminPath(ward, `/space/${projectId}`)}>実行委員と班長のページを開いてから印刷する</a></p>
          : <form method="post"><button>班長の専用QRを作って印刷する</button></form>}
      </AdminPage>);
    }
    for (const squad of paperSquads) {
      const token = await createInvite(c.env.DB, ward.wardId, projectId, "leader", squad, c.var.account.accountId, true);
      leaderUrls.set(squad, `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(ward.slug)}/space/${encodeURIComponent(projectId)}/person/${token}`);
    }
  }
  const named = (squad?: string) => printQrUrl(baseUrl, ward.slug, {
    projectId, documentId: row.document_id, version: versionNo, ...(squad ? { squad } : {}),
  });
  const paperCode = await makePaperCode(c.env.DB, ward.wardId, projectId, row.document_id, versionNo);
  const paperQr = (squad?: string) => <div class="qr"><PrintQr text={named(squad)} sizeMm={32} />
    <span>スマホでも答えられます。カメラを向けて、出てきた文字を押してください。</span></div>;
  const labels = labelsFromBody(row.body);
  const helperSlots = paperHelperSlots(publishedItem(row.body, "helper_slots") || "");
  const generalMeeting = row.project_kind === "general_meeting";
  const note = generalMeeting ? meetingNoteFromBody(row.body) : "";
  const answerSheet = (squad: string, standalone = false) => <div class={standalone ? "answer-slip standalone" : "answer-slip"}>
    <div class="slip"><div class="slip-fields">
      {standalone ? <h1>{row.title} 回答票{generalMeeting ? "・委任状" : ""}{squad ? `　${squad}` : ""}</h1> : <h2>{row.title} 回答票{generalMeeting ? "・委任状" : ""}{squad ? `　${squad}` : ""}</h2>}
      {standalone ? <p>{[publishedItem(row.body, "date_time"), publishedItem(row.body, "place"), publishedItem(row.body, "rain_plan")].filter(Boolean).join("。")}</p> : null}
      {generalMeeting ? <MeetingSlipFields note={note} squad={squad} /> : <><p>参加しないときも、答えてください。答えがないときは、欠席として数えます。</p>
      <FieldBox label="代表者のお名前" heightMm={standalone ? 30 : 19} />
      {!squad ? <FieldBox label="班（分からないときは空けてかまいません）" heightMm={10} /> : null}
      <div class="field-box"><p>□ 参加する　　□ 参加しない</p><strong>参加する人数</strong><div class="paper-counts">
        {labels.map((label) => <div class="paper-count"><div>{label}</div><span>人</span></div>)}
      </div><p>いない欄は、空けたままでかまいません。</p></div>
      <div class="field-box" style={standalone ? "min-height:55mm" : "min-height:22mm"}><span class="field-label">手伝える方のお名前と時間帯（書かなくてかまいません）</span>
        {helperSlots ? <p>{helperSlots}</p> : null}
      </div>
      </>}
    </div>{paperQr(squad)}</div>
    <div class="give">{paperGive(due, `${squad ? `${squad}の` : ""}班長か役員`).map((line) => <div>{line}</div>)}</div>
    {standalone && contact ? <p>分からないときは　{contact}</p> : null}
  </div>;
  // 返す案内や時間帯の分も見積もる。文字を縮めず、長ければ回答票を別の紙にする。
  const onOneSheet = withAnswer && fitsAboveAnswer(row.body, generalMeeting
    ? note + due + contact + "□出席□委任□欠席。委任する相手のお名前。代表者のお名前。委任を選んだときは、この回答票を委任状として受け付けます。委任する相手を書かなかったときは、空欄のまま受け付けます。"
    : labels.join("") + helperSlots + due + contact + "参加しないときも、答えてください。答えがないときは、欠席として数えます。□参加する□参加しない。いない欄は、空けたままでかまいません");
  const tables = readPublicationTables(row.tables_snapshot);
  const published = (table: TableKey) => (tables ?? []).filter((entry) => entry.kind === table);
  const footer = (squad = "") => <><span>{ward.name}{squad ? ` ${squad}` : ""}</span><span>{distributed}　紙の番号 {paperCode}</span></>;
  // 公開の文書から開いた当番表の紙は、本文ではなく表を出す。
  const dutyPaper = row.kind === "duty_roster" || row.scope !== "space";
  const withTables = dutyPaper || row.kind === "procedure";
  const reportPhotos = row.kind === "report" && row.scope === "public"
    ? (await listPublicPhotos(c.env, ward.wardId, projectId)).filter((p) => p.document_id === documentId && p.version_no === versionNo) : [];
  const printTitle = `${row.title} ${(kind === "announcement" && !withAnswer) || (kind === "duty" && !dutyPaper) ? "本文の紙" : kindLabel(kind)}`;
  return c.html(<PrintDocument title={printTitle} back={back} copies={copies}>
    {reportPhotos.map((photo) => <Sheet footer={footer()}><h1>{paperHeading(row.title, row.document_title)}</h1>
      <img style="display:block;max-width:100%;max-height:220mm;object-fit:contain" src={`/${ward.slug}/photos/${projectId}/${photo.photo_id}`} alt="行事の報告の写真" />
    </Sheet>)}
    {kind === "announcement" && !withAnswer ? <Sheet footer={footer()}>
      <h1>{paperHeading(row.title, row.document_title)}</h1><PaperBody body={row.body} project={row.title} title={row.document_title} kind={row.kind} />
    </Sheet> : null}
    {kind === "announcement" && withAnswer && onOneSheet ? paperSquads.map((squad) => <Sheet key={squad} footer={footer(squad)}>
      <h1>{paperHeading(row.title, row.document_title)}</h1><PaperBody body={row.body} project={row.title} title={row.document_title} kind={row.kind} /><CutLine />
      {answerSheet(squad)}
    </Sheet>) : null}
    {kind === "announcement" && withAnswer && !onOneSheet ? <>
      <Sheet footer={footer()}>
        <h1>{paperHeading(row.title, row.document_title)}</h1><PaperBody body={row.body} project={row.title} title={row.document_title} kind={row.kind} />
      </Sheet>
      {paperSquads.map((squad) => <Sheet key={squad} footer={footer(squad)}>{answerSheet(squad, true)}</Sheet>)}
    </> : null}
    {kind === "answer" ? paperSquads.map((squad) => <Sheet key={squad} footer={footer(squad)}>{answerSheet(squad, true)}</Sheet>) : null}
    {kind === "leader" ? paperSquads.map((squad) => <Sheet key={squad} footer={footer(squad)}>
      <h1>{squad ? `${squad}の` : ""}班長さんへ</h1>
      <p>{row.title}のご案内をお願いします。{publishedItem(row.body, "date_time") ? <>{publishedItem(row.body, "date_time")}{publishedItem(row.body, "date_time")?.endsWith("から") ? "" : "に"}行います。</> : null}</p>
      <h2>お願いしたいこと</h2>
      <ul>
        <li>案内の紙を、{squad ? `${squad}の` : "班の"}世帯に渡してください。</li>
        {due ? <li>{due.endsWith("まで") ? `答えの締切は${due}です。` : `${due}が答えの締切です。`}会ったときに伝えてもらえると助かります。集めて回らなくてかまいません。</li> : null}
        <li>預かった回答票は、下のQRコードを開いて、撮って送ってください。一枚の写真に何枚写っていてもかまいません。</li>
      </ul>
      <p>写真を送るのが難しいときは、回答票を役員に渡してください。</p>
      <div class="give leader-qr"><PrintQr text={leaderUrls.get(squad)!} sizeMm={42} />
        <div><p><b>{squad ? `${squad}の` : ""}班長のページ</b></p>
          <p>カメラを向けて、出てきた文字を押すと開きます。{squad ? `${squad}の` : "班の"}答えと、配られたものを見られます。</p>
          <p>このQRコードは{squad ? `${squad}の` : ""}班長さん用です。ほかの人に渡さないでください。</p>
        </div>
      </div>
      <p>班長のページの「答えた世帯」に名前が出た回答票は、名前が読めないようにして捨ててかまいません。捨てにくいときや念のため残したいときは、ついでのときに役員に渡してください。</p>
      {contact ? <><h2>なくしたとき、分からないときは</h2><p>{contact}</p></> : null}
    </Sheet>) : null}
    {kind === "duty" ? <Sheet footer={<><span>{ward.name} {dutyPaper ? "当番表と配置図" : DOCUMENT_KIND_LABEL[row.kind as DocumentKind] ?? row.document_title}</span><span>{distributed}　紙の番号 {paperCode}</span></>}>
      <div class="paper-header"><div><h1>{dutyPaper ? `${row.title} 当番表と配置図` : paperHeading(row.title, row.document_title)}</h1>
      {dutyPaper ? <p>{[publishedItem(row.body, "date_time"), publishedItem(row.body, "place"), publishedItem(row.body, "rain_plan")].filter(Boolean).join("。")}</p> : null}
      </div><div class="paper-identity"><PrintQr text={named()} sizeMm={26} /><span>紙の番号<br />{paperCode}</span></div></div>
      {row.scope === "space" ? <PaperBody body={row.body} project={row.title} title={row.document_title} kind={row.kind} itemTable={!dutyPaper} /> : null}
      {!withTables ? null : tables === null ? <p>配ったときの表の記録がありません。表を確かめて配り直してください。</p> : <>
        {dutyPaper || published("duties").length ? <RowsTable table="duties" rows={published("duties")} paperCode={paperCode} /> : null}
        {published("layout").length ? <RowsTable table="layout" rows={published("layout")} paperCode={paperCode} /> : null}
        {published("committee").length ? <RowsTable table="committee" rows={published("committee")} paperCode={paperCode} /> : null}
      </>}
      <div class="field-box" style="min-height:30mm;font-weight:400">変わったこと、メモ　<span>（当日書いて、紙の番号と一緒に撮って送れます）</span></div>
      {contact ? <p>分からないときは　{contact}</p> : null}
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
  const row = await c.env.DB.prepare(`SELECT COALESCE(v.title, d.title) AS title, d.kind, p.kind AS project_kind, v.scope FROM documents d JOIN document_versions v
    ON v.ward_id = d.ward_id AND v.document_id = d.document_id
    JOIN projects p ON p.ward_id = d.ward_id AND p.project_id = d.project_id
    LEFT JOIN publication_records r ON r.ward_id = v.ward_id AND r.version_id = v.version_id
    WHERE v.ward_id = ? AND v.project_id = ? AND v.document_id = ? AND v.version_no = ?
      AND (r.publication_id IS NOT NULL OR (v.scope = 'space' AND v.published_at IS NOT NULL))`)
    .bind(ward.wardId, projectId, documentId, Number(versionNo)).first<{ title: string; kind: string; project_kind: string; scope: string }>();
  if (!row) return c.notFound();
  const withAnswer = collectsAttendance(row.project_kind, row.kind);
  const kinds = row.scope === "space" ? ["duty"] as const : row.kind === "announcement"
    ? printKinds.filter((kind) => withAnswer || (kind !== "answer" && kind !== "leader")) : ["announcement"] as const;
  return c.html(<AdminPage ward={ward} account={account} title="印刷用ページ" back={{ href: adminPath(ward, `/publish/${projectId}`), label: "配る画面へ戻る" }}>
    <h1>{row.title} 印刷用ページ</h1>
    <ul class="rows">{kinds.map((kind) => <li key={kind}><a class="row-link" href={adminPath(ward, `/print/${projectId}/${documentId}/${versionNo}/${kind}`)}><b>{(kind === "announcement" && !withAnswer) || (kind === "duty" && row.kind !== "duty_roster") ? "本文の紙" : kindLabel(kind)}</b>{kind === "poster" ? <span>配った案内の題、日時、場所と、区のページへのQRを大きく出します。印刷や画面の撮影で使えます。</span> : null}</a></li>)}</ul>
  </AdminPage>);
}

function kindLabel(kind: PrintKind): string {
  const labels: Record<PrintKind, string> = { poster: "貼れる一枚", announcement: "案内と回答票", answer: "回答票", leader: "班長への一枚", duty: "当番表と配置図", meeting: "役員会の記入欄", sponsors: "協賛先の一覧" };
  return labels[kind];
}

export const printPages: Bundle = { admin };

/** 紙では項目を表で読み、本文に既に書いた内容は重ねない。 */
export function PaperBody({ body, project, title, kind, itemTable = true }: { body: string; project?: string; title?: string; kind?: string; itemTable?: boolean }) {
  let value: unknown;
  try { value = JSON.parse(body); } catch { return <ArticleBody body={body} />; }
  if (!value || typeof value !== "object" || !("text" in value) || typeof value.text !== "string") return <ArticleBody body={body} />;
  const pending = withoutPending(plainText(value.text));
  const text = project !== undefined && title !== undefined ? withoutTitleLine(pending, project, title) : pending;
  const names: Record<string, string> = { date_time: "いつ", place: "どこで", rain_plan: "雨のとき", content: "内容", belongings: "持ち物", helper_slots: "手伝い", due: "答えの締切", public_contact: "連絡先" };
  // 知らせは本文が正。本文があれば、項目の表を足さない。
  const showItems = itemTable && !(kind === "notice" && text.trim());
  const items = !showItems ? [] : Object.entries(names).flatMap(([key, label]) => {
    const content = publishedItem(body, key);
    return content && !writtenInText(key, content, text) ? [{ label, content: formatDateText(content) }] : [];
  });
  return <>{text.split(/\n{2,}/).filter((part) => part.trim()).map((part) => <p>{part}</p>)}
    {items.length ? <table class="paper-facts"><tbody>{items.map((item) => <tr><th>{item.label}</th><td>{item.content}</td></tr>)}</tbody></table> : null}
  </>;
}

/** 本文の高さを見積もる。表の幅も見込み、一行は全角32字、段落の間は0.4行。 */
function bodyLines(body: string): number {
  const paragraphs = articleParagraphs(body);
  const lines = paragraphs.flatMap((paragraph) => paragraph.split("\n")).reduce((sum, line) => sum + Math.max(1, Math.ceil(line.length / 32)), 0);
  return lines + paragraphs.length * 0.4;
}

export function fitsAboveAnswer(body: string, answerText: string): boolean {
  return bodyLines(body) + Math.ceil(answerText.length / 32) <= 18;
}

/** 今年の中身の表を紙に並べる。空なら何も出さない。 */
export function RowsTable({ table, rows }: { table: TableKey; rows: Pick<RowView, "data">[]; paperCode?: string | null }) {
  if (!rows.length && table !== "sponsors") return <><h2>{TABLES[table].label}</h2><p>{TABLES[table].label}はまだありません。</p></>;
  const fields = Object.entries(TABLES[table].fields);
  return <>
    <h2>{TABLES[table].label}</h2>
    <table class={`paper-table paper-${table}`}><thead><tr>{fields.map(([key, field]) => <th>{table === "sponsors" && key === "ask" ? "お願いした日" : field.label}</th>)}</tr></thead>
      <tbody>{rows.map((entry) => <tr>{fields.map(([key]) => <td>{table === "sponsors" && key === "reply" ? ({ yes: "出す", no: "出さない", pending: "待ち" }[String(entry.data[key])] ?? displayFieldValue(table, key, entry.data[key])) : displayFieldValue(table, key, entry.data[key])}</td>)}</tr>)}{table === "sponsors" ? Array.from({ length: 2 }, (_, index) => <tr key={`blank-${index}`}>{fields.map(() => <td></td>)}</tr>) : null}</tbody></table>
  </>;
}

function PaperField({ label, heightMm, code, text }: { label: string; heightMm: number; code: string | null; text: string }) {
  return <div class="meeting-field" style="display:flex;align-items:flex-start;gap:3mm;margin:2mm 0">
    <FieldBox label={label} heightMm={heightMm} code={code ?? undefined} />
    <PrintQr text={text} sizeMm={24} />
  </div>;
}

