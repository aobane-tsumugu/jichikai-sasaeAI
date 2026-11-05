import { Hono } from "hono";
import { adminPath } from "../core/auth";
import { newId, nowIso } from "../core/ids";
import { Layout, Notice } from "../core/ui";
import type { AdminEnv } from "../env";
import { getReadings, listJobs } from "../intake/store";
import { broadcastLineText, lineAccessToken } from "../line/api";
import { getClient } from "../ai/deps";
import { MODEL } from "../ai/anthropic";
import { applyChange, getProjectState, getProjectSummary } from "./api";

export const followupAdmin = new Hono<AdminEnv>();

followupAdmin.get("/inquiries", async (c) => {
  const { ward } = c.var;
  const records = await c.env.DB.prepare(`SELECT inquiry_id, received_at, kind, subject, answer, submitted_to_city
    FROM inquiry_records WHERE ward_id = ? ORDER BY received_at DESC, created_at DESC LIMIT 200`)
    .bind(ward.wardId).all<{ inquiry_id: string; received_at: string; kind: "inquiry" | "request"; subject: string; answer: string; submitted_to_city: number }>();
  return c.html(<Layout title="問い合わせ" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <h1>問い合わせと要望</h1>
    {c.req.query("saved") ? <Notice>記録しました。</Notice> : null}
    <form method="post" action={adminPath(ward, "/inquiries")} class="panel">
      <label for="receivedAt">受けた日</label><input id="receivedAt" name="receivedAt" type="date" required />
      <label for="kind">種類</label><select id="kind" name="kind"><option value="inquiry">問い合わせ</option><option value="request">要望</option></select>
      <label for="subject">何を受けたか</label><textarea id="subject" name="subject" maxlength={2000} required />
      <label for="answer">どう答えたか</label><textarea id="answer" name="answer" maxlength={2000} required />
      <label><input type="checkbox" name="submittedToCity" value="yes" /> 行政に出した</label>
      <button type="submit">記録する</button>
    </form>
    <h2>対応の記録</h2>
    {records.results.map((record) => <article class="panel"><p>{record.received_at} / {record.kind === "request" ? "要望" : "問い合わせ"}</p>
      <h3>{record.subject}</h3><p>答え: {record.answer}</p><p>{record.submitted_to_city ? "行政に提出" : "行政への提出なし"}</p></article>)}
    <h2>要望の一覧</h2>
    {records.results.filter((record) => record.kind === "request").map((record) => <article class="panel"><p>{record.received_at}</p><h3>{record.subject}</h3><p>{record.submitted_to_city ? "行政に提出" : "行政への提出なし"}</p></article>)}
    {records.results.length === 0 ? <p>記録はありません。</p> : null}
    <p><a href={adminPath(ward, "/")}>役員画面へ</a></p>
  </Layout>);
});

