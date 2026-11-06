// staging の役員画面を HTTP でたどる。資格情報は表示・記録しない。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// 下書きと当番表の案が見えるまで最大180秒待つ。
const DRAFT_WAIT_LIMIT_MS = 360_000;
const args = process.argv.slice(2);
const arg = (key: string) => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
const onlyPublic = args.includes("--only-public");
const ward = arg("--ward");
const baseArg = arg("--base");
if (!ward || !baseArg || (!onlyPublic && !arg("--creds"))) {
  console.error("使い方: npm run walkthrough -- --base <URL> --ward <区のURL名> --creds <資格情報ファイル> [--only-public]");
  process.exit(2);
}
const base = new URL(baseArg).toString().replace(/\/$/, "");
const origin = new URL(base).origin;
const wardPath = "/" + encodeURIComponent(ward);
const admin = wardPath + "/admin";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidence = resolve(root, "docs/EVIDENCE/walkthrough-" + stamp + ".md");
mkdirSync(dirname(evidence), { recursive: true });
const rows: string[] = [];
const cookies = new Map<string, { pair: string; path: string }>();
const sensitiveValues = new Set<string>();
let lastResponse = "応答を取得していません";
let currentStage = "準備";
let currentStarted = Date.now();
function record(stage: string, result: string, what: string, start: number) {
  if (result === "停止" || result === "未完了") what += "（" + lastResponse + "）";
  rows.push("| " + stage + " | " + result + " | " + what.replaceAll("|", "／") + " | " + Math.round((Date.now() - start) / 1000) + " |");
  writeFileSync(evidence, [
    "# staging通し確認 " + new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }), "",
    "- 区: " + ward, "- 一斉送信: 実送信なし（送らない選択）", "- 資格情報: 値は記録していません", "",
    "| 段 | 結果 | 見えた物 | 秒 |", "|---|---|---|---:|", ...rows, ""
  ].join("\n"), "utf8");
  console.log(stage + ": " + result + " (" + Math.round((Date.now() - start) / 1000) + " 秒)");
  currentStage = "完了";
}
function skipStage(stage: string, reason: string) {
  record(stage, "飛ばす", reason, Date.now());
  process.exitCode = 1;
}
function unescapeHtml(s: string) {
  return s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
async function req(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("origin", origin);
  const url = new URL(path, base + "/");
  const applicableCookies = [...cookies.values()]
    .filter(cookie => url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : cookie.path + "/"))
    .map(cookie => cookie.pair);
  if (applicableCookies.length) headers.set("cookie", applicableCookies.join("; "));
  const res = await fetch(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
  let body = await res.clone().text().catch(() => "");
  for (const secret of sensitiveValues) if (secret) body = body.replaceAll(secret, "[伏せ字]");
  const snippet = body.replace(/\s+/g, " ").slice(0, 200).replaceAll("|", "／");
  lastResponse = "応答: HTTP " + res.status + (res.statusText ? " " + res.statusText : "") + "; 本文先頭200文字: " + (snippet || "（空）");
  for (const line of res.headers.getSetCookie()) {
    const pair = line.split(";", 1)[0];
    if (pair) {
      const separator = pair.indexOf("=");
      if (separator > 0) {
        const cookiePath = /(?:^|;)\s*path=([^;]+)/i.exec(line)?.[1] ?? url.pathname;
        cookies.set(pair.slice(0, separator), { pair, path: cookiePath.replace(/\/$/, "") || "/" });
      }
    }
  }
  return res;
}
async function post(path: string, values: Record<string, string> | URLSearchParams) {
  return req(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values) });
}
async function get(path: string) {
  const response = await req(path);
  return { response, html: await response.text() };
}
function visibleText(html: string) {
  return unescapeHtml(html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, "").trim();
}
async function paper(printPath: string, kind: "announcement" | "answer" | "duty") {
  const page = await get(printPath + "/" + kind);
  if (!page.response.ok) throw new Error("紙を開けません: " + kind);
  // ページの題や操作ボタンではなく、刷る範囲だけを照合する。
  const sheets = [...page.html.matchAll(/<section\b[^>]*class="[^"]*\bsheet\b[^"]*"[^>]*>([\s\S]*?)<\/section>/gi)];
  if (!sheets.length) throw new Error("刷る範囲がありません: " + kind);
  return sheets.map(sheet => sheet[1] ?? "").join("\n");
}
function checkAnnouncement(html: string, title: string, fields: Record<string, string>) {
  const text = visibleText(html);
  for (const [label, expected] of [["行事名", title], ["日時", fields.item_date_time], ["場所", fields.item_place]]) {
    if (!expected?.trim()) throw new Error("案内の" + label + "が空で、紙と照合できません");
    if (!text.includes(expected.replace(/\s+/g, ""))) throw new Error("案内の紙に" + label + "がありません");
  }
}
function checkAnswer(html: string) {
  const give = /<div\b[^>]*class="[^"]*\bgive\b[^"]*"[^>]*>((?:\s*<div\b[^>]*>[\s\S]*?<\/div>)+)\s*<\/div>/i.exec(html)?.[1] ?? "";
  const text = visibleText(give);
  if (!/締切|まで/.test(text)) throw new Error("回答票の紙に締切がありません");
  if (!/(?:班長|役員)[^。]*渡/.test(text)) throw new Error("回答票の紙に班長か役員への渡し先がありません");
}
function checkDuty(html: string) {
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const head = /<thead\b[^>]*>([\s\S]*?)<\/thead>/i.exec(table[1] ?? "")?.[1] ?? "";
    const headings = [...head.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].at(-1)?.[1] ?? "";
    const assignee = [...headings.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)].findIndex(cell => visibleText(cell[1] ?? "") === "担当");
    if (assignee < 0) continue;
    const body = /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i.exec(table[1] ?? "")?.[1] ?? "";
    for (const row of body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...(row[1] ?? "").matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)];
      const name = visibleText(cells[assignee]?.[1] ?? "");
      if (name && !/^(?:未定|未記入|未割当|調整中|なし|[-—―]+)$/.test(name)) return;
    }
  }
  throw new Error("当番表の紙に担当の名前が一人もありません");
}
function checkNoticeOrder(html: string, notice: string, announcement: string) {
  const articles = [...html.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map(article => visibleText(article[1] ?? ""));
  const noticeIndex = articles.findIndex(text => text.includes(notice.replace(/\s+/g, "")));
  const announcementIndex = articles.findIndex(text => text.includes(announcement.replace(/\s+/g, "")));
  if (noticeIndex < 0 || announcementIndex < 0 || noticeIndex >= announcementIndex) throw new Error("区のページで知らせが配った案内より上にありません");
}
function readForm(html: string, path: string, sectionTitle?: string) {
  for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const action = unescapeHtml(/\baction="([^"]*)"/i.exec(form[1] ?? "")?.[1] ?? "");
    if (!action.includes(path)) continue;
    const sectionStart = html.lastIndexOf("<section", form.index ?? 0);
    if (sectionTitle && !html.slice(sectionStart, form.index).includes(sectionTitle)) continue;
    const fields: Record<string, string> = {};
    const values = new URLSearchParams();
    const body = form[2] ?? "";
    for (const input of body.matchAll(/<input\b([^>]*)>/gi)) {
      const a = input[1] ?? "";
      if (/type="(?:checkbox|radio)"/i.test(a) && !/\bchecked(?:\s|=|$)/i.test(a)) continue;
      const name = /\bname="([^"]*)"/i.exec(a)?.[1];
      const type = /\btype="([^"]*)"/i.exec(a)?.[1];
      if (name && type !== "file" && type !== "submit") {
        const value = unescapeHtml(/\bvalue="([^"]*)"/i.exec(a)?.[1] ?? "");
        fields[name] = value;
        if (type !== "checkbox" && type !== "radio" || /\bchecked(?:\s|=|$)/i.test(a)) values.append(name, value);
      }
    }
    for (const t of body.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
      const name = /\bname="([^"]*)"/i.exec(t[1] ?? "")?.[1];
      if (name) { fields[name] = unescapeHtml(t[2] ?? ""); values.append(name, fields[name]); }
    }
    for (const s of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const name = /\bname="([^"]*)"/i.exec(s[1] ?? "")?.[1];
      const options = [...(s[2] ?? "").matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
      const selected = options.find(o => /\bselected(?:\s|=|>)/i.test(o[1] ?? "")) ?? options[0];
      if (name && selected) fields[name] = unescapeHtml(/\bvalue="([^"]*)"/i.exec(selected[1] ?? "")?.[1] ?? (selected[2] ?? ""));
    }
    return { action, fields, values };
  }
  throw new Error("画面の入力欄がありません: " + path);
}
async function waitFor(name: string, project: string): Promise<boolean> {
  const until = Date.now() + 600_000;
  while (Date.now() < until) {
    const { html } = await get(admin + "/intake/received?project=" + encodeURIComponent(project));
    const pos = html.indexOf(name);
    const state = pos < 0 ? html : html.slice(pos, pos + 900);
    if (state.includes("行事に入れました")) return true;
    if (state.includes("読めませんでした") || state.includes("読み取りが遅れています")) throw new Error(name + " の読み取り・反映が止まりました");
    await new Promise(r => setTimeout(r, 3000));
  }
  return false;
}
async function waitForDraft(path: string, timeoutMs = DRAFT_WAIT_LIMIT_MS): Promise<{ ready: boolean; form: ReturnType<typeof readForm> }> {
  const until = Date.now() + timeoutMs;
  let page = await get(path);
  let form = readForm(page.html, "/save");
  while (Date.now() < until) {
    const status = /data-ai-status="([^"]+)"/.exec(page.html)?.[1];
    if (status === "done") return { ready: !!form.fields.text?.trim(), form };
    if (status === "attention" || status === "failed") return { ready: false, form };
    await new Promise(r => setTimeout(r, 3000));
    page = await get(path);
    form = readForm(page.html, "/save");
  }
  return { ready: false, form };
}
async function publish(project: string, html: string, scope: "public" | "space", sectionTitle?: string) {
  const suffix = scope === "public" ? "/confirm" : "/space";
  const first = readForm(html, "/publish/" + project + suffix, sectionTitle);
  if (!first.fields.documentId || !first.fields.versionNo) throw new Error("配る文書と紙を結び付けられません");
  const printPath = admin + "/print/" + project + "/" + encodeURIComponent(first.fields.documentId) + "/" + encodeURIComponent(first.fields.versionNo);
  if (scope === "public") first.fields.lineDelivery = "skip";
  const confirm = await post(first.action, first.fields);
  if (scope === "space") {
    // 空間への配布は一度の操作で完了し、成功時は公開範囲画面へ303で戻る。
    if (confirm.status !== 303) throw new Error("実行委員と班長のページへの配布で停止 (" + confirm.status + ")");
    return { response: confirm, printPath };
  }
  if (!confirm.ok) throw new Error("配布内容の確認で停止 (" + confirm.status + ")");
  const page = await confirm.text();
  if (!page.includes("今回は公式LINEに送りません")) throw new Error("LINEを送らない選択を確認できません");
  const final = readForm(page, "/publish/" + project + "/send");
  if (final.fields.lineDelivery !== "skip") throw new Error("LINE送信を止められません");
  return { response: await post(final.action, final.fields), printPath };
}
async function runPublic() {
  const start = Date.now();
  currentStage = "公開確認";
  currentStarted = start;
  const home = await get(wardPath + "/");
  if (!home.response.ok) throw new Error("区の公開ページを開けません");
  const found = [...home.html.matchAll(/href="(\/[^"]+\/p\/[^"#?]+)"/g)];
  if (!found.length) throw new Error("公開された案内がありません");
  const link = unescapeHtml(found.at(-1)?.[1] ?? "");
  const publicPage = await get(link);
  const project = link.split("/").at(-1) ?? "";
  const answer = await get(wardPath + "/answer/" + project);
  if (!publicPage.response.ok || !answer.response.ok) throw new Error("公開のお知らせまたは答え入口を開けません");
  record("公開確認", "通過", "公開のお知らせと登録なしの答え入口。役員入るなし。", start);
}
async function runFull() {
  let intakeOk = false;
  const unfinished: string[] = [];
  let publicPublished = false;
  let project = "";
  let projectTitle = "";
  let announcementText = "";
  let draftPath = "";
  let publicPath = "";
  let start = Date.now();
  currentStage = "0";
  currentStarted = start;
  try {
    const cred = readFileSync(resolve(arg("--creds")!), "utf8");
    const name = /^(?:名前|氏名)\s*[:：]\s*(.+)$/m.exec(cred)?.[1]?.trim();
    const password = /^パスワード\s*[:：]\s*(.+)$/m.exec(cred)?.[1]?.trim();
    if (!name || !password) throw new Error("資格情報は「名前:」「パスワード:」形式で指定してください");
    sensitiveValues.add(password);
    const login = await post(admin + "/login", { name, password });
    if (login.status !== 303 || !cookies.has("device") || !(await get(admin + "/")).response.ok) throw new Error("役員画面に入れません");
    record("0", "通過", "資格情報で入る。値は表示していない。", start);
  } catch (error) {
    const message = error instanceof Error ? error.message : "処理に失敗しました";
    record("0", "停止", message, start);
    process.exitCode = 1;
    for (const n of ["1", "2", "3", "4", "5", "6"]) skipStage(n, "役員画面に入れず、後続操作を実行できません");
    return;
  }

  start = Date.now();
  currentStage = "1";
  currentStarted = start;
  try {
  const opened = await post(admin + "/projects", { kind: "event", year: String(new Date().getFullYear()) });
  project = /\/projects\/([^/]+)\/map$/.exec(opened.headers.get("location") ?? "")?.[1] ?? "";
  if (opened.status !== 303 || !project) throw new Error("新しい行事を開けません");
  projectTitle = "架空 秋の収穫祭 " + stamp.slice(0, 13);
  await post(admin + "/projects/" + project + "/title", { title: projectTitle });
  record("1", "通過", "新規行事「" + projectTitle + "」を作成。", start);
  } catch (error) {
    const message = error instanceof Error ? error.message : "処理に失敗しました";
    record("1", "停止", message, start);
    process.exitCode = 1;
    for (const n of ["2", "3", "4", "5", "6"]) skipStage(n, "行事を作成できず、後続操作を実行できません");
    return;
  }

  start = Date.now();
  currentStage = "2";
  currentStarted = start;
  try {
  const files = [
    "fixtures/last-year/accountant/IMG_2081.jpg",
    "fixtures/last-year/vice-chair/配置のメモ.jpg",
    "fixtures/this-year/meeting/役員会のメモ.jpg",
    "fixtures/this-year/meeting/電話の結果_公民館.txt"
  ];
  for (const relative of files) {
    const path = resolve(root, relative);
    const filename = basename(path);
    const type = filename.toLowerCase().endsWith(".jpg") ? "image/jpeg" : "text/plain";
    const data = new FormData();
    data.set("project_id", project);
    data.append("part", new Blob([readFileSync(path)], { type }), filename);
    data.append("part_kind", type === "image/jpeg" ? "photo" : "file");
    const sent = await req(admin + "/intake", { method: "POST", headers: { accept: "application/json" }, body: data });
    const result = await sent.json().catch(() => null) as { ok?: boolean; jobId?: string | null; duplicates?: number } | null;
    if (!sent.ok || !result?.ok) throw new Error("架空資料を送れません: " + filename);
    if (result.jobId) {
      try {
        if (!(await waitFor(filename, project))) unfinished.push(filename + "（読み取り・反映待ちの上限）");
      } catch (error) {
        unfinished.push(filename + "（" + (error instanceof Error ? error.message : "読み取り未完了") + "）");
      }
    } else if (!result.duplicates) {
      throw new Error("送信結果に届いたものも同じものの記録もありません: " + filename);
    }
  }
  if ((await post(admin + "/projects/" + project + "/draft/announcement/start", {})).status !== 303) throw new Error("AIに案内を頼めません");
  draftPath = admin + "/projects/" + project + "/draft/announcement";
  const draftResult = await waitForDraft(draftPath);
  const draft = draftResult.form;
  if (!draftResult.ready) {
    unfinished.push("案内の下書き（AI依頼の完了待ちの上限）");
    if (!draft.fields.text?.trim()) {
      draft.fields.text = "架空の秋の収穫祭を開催します。日時と会場は今年の中身をご確認ください。";
      if ((await post(draft.action, draft.fields)).status !== 303) throw new Error("手書きの案内を保存できません");
    }
  }
  const published = await publish(project, (await get(admin + "/publish/" + project)).html, "public");
  if (published.response.status !== 303) throw new Error("案内を公開できません");
  publicPath = wardPath + "/p/" + project;
  if (!(await get(publicPath)).response.ok) throw new Error("公開ページを開けません");
  checkAnnouncement(await paper(published.printPath, "announcement"), projectTitle, draft.fields);
  checkAnswer(await paper(published.printPath, "answer"));
  announcementText = draft.fields.text ?? "";
  publicPublished = true;
  intakeOk = unfinished.length === 0;
  if (!intakeOk) process.exitCode = 1;
  record("2", intakeOk ? "通過" : "未完了", "架空の実ファイル4件を送信。同じものはそのまま利用。案内の紙に行事名・日時・場所、回答票に締切と班長か役員への渡し先を確認。公式LINEは送信なし。" + (unfinished.length ? " 未完了: " + unfinished.join("、") : " AIの読み取り・反映と案内作成を確認。"), start);
  } catch (error) {
    const message = error instanceof Error ? error.message : "処理に失敗しました";
    record("2", "停止", message, start);
    process.exitCode = 1;
  }

  if (publicPublished) try {
  start = Date.now();
  currentStage = "3";
  currentStarted = start;
  const answer = await post(wardPath + "/answer/" + project, {
    household: "架空 小林", district: "1班", children_count: "0", adults_count: "2", seniors_count: "0", helper_name: "架空 小林さと", helper_times: "受付10:30-12:00"
  });
  if (answer.status !== 200 || !(await answer.text()).includes("答えを受け付けました")) throw new Error("架空の答えを送れません");
  record("3", "通過", "公開された案内から架空の答えを送信。", start);
  } catch (error) {
    const message = error instanceof Error ? error.message : "処理に失敗しました";
    record("3", "停止", message, start);
    process.exitCode = 1;
  }
  else skipStage("3", "段2が完了していないため、公開できる状態か確認できません");

  start = Date.now();
  currentStage = "4";
  currentStarted = start;
  try {
  const passphrase = "架空の合言葉-" + stamp.slice(0, 12);
  sensitiveValues.add(passphrase);
  if ((await post(admin + "/space/" + project + "/open", { passphrase })).status !== 200) throw new Error("実行委員と班長のページを開けません");
  if ((await post(admin + "/projects/" + project + "/draft/duty_roster/start", {})).status !== 303) throw new Error("当番表の下書きを頼めません");
  const dutyResult = await waitForDraft(admin + "/projects/" + project + "/draft/duty_roster");
  const duty = dutyResult.form;
  if (!dutyResult.ready) {
    unfinished.push("当番表の下書き（AI依頼の完了待ちの上限）");
    process.exitCode = 1;
    if (!duty.fields.text?.trim()) duty.fields.text = "持ち場と時間帯を確認し、担当者を役員で記入してください。";
  }
  if ((await post(duty.action, duty.fields)).status !== 303) throw new Error("当番表の下書きを保存できません");
  const published = await publish(project, (await get(admin + "/publish/" + project)).html, "space");
  if (published.response.status !== 303) throw new Error("実行委員と班長のページに当番表を出せません");
  if ((await post(wardPath + "/space/" + project + "/enter", { passphrase })).status !== 303) throw new Error("実行委員と班長のページに入れません");
  const space = await get(wardPath + "/space/" + project);
  if (!space.response.ok || !space.html.includes("当番表")) throw new Error("実行委員と班長のページの当番表を読めません");
  checkDuty(await paper(published.printPath, "duty"));
  record("4", dutyResult.ready ? "通過" : "未完了", (dutyResult.ready ? "実行委員と班長のページを開き、AIの下書きを配って合言葉で読み取り。" : "AIの下書きは完了待ちの上限までに見えず、手書きの当番表を保存・配布して読み取り。") + " 当番表の紙に担当の名前を確認。", start);
  } catch (error) {
    const message = error instanceof Error ? error.message : "処理に失敗しました";
    record("4", message.startsWith("未完了:") ? "未完了" : "停止", message.replace(/^未完了:\s*/, ""), start);
    process.exitCode = 1;
  }

  if (publicPublished) try {
  start = Date.now();
  currentStage = "5";
  currentStarted = start;
  const rain = readForm((await get(admin + "/projects/" + project + "/draft/notice?edit=1")).html, "/draft/notice/save");
  rain.fields.text = "雨のため、会場を公民館のホールと集会室に変更します。日ときは予定どおりです。";
  if ((await post(rain.action, rain.fields)).status !== 303) throw new Error("雨のお知らせを保存できません");
  // 案内の本文を残し、別の知らせとして配る。
  if ((await publish(project, (await get(admin + "/publish/" + project)).html, "public", "知らせ")).response.status !== 303) throw new Error("雨の変更を知らせられません");
  const rainy = await get(publicPath);
  if (!rainy.response.ok || !rainy.html.includes("雨のため")) throw new Error("雨の変更が公開されていません");
  checkNoticeOrder(rainy.html, rain.fields.text, announcementText);
  record("5", "通過", "同じ公開ページで雨の知らせが配った案内より上にあることを確認。公式LINEは送信なし。", start);
  } catch (error) {
    const message = error instanceof Error ? error.message : "処理に失敗しました";
    record("5", "停止", message, start);
    process.exitCode = 1;
  }
  else skipStage("5", "公開版を確認できず、変更版を作れません");

  if (publicPublished) try {
  start = Date.now();
  currentStage = "6";
  currentStarted = start;
  if ((await post(admin + "/close/" + project + "/prepare", {})).status !== 303) throw new Error("閉じる前の準備に失敗");
  const closePath = admin + "/close/" + project;
  let closePage = await get(closePath);
  for (let i = 0; i < 200 && closePage.html.includes("準備中"); i++) {
    await new Promise(r => setTimeout(r, 3000));
    closePage = await get(closePath);
  }
  if (!closePage.html.includes("報告: できました") || !closePage.html.includes("段取り: できました")) throw new Error("未完了: 実施報告または段取りのAI下書きが待ちの上限までにできませんでした");
  const close = readForm(closePage.html, "/close/" + project + "/finalize");
  const staffReport = close.values.getAll("body")[1] ?? "";
  close.values.delete("body");
  close.values.append("body", "架空の秋の収穫祭を実施しました。雨会場に変更して開催しました。");
  close.values.append("body", staffReport);
  if ((await post(close.action, close.values)).status !== 303) throw new Error("閉じる操作に失敗");
  if (!(await get(wardPath + "/p/" + project)).html.includes("実施しました")) throw new Error("公開ページに実施報告がありません");
  const archive = await get(admin + "/archive/" + project);
  if (!archive.html.includes("これをもとに新しく始める")) throw new Error("記録から始める入口がありません");
  const seedPage = await get(admin + "/archive/" + project + "?view=seed");
  const seed = readForm(seedPage.html, "/archive/" + project + "/seed");
  seed.fields.title = "架空 秋の収穫祭 " + (new Date().getFullYear() + 1);
  seed.fields.year = String(new Date().getFullYear() + 1);
  seed.fields.eventDay = (new Date().getFullYear() + 1) + "-10-24";
  const next = await post(seed.action, seed.fields);
  const location = next.headers.get("location") ?? "";
  const nextId = new URL(location, base).searchParams.get("started");
  if (next.status !== 303 || !nextId || !(await get(location)).html.includes("去年の段取りを新しい日に置き直しました") || !(await get(admin + "/projects/" + nextId + "/map")).response.ok) throw new Error("記録から新しく始められません");
  record("6", "通過", "報告と来年への一言を一緒に保存して閉じ、記録から新しく始めた。", start);
  } catch (error) {
    const message = error instanceof Error ? error.message : "処理に失敗しました";
    record("6", message.startsWith("未完了:") ? "未完了" : "停止", message.replace(/^未完了:\s*/, ""), start);
    process.exitCode = 1;
  }
  else skipStage("6", "公開版を確認できず、閉じる段を進められません");
}
try {
  if (onlyPublic) await runPublic();
  else await runFull();
  console.log("記録: " + evidence);
} catch (error) {
  const message = error instanceof Error ? error.message : "処理に失敗しました";
  rows.push("| " + currentStage + " | 停止 | " + message.replaceAll("|", "／") + "（" + lastResponse.replaceAll("|", "／") + "） | " + Math.round((Date.now() - currentStarted) / 1000) + " |");
  writeFileSync(evidence, ["# staging通し確認", "", "- 区: " + ward, "- 資格情報: 値は記録していません", "- 一斉送信: 実送信なし", "", "| 段 | 結果 | 見えた物 | 秒 |", "|---|---|---|---:|", ...rows, ""].join("\n"), "utf8");
  console.error("停止: " + message);
  console.error("記録: " + evidence);
  process.exitCode = 1;
}