followupAdmin.post("/inquiries", async (c) => {
  const { ward, account } = c.var;
  const form = await c.req.formData();
  const receivedAt = String(form.get("receivedAt") ?? "");
  const kind = String(form.get("kind") ?? "");
  const subject = String(form.get("subject") ?? "").trim();
  const answer = String(form.get("answer") ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(receivedAt) || !["inquiry", "request"].includes(kind) || !subject || !answer || subject.length > 2000 || answer.length > 2000) {
    return c.text("入力を確かめてください。", 400);
  }
  await c.env.DB.prepare(`INSERT INTO inquiry_records
    (inquiry_id, ward_id, received_at, kind, subject, answer, submitted_to_city, created_by_account_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(newId(), ward.wardId, receivedAt, kind, subject, answer, form.get("submittedToCity") === "yes" ? 1 : 0, account.accountId, nowIso()).run();
  return c.redirect(`${adminPath(ward, "/inquiries")}?saved=1`, 303);
});

interface CityRequestRow {
  project_id: string;
  title: string;
  year: number;
  due_on: string | null;
  submitted_on: string | null;
}

followupAdmin.get("/requests/city", async (c) => {
  const { ward } = c.var;
  const projects = await c.env.DB.prepare(`SELECT p.project_id, p.title, p.year, d.due_on, d.submitted_on
    FROM projects p LEFT JOIN city_request_details d ON d.ward_id = p.ward_id AND d.project_id = p.project_id
    WHERE p.ward_id = ? AND p.kind = 'city_request' ORDER BY COALESCE(d.due_on, '9999-12-31'), p.year DESC, p.created_at DESC`)
    .bind(ward.wardId).all<CityRequestRow>();
  const rows = await Promise.all(projects.results.map(async (project) => {
    const state = await getProjectState(c.env.DB, ward.wardId, project.project_id);
    return { ...project, dueOn: project.due_on ?? state?.items.find((item) => item.key === "due")?.current?.content ?? null };
  }));
  rows.sort((a, b) => (a.dueOn ?? "9999-12-31").localeCompare(b.dueOn ?? "9999-12-31") || b.year - a.year);
  return c.html(<Layout title="行政の依頼" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <h1>行政の依頼</h1>
    <p>届いた通知をもとに、期限、回答、提出した物を記録します。</p>
    {rows.map((project) => <article class="panel"><h2><a href={adminPath(ward, `/requests/city/${encodeURIComponent(project.project_id)}`)}>{project.title}</a></h2>
      <p>{project.year}年 / 期限: {project.dueOn ?? "未入力"} / 提出: {project.submitted_on ?? "未記録"}</p></article>)}
    {rows.length === 0 ? <p>行政の依頼はありません。</p> : null}
    <p><a href={adminPath(ward, "/")}>役員画面へ</a></p>
  </Layout>);
});

followupAdmin.get("/requests/city/:projectId", async (c) => {
  const { ward } = c.var;
  const projectId = c.req.param("projectId");
  const project = await getProjectSummary(c.env.DB, ward.wardId, projectId);
  if (!project || project.kind !== "city_request") return c.notFound();
  const state = await getProjectState(c.env.DB, ward.wardId, projectId);
  const readDue = state?.items.find((item) => item.key === "due")?.current?.content ?? "";
  const details = await c.env.DB.prepare(`SELECT due_on, answer_draft, submitted_what, submitted_to, submitted_on, notice_body
    FROM city_request_details WHERE ward_id = ? AND project_id = ?`).bind(ward.wardId, projectId)
    .first<{ due_on: string | null; answer_draft: string; submitted_what: string; submitted_to: string; submitted_on: string | null; notice_body: string }>();
  const jobs = await listJobs(c.env.DB, ward.wardId, { projectId, limit: 20 });
  const readings = await Promise.all(jobs.map((job) => getReadings(c.env.DB, ward.wardId, job.job_id)));
  const sourceText = readings.flatMap((rows) => rows.map((row) => row.body.summary)).filter(Boolean).join("\n").slice(0, 6000);
  return c.html(<Layout title={project.title} siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <h1>{project.title}</h1><p><a href={adminPath(ward, "/requests/city")}>行政の依頼一覧</a></p>
    {c.req.query("saved") ? <Notice>記録しました。</Notice> : null}
    {c.req.query("sent") ? <Notice>公式 LINE で送りました。</Notice> : null}
    {c.req.query("error") ? <Notice error>送れませんでした。文と公式 LINE の設定を確かめてください。</Notice> : null}
    {sourceText ? <details class="panel"><summary>通知から読んだ要点</summary><p>{sourceText}</p></details> : null}
    <form method="post" action={adminPath(ward, `/requests/city/${encodeURIComponent(projectId)}`)} class="panel">
      {readDue ? <p>通知から読んだ期限: {readDue}</p> : null}
      <label for="dueOn">期限</label><input id="dueOn" name="dueOn" type="date" value={details?.due_on ?? (/^\d{4}-\d{2}-\d{2}$/.test(readDue) ? readDue : "")} />
      <label for="answerDraft">回答の案</label><textarea id="answerDraft" name="answerDraft" maxlength={6000} rows={10}>{details?.answer_draft ?? ""}</textarea>
      <button class="secondary" name="operation" value="draft">通知をもとに回答案を作る</button>
      <label for="submittedWhat">提出した物</label><input id="submittedWhat" name="submittedWhat" maxlength={1000} value={details?.submitted_what ?? ""} />
      <label for="submittedTo">提出先</label><input id="submittedTo" name="submittedTo" maxlength={300} value={details?.submitted_to ?? ""} />
      <input type="hidden" name="submissionId" value={newId()} />
      <label for="submittedOn">提出した日</label><input id="submittedOn" name="submittedOn" type="date" value={details?.submitted_on ?? ""} />
      <label for="noticeBody">住民に配る文</label><textarea id="noticeBody" name="noticeBody" maxlength={4000} rows={6}>{details?.notice_body ?? ""}</textarea>
      <button name="operation" value="save">記録する</button>
      <button class="secondary" name="operation" value="send">公式 LINE で配る</button>
    </form>
  </Layout>);
});

followupAdmin.post("/requests/city/:projectId", async (c) => {
  const { ward, account } = c.var;
  const projectId = c.req.param("projectId");
  const project = await getProjectSummary(c.env.DB, ward.wardId, projectId);
  if (!project || project.kind !== "city_request") return c.notFound();
  const form = await c.req.formData();
  const operation = String(form.get("operation") ?? "save");
  const dueOn = String(form.get("dueOn") ?? "");
  const answerDraft = String(form.get("answerDraft") ?? "").trim();
  const submittedWhat = String(form.get("submittedWhat") ?? "").trim();
  const submittedTo = String(form.get("submittedTo") ?? "").trim();
  const submissionId = String(form.get("submissionId") ?? "");
  const submittedOn = String(form.get("submittedOn") ?? "");
  const noticeBody = String(form.get("noticeBody") ?? "").trim();
  if ((dueOn && !/^\d{4}-\d{2}-\d{2}$/.test(dueOn)) || (submittedOn && !/^\d{4}-\d{2}-\d{2}$/.test(submittedOn))) return c.text("日付を確かめてください。", 400);

  let nextAnswer = answerDraft;
  if (operation === "draft") {
    const jobs = await listJobs(c.env.DB, ward.wardId, { projectId, limit: 20 });
    const readings = await Promise.all(jobs.map((job) => getReadings(c.env.DB, ward.wardId, job.job_id)));
    const text = readings.flatMap((rows) => rows.map((row) => row.body.summary)).filter(Boolean).join("\n").slice(0, 6000);
    const response = await getClient(c.env).messages.create({
      model: MODEL.main,
      max_tokens: 1800,
      system: "自治会の役員が行政へ提出する回答の案を作ります。通知とプロジェクトの情報に書かれている事実だけを使い、不明点は確認事項として示してください。提出や決定は行わず、日本語で案の本文だけを書いてください。",
      messages: [{ role: "user", content: `依頼: ${project.title}\n年度: ${project.year}\n期限: ${dueOn || "未記入"}\n通知の読み取り:\n${text || "通知の読み取りはありません。"}\n現在の案:\n${answerDraft || "ありません。"}` }],
    });
    nextAnswer = response.content.filter((block) => block.type === "text").map((block) => block.text).join("\n").slice(0, 6000);
  }
  if (operation === "send") {
    if (!noticeBody || noticeBody.length > 4000) return c.text("配る文を入力してください。", 400);
    const now = nowIso();
    await saveCityRequestDetails(c.env.DB, ward.wardId, projectId, dueOn || null, nextAnswer, submittedWhat, submittedTo, submittedOn || null, noticeBody, null, account.accountId, now);
    await recordSubmittedItem(c.env.DB, ward.wardId, projectId, submittedWhat, submittedTo, submittedOn, submissionId, account.accountId);
    try {
      await broadcastLineText(lineAccessToken(c.env), noticeBody);
    } catch {
      return c.redirect(`${adminPath(ward, `/requests/city/${encodeURIComponent(projectId)}`)}?error=1`, 303);
    }
    await c.env.DB.prepare("UPDATE city_request_details SET notice_sent_at = ?, updated_at = ? WHERE ward_id = ? AND project_id = ?")
      .bind(now, now, ward.wardId, projectId).run();
    return c.redirect(`${adminPath(ward, `/requests/city/${encodeURIComponent(projectId)}`)}?sent=1`, 303);
  }
  const now = nowIso();
  await saveCityRequestDetails(c.env.DB, ward.wardId, projectId, dueOn || null, nextAnswer, submittedWhat, submittedTo, submittedOn || null, noticeBody, null, account.accountId, now);
  await recordSubmittedItem(c.env.DB, ward.wardId, projectId, submittedWhat, submittedTo, submittedOn, submissionId, account.accountId);
  return c.redirect(`${adminPath(ward, `/requests/city/${encodeURIComponent(projectId)}`)}?saved=1`, 303);
});

async function recordSubmittedItem(
  db: D1Database,
  wardId: string,
  projectId: string,
  what: string,
  to: string,
  submittedOn: string,
  requestId: string,
  accountId: string,
): Promise<void> {
  if (!what || !submittedOn) return;
  await applyChange(db, wardId, projectId, {
    kind: "row",
    table: "submissions",
    data: { what, ...(to ? { to } : {}), submittedOn },
    source: { kind: "person", accountId },
    confidence: "high",
    packVersion: "person-submission@1",
    requestId: requestId || newId(),
  }, { actorAccountId: accountId });
}

async function saveCityRequestDetails(
  db: D1Database,
  wardId: string,
  projectId: string,
  dueOn: string | null,
  answerDraft: string,
  submittedWhat: string,
  submittedTo: string,
  submittedOn: string | null,
  noticeBody: string,
  noticeSentAt: string | null,
  accountId: string,
  now: string,
): Promise<void> {
  await db.prepare(`INSERT INTO city_request_details
    (ward_id, project_id, due_on, answer_draft, submitted_what, submitted_to, submitted_on, notice_body, notice_sent_at, updated_at, updated_by_account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (ward_id, project_id) DO UPDATE SET due_on = excluded.due_on, answer_draft = excluded.answer_draft,
      submitted_what = excluded.submitted_what, submitted_to = excluded.submitted_to, submitted_on = excluded.submitted_on, notice_body = excluded.notice_body,
      notice_sent_at = CASE WHEN excluded.notice_sent_at IS NOT NULL THEN excluded.notice_sent_at ELSE city_request_details.notice_sent_at END,
      updated_at = excluded.updated_at, updated_by_account_id = excluded.updated_by_account_id`)
    .bind(wardId, projectId, dueOn, answerDraft, submittedWhat, submittedTo, submittedOn, noticeBody, noticeSentAt, now, accountId).run();
}

interface LedgerTotals { year: number; income: number; expense: number; }

followupAdmin.get("/ledger", async (c) => {
  const { ward } = c.var;
  const rows = await c.env.DB.prepare(`SELECT p.year, r.data FROM project_rows r JOIN projects p
    ON p.ward_id = r.ward_id AND p.project_id = r.project_id
    WHERE r.ward_id = ? AND r.table_key = 'ledger' AND r.scope = 'current' AND r.removed_at IS NULL`)
    .bind(ward.wardId).all<{ year: number; data: string }>();
  const totals = new Map<number, LedgerTotals>();
  for (const row of rows.results) {
    const data = JSON.parse(row.data) as { direction?: string; amount?: number };
    const total = totals.get(row.year) ?? { year: row.year, income: 0, expense: 0 };
    if (data.direction === "income" && Number.isInteger(data.amount)) total.income += data.amount as number;
    if (data.direction === "expense" && Number.isInteger(data.amount)) total.expense += data.amount as number;
    totals.set(row.year, total);
  }
  const years = [...totals.keys()].sort((a, b) => b - a);
  if (!years.includes(new Date().getFullYear())) years.unshift(new Date().getFullYear());
  const budgets = await c.env.DB.prepare("SELECT year, budget_income, budget_expense, settlement_draft FROM ward_annual_budgets WHERE ward_id = ? ORDER BY year DESC")
    .bind(ward.wardId).all<{ year: number; budget_income: number; budget_expense: number; settlement_draft: string }>();
  const budgetByYear = new Map(budgets.results.map((budget) => [budget.year, budget]));
  for (const budget of budgets.results) if (!years.includes(budget.year)) years.push(budget.year);
  years.sort((a, b) => b - a);
  return c.html(<Layout title="帳簿" siteName={ward.name} noindex adminHomeHref={adminPath(ward, "/")}>
    <h1>帳簿</h1><p>収支の記録から年ごとに集計しています。監査の判断は人が行います。</p>
    {c.req.query("saved") ? <Notice>記録しました。</Notice> : null}
    {years.map((year) => {
      const total = totals.get(year) ?? { year, income: 0, expense: 0 };
      const budget = budgetByYear.get(year);
      const draft = `収入合計: ${total.income.toLocaleString("ja-JP")} 円\n支出合計: ${total.expense.toLocaleString("ja-JP")} 円\n差引: ${(total.income - total.expense).toLocaleString("ja-JP")} 円\n監査の確認: 人が確認してください。`;
      return <section class="panel"><h2>{year}年</h2>
        <p>収入 {total.income.toLocaleString("ja-JP")} 円 / 予算 {budget?.budget_income.toLocaleString("ja-JP") ?? "未入力"} 円</p>
        <p>支出 {total.expense.toLocaleString("ja-JP")} 円 / 予算 {budget?.budget_expense.toLocaleString("ja-JP") ?? "未入力"} 円</p>
        <p>差引 {((total.income ?? 0) - (total.expense ?? 0)).toLocaleString("ja-JP")} 円</p>
        {budget ? <p>予算との差: 収入 {(total.income - budget.budget_income).toLocaleString("ja-JP")} 円 / 支出 {(total.expense - budget.budget_expense).toLocaleString("ja-JP")} 円</p> : <p>予算との差: 予算を入力してください。</p>}
        <form method="post" action={adminPath(ward, "/ledger")}>
          <input type="hidden" name="year" value={year} />
          <label for={`income-${year}`}>収入の予算（円）</label><input id={`income-${year}`} name="budgetIncome" type="number" min="0" step="1" value={budget?.budget_income ?? 0} required />
          <label for={`expense-${year}`}>支出の予算（円）</label><input id={`expense-${year}`} name="budgetExpense" type="number" min="0" step="1" value={budget?.budget_expense ?? 0} required />
          <label for={`settlement-${year}`}>決算の下書き</label><textarea id={`settlement-${year}`} name="settlementDraft" rows={5} maxlength={4000}>{budget?.settlement_draft || draft}</textarea>
          <button type="submit">予算と下書きを保存</button>
        </form>
      </section>;
    })}
    <p><a href={adminPath(ward, "/projects")}>プロジェクトの収支記録へ</a></p>
  </Layout>);
});

followupAdmin.post("/ledger", async (c) => {
  const { ward, account } = c.var;
  const form = await c.req.formData();
  const year = Number(form.get("year"));
  const budgetIncome = Number(form.get("budgetIncome"));
  const budgetExpense = Number(form.get("budgetExpense"));
  const settlementDraft = String(form.get("settlementDraft") ?? "").trim();
  if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(budgetIncome) || budgetIncome < 0 || !Number.isInteger(budgetExpense) || budgetExpense < 0 || settlementDraft.length > 4000) return c.text("入力を確かめてください。", 400);
  await c.env.DB.prepare(`INSERT INTO ward_annual_budgets
    (ward_id, year, budget_income, budget_expense, settlement_draft, updated_at, updated_by_account_id)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (ward_id, year) DO UPDATE SET budget_income = excluded.budget_income,
      budget_expense = excluded.budget_expense, settlement_draft = excluded.settlement_draft,
      updated_at = excluded.updated_at, updated_by_account_id = excluded.updated_by_account_id`)
    .bind(ward.wardId, year, budgetIncome, budgetExpense, settlementDraft, nowIso(), account.accountId).run();
  return c.redirect(`${adminPath(ward, "/ledger")}?saved=1`, 303);
});
