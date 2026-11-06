// staging の役員画面と区のページを HTTP でたどり、項目ごとの結果を残す。
// 資格情報と作成した招待 URL は画面表示・記録に含めない。
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIRST_SLICE } from "../fixtures/first-slice.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const arg = (key: string) => { const index = args.indexOf(key); return index < 0 ? undefined : args[index + 1]; };
const ward = arg("--ward");
const baseArg = arg("--base");
const credsArg = arg("--creds");
const opsCredsArg = arg("--ops-creds");
if (!ward || !baseArg || !credsArg) {
  console.error("使い方: npm run walkthrough-rest -- --base <URL> --ward <区> --creds <役員の資格情報> [--ops-creds <運用の資格情報>]");
  process.exit(2);
}
if (ward === "demoku") {
  console.error("クロード区では通し確認を実行しません。確認用の区を指定してください。");
  process.exit(2);
}

const base = new URL(baseArg).toString().replace(/\/$/, "");
const origin = new URL(base).origin;
const wardPath = "/" + encodeURIComponent(ward);
const admin = wardPath + "/admin";
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const evidence = resolve(root, "docs/EVIDENCE/walkthrough-rest-" + stamp + ".md");
mkdirSync(dirname(evidence), { recursive: true });
const rows: string[] = [];
const cookies = new Map<string, { pair: string; path: string }>();
const sensitiveValues = new Set<string>();
let lastStatus: number | null = null;

function record(number: number, title: string, result: "通過" | "止まった" | "飛ばす", reason: string, status: number | null, start: number) {
  let safe = reason;
  for (const secret of sensitiveValues) if (secret) safe = safe.replaceAll(secret, "[伏せ字]");
  safe = safe.replaceAll("|", "／").replace(/[\r\n]+/g, " ");
  rows.push(`| ${number} | ${title} | ${result} | ${safe}${status === null ? "" : `（HTTP ${status}）`} | ${Math.round((Date.now() - start) / 1000)} |`);
  writeFileSync(evidence, [
    "# staging HTTP確認 " + new Date().toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }), "",
    "- 区: " + ward, "- 資格情報: 値は記録していません", "- 一斉送信: 実行なし（送らない選択）", "- 本物の住民への送信: なし", "",
    "| 項目 | 確認内容 | 結果 | 理由・応答 | 秒 |", "|---:|---|---|---|---:|", ...rows, ""
  ].join("\n"), "utf8");
  console.log(`${number}: ${result}`);
}
function skip(number: number, title: string, reason: string) { record(number, title, "飛ばす", reason, null, Date.now()); }
function fail(number: number, title: string, error: unknown, start: number) {
  const reason = error instanceof Error ? error.message : "処理に失敗しました";
  record(number, title, "止まった", reason, lastStatus, start);
  process.exitCode = 1;
}
function unescapeHtml(value: string) {
  return value.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}
async function req(path: string, init: RequestInit = {}, timeoutMs = 30_000) {
  const headers = new Headers(init.headers);
  headers.set("origin", origin);
  const url = new URL(path, base + "/");
  const applicable = [...cookies.values()].filter(cookie => url.pathname === cookie.path || url.pathname.startsWith(cookie.path.endsWith("/") ? cookie.path : cookie.path + "/"));
  if (applicable.length) headers.set("cookie", applicable.map(cookie => cookie.pair).join("; "));
  const response = await fetch(url, { ...init, headers, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  lastStatus = response.status;
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";", 1)[0];
    if (!pair) continue;
    const separator = pair.indexOf("=");
    if (separator > 0) {
      const pathValue = /(?:^|;)\s*path=([^;]+)/i.exec(line)?.[1] ?? url.pathname;
      cookies.set(pair.slice(0, separator), { pair, path: pathValue.replace(/\/$/, "") || "/" });
    }
  }
  return response;
}
async function post(path: string, values: Record<string, string> | URLSearchParams, timeoutMs = 30_000) {
  return req(path, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(values) }, timeoutMs);
}
async function get(path: string) {
  const response = await req(path);
  return { response, html: await response.text() };
}
function readForm(html: string, match: string, sectionTitle?: string) {
  for (const form of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const attrs = form[1] ?? "";
    const action = unescapeHtml(/\baction="([^"]*)"/i.exec(attrs)?.[1] ?? "");
    if (!action.includes(match)) continue;
    const sectionStart = html.lastIndexOf("<section", form.index ?? 0);
    if (sectionTitle && !html.slice(sectionStart, form.index).includes(sectionTitle)) continue;
    const fields: Record<string, string> = {};
    const values = new URLSearchParams();
    const body = form[2] ?? "";
    for (const input of body.matchAll(/<input\b([^>]*)>/gi)) {
      const attrs2 = input[1] ?? "";
      if (/type="(?:checkbox|radio)"/i.test(attrs2) && !/\bchecked(?:\s|=|$)/i.test(attrs2)) continue;
      const name = /\bname="([^"]*)"/i.exec(attrs2)?.[1];
      const type = /\btype="([^"]*)"/i.exec(attrs2)?.[1];
      if (name && type !== "file" && type !== "submit") {
        const value = unescapeHtml(/\bvalue="([^"]*)"/i.exec(attrs2)?.[1] ?? "");
        fields[name] = value; values.append(name, value);
      }
    }
    for (const field of body.matchAll(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi)) {
      const name = /\bname="([^"]*)"/i.exec(field[1] ?? "")?.[1];
      if (name) { fields[name] = unescapeHtml(field[2] ?? ""); values.append(name, fields[name]); }
    }
    for (const field of body.matchAll(/<select\b([^>]*)>([\s\S]*?)<\/select>/gi)) {
      const name = /\bname="([^"]*)"/i.exec(field[1] ?? "")?.[1];
      const options = [...(field[2] ?? "").matchAll(/<option\b([^>]*)>([\s\S]*?)<\/option>/gi)];
      const selected = options.find(option => /\bselected(?:\s|=|>)/i.test(option[1] ?? "")) ?? options[0];
      if (name && selected) fields[name] = unescapeHtml(/\bvalue="([^"]*)"/i.exec(selected[1] ?? "")?.[1] ?? selected[2] ?? "");
    }
    return { action, fields, values };
  }
  throw new Error("必要な入力欄を画面で確認できません");
}
function credentials(path: string) {
  const content = readFileSync(resolve(path), "utf8");
  const name = /^(?:名前|氏名|ID|ログインID)\s*[:：]\s*(.+)$/m.exec(content)?.[1]?.trim();
  const password = /^パスワード\s*[:：]\s*(.+)$/m.exec(content)?.[1]?.trim();
  if (!name || !password) throw new Error("資格情報の書式を読めません");
  sensitiveValues.add(name);
  sensitiveValues.add(password);
  return { name, password };
}
async function waitPage(path: string, done: (html: string) => boolean, failed: (html: string) => boolean = () => false) {
  const until = Date.now() + 360_000;
  let page = await get(path);
  while (Date.now() < until) {
    if (done(page.html)) return page;
    if (failed(page.html)) throw new Error("画面に処理の停止が表示されました");
    await new Promise(resolveWait => setTimeout(resolveWait, 3000));
    page = await get(path);
  }
  throw new Error("6分以内に完了を確認できませんでした");
}

let projectId = "";
let projectTitle = "";
let publicLive = false;
let sheetOriginal = "";
const sheetFilename = "架空の回答票_2班.jpg";
let opsLoggedIn = false;
let adminLoggedIn = false;
const startLogin = Date.now();
try {
  const { name, password } = credentials(credsArg);
  const login = await post(admin + "/login", { name, password });
  const home = await get(admin + "/");
  if (login.status !== 303 || !cookies.has("device") || !home.response.ok) throw new Error("役員画面に入れません");
  adminLoggedIn = true;
} catch (error) {
  fail(1, "新しい行事と案内", error, startLogin);
}

// 1. 新しいプロジェクトを開いて、手書きの案内を一度配る。
if (adminLoggedIn) {
  const start = Date.now();
  try {
    const opened = await post(admin + "/projects", { kind: "event", year: String(new Date().getFullYear()) });
    projectId = /\/projects\/([^/]+)\/map$/.exec(opened.headers.get("location") ?? "")?.[1] ?? "";
    if (opened.status !== 303 || !projectId) throw new Error("新しい行事を開けません");
    projectTitle = FIRST_SLICE.draftTitle + " " + stamp.slice(0, 13);
    const renamed = await post(admin + "/projects/" + projectId + "/title", { title: projectTitle });
    if (renamed.status !== 303) throw new Error("題を保存できません");
    const draftPath = admin + "/projects/" + projectId + "/draft/announcement";
    const draftPage = await get(draftPath);
    const draft = readForm(draftPage.html, "/draft/announcement/save");
    draft.fields.text = FIRST_SLICE.publicAnnouncement;
    const saved = await post(draft.action, draft.fields);
    if (saved.status !== 303) throw new Error("手書きの案内を保存できません");
    const publishPage = await get(admin + "/publish/" + projectId);
    const confirm = readForm(publishPage.html, "/publish/" + projectId + "/confirm");
    confirm.fields.lineDelivery = "skip";
    const check = await post(confirm.action, confirm.fields);
    const checkHtml = await check.text();
    if (!check.ok || !checkHtml.includes("今回は公式LINEに送りません")) throw new Error("送らない選択の確認へ進めません");
    const final = readForm(checkHtml, "/publish/" + projectId + "/send");
    if (final.fields.lineDelivery !== "skip") throw new Error("一斉送信を止める選択がありません");
    const distributed = await post(final.action, final.fields);
    if (distributed.status !== 303) throw new Error("案内を配れません");
    const publicPage = await get(wardPath + "/p/" + projectId);
    if (!publicPage.response.ok) throw new Error("配った案内を開けません");
    publicLive = true;
    record(1, "新しい行事と案内", "通過", "手書きの案内を保存し、公式LINEを送らない選択で配布", distributed.status, start);
  } catch (error) { fail(1, "新しい行事と案内", error, start); }
} else {
  for (const [number, title] of [[2,"回答票"],[3,"今やることと区の段取り"],[5,"実態の一枚"],[6,"言葉で下書きを直す"],[7,"当番表の編集"],[8,"対象者への配布"],[10,"予備の列"],[11,"行政の依頼と帳簿"],[12,"元の資料を消す"],[13,"引渡し"]] as const) skip(number, title, "役員画面に入れず、前提の行事がありません");
}

// 2. 架空の回答票を読み取り、役員が確認して確定する。
if (projectId && publicLive) {
  const start = Date.now();
  try {
    const fixture = resolve(root, "fixtures/this-year/answers/回答票_2班.jpg");
    const bytes = readFileSync(fixture);
    const form = new FormData();
    form.append("part", new Blob([bytes], { type: "image/jpeg" }), sheetFilename);
    form.append("text", ""); form.append("project_id", projectId);
    const sent = await req(admin + "/answers/" + projectId + "/sheet", { method: "POST", body: form });
    if (sent.status !== 303) throw new Error("回答票を送れません");
    const answerPath = admin + "/answers/" + projectId;
    const page = await waitPage(answerPath + "?view=list", html => html.includes("/sheet/") && html.includes("/row/0"), html => html.includes("読めませんでした"));
    const original = /\/answers\/[^/]+\/sheet\/([^/]+)\/row\/0/.exec(page.html)?.[1];
    if (!original) throw new Error("確認できる答え行がありません");
    sheetOriginal = original;
    const rowForm = readForm(page.html, "/answers/" + projectId + "/sheet/" + original + "/row/0");
    if (!["children_count", "adults_count", "seniors_count"].every(name => name in rowForm.fields)) throw new Error("人数の内訳の欄がありません");
    if (rowForm.fields.attend !== "yes" && rowForm.fields.attend !== "no") throw new Error("回答票の出欠の印を確認できません");
    const confirmed = await post(rowForm.action, rowForm.fields);
    if (confirmed.status !== 303) throw new Error("答え行を確定できません");
    const totals = await get(answerPath);
    const answerList = await get(answerPath + "?view=list");
    if (!totals.html.includes("参加する") || !answerList.html.includes("直して入れ直す")) throw new Error("入れた答えが一覧と集計に出ません");
    record(2, "回答票", "通過", "fixturesの回答票を読み取り、確認画面から一行を確定して一覧・集計を確認", confirmed.status, start);
  } catch (error) { fail(2, "回答票", error, start); }
} else skip(2, "回答票", "配布済みの案内がなく、回答票の対象がありません");

// 3. 今やることと区の地図で新しいプロジェクトを確認する。
if (projectId) {
  const start = Date.now();
  try {
    const [today, map] = await Promise.all([get(admin + "/projects/today"), get(admin + "/archive/map")]);
    if (!today.response.ok || !map.response.ok || !today.html.includes(projectTitle) || !map.html.includes(projectTitle)) throw new Error("今やることと区の段取りの両方に行事が見えません");
    record(3, "今やることと区の段取り", "通過", "役員画面の入口と区の段取りで新しい行事を確認", map.response.status, start);
  } catch (error) { fail(3, "今やることと区の段取り", error, start); }
} else skip(3, "今やることと区の段取り", "行事を開けませんでした");

// 4. 閉じた既存プロジェクトの検索と記録への質問。候補が無い時は記録を汚さず飛ばす。
if (!adminLoggedIn) skip(4, "全文索引と記録に聞く", "役員画面に入れず、閉じた記録を検索できません");
else {
  const start = Date.now();
  try {
    const archive = await get(admin + "/archive");
    if (!archive.response.ok || archive.html.includes("閉じた行事はまだありません")) {
      skip(4, "全文索引と記録に聞く", "区の記録に閉じた行事がありません");
    } else {
      const firstLink = [...archive.html.matchAll(/href="([^"]*\/archive\/[^"/?#]+)"/g)]
        .map(match => match[1] ?? "")
        .find(link => !/\/archive\/(?:map|search)$/.test(link));
      if (!firstLink) throw new Error("閉じた記録を開けません");
      const recordPage = await get(unescapeHtml(firstLink));
      const mapHtml = /<h2>段取り<\/h2>([\s\S]*?)<h2>配ったもの<\/h2>/.exec(recordPage.html)?.[1] ?? "";
      const term = unescapeHtml(/<h3>([^<]{3,})<\/h3>/.exec(mapHtml)?.[1] ?? "").trim();
      if (!term) throw new Error("検索語を記録から選べません");
      const search = await get(admin + "/archive/search?q=" + encodeURIComponent(term));
      if (!search.response.ok || !search.html.includes("見つかった記録") || search.html.includes("見つかりませんでした")) throw new Error("全文検索で記録が見つかりません");
      const ask = readForm(search.html, "/archive/ask");
      ask.fields.question = term + "について教えてください";
      const answer = await post(ask.action, ask.fields, 360_000);
      const answerHtml = await answer.text();
      if (!answer.ok || !answerHtml.includes("記録に聞く") || !answerHtml.includes("元の箇所")) throw new Error("答えと元の箇所を確認できません");
      record(4, "全文索引と記録に聞く", "通過", "閉じた記録の検索結果から元の資料へ戻り、質問の答えと根拠欄を確認", answer.status, start);
    }
  } catch (error) { fail(4, "全文索引と記録に聞く", error, start); }
}

// 5. 活動紹介を保存し、閉じた後に掲載する。後続の確認のため開き直す。
if (!projectId) skip(5, "実態の一枚", "前提の行事を開けませんでした");
else {
  const start = Date.now();
  try {
    const path = admin + "/close/" + projectId;
    const page = await get(path + "?view=activity");
    if (!page.response.ok) throw new Error("役員の仕事を紹介する画面を開けません");
    const form = readForm(page.html, path + "/activity");
    form.fields.introduction = "会場の予約と案内を役員が受け持ちました（架空）。";
    form.fields.membershipBurden = "年に一度の当番があります（架空）。";
    form.fields.membershipBenefit = "行事の案内が届きます（架空）。";
    const taskId = /<input\b[^>]*name="taskId"[^>]*value="([^"]*)"/i.exec(page.html)?.[1];
    if (taskId) form.fields.taskId = unescapeHtml(taskId);
    form.fields.action = "save";
    const saved = await post(form.action, form.fields);
    if (saved.status !== 303 || saved.headers.get("location") !== path + "?view=activity&activity=saved") throw new Error("活動紹介の下書きを保存できません");
    const closePage = await get(path);
    const close = readForm(closePage.html, path + "/finalize");
    const closed = await post(close.action, close.values);
    if (closed.status !== 303) throw new Error("確認用の行事を閉じられません");
    try {
      const closedPage = await get(path + "?view=activity");
      const publish = readForm(closedPage.html, path + "/activity");
      publish.fields.action = "publish";
      if (taskId) publish.fields.taskId = unescapeHtml(taskId);
      const published = await post(publish.action, publish.fields);
      if (published.status !== 303 || published.headers.get("location") !== path + "?view=activity&activity=published") throw new Error("活動紹介を区のページに載せられません");
      const publicPage = await get(wardPath + "/work/" + projectId);
      if (!publicPage.response.ok || !publicPage.html.includes(form.fields.introduction) || !publicPage.html.includes(form.fields.membershipBurden) || !publicPage.html.includes(form.fields.membershipBenefit)) throw new Error("載せた活動紹介を区のページで確認できません");
    } finally {
      const closedPage = await get(path);
      const reopen = readForm(closedPage.html, path + "/reopen");
      const reopened = await post(reopen.action, reopen.fields);
      if (reopened.status !== 303) throw new Error("後続の確認用に行事を開き直せません");
    }
    record(5, "実態の一枚", "通過", "架空の活動紹介を保存し、閉じたあとに区のページで載せる内容を確認。後続の確認用に開き直した", saved.status, start);
  } catch (error) { fail(5, "実態の一枚", error, start); }
}

// 6. AI に短い指示を出し、案の変化を最大6分待つ。
if (projectId) {
  const start = Date.now();
  try {
    const path = admin + "/projects/" + projectId + "/draft/announcement";
    const before = await get(path);
    const oldText = /<textarea[^>]*name="text"[^>]*>([\s\S]*?)<\/textarea>/i.exec(before.html)?.[1] ?? "";
    const form = readForm(before.html, "/draft/announcement/start");
    form.fields.instruction = "本文に『集合場所は" + FIRST_SLICE.previousPlace + "です』を一文加えてください。";
    const queued = await post(form.action, form.fields);
    if (queued.status !== 303) throw new Error("下書きの修正を頼めません");
    const after = await waitPage(path, html => /data-ai-status="done"/.test(html) && /<textarea[^>]*name="text"[^>]*>([\s\S]*?)<\/textarea>/i.exec(html)?.[1] !== oldText, html => /data-ai-status="(?:failed|attention)"/.test(html));
    if (!after.html.includes(FIRST_SLICE.previousPlace)) throw new Error("指示した一文を含む下書きになっていません");
    record(6, "言葉で下書きを直す", "通過", "一文の指示したあとに下書きの変化を確認", after.response.status, start);
  } catch (error) { fail(6, "言葉で下書きを直す", error, start); }
} else skip(6, "言葉で下書きを直す", "行事を開けませんでした");

// 7. 確認用の行事に架空の当番資料を入れ、その一行を編集して読み返す。
if (projectId) {
  const start = Date.now();
  try {
    const filename = "架空の当番_" + stamp + ".txt";
    const material = new FormData();
    material.set("project_id", projectId);
    material.append("part", new Blob([`${new Date().getFullYear()}年「${projectTitle}」の当番表。通し確認用の架空資料です。\n時間帯:10:00-11:00\n持ち場:受付\n担当:架空確認担当\nこの内容で今年の当番を決めました。`], { type: "text/plain" }), filename);
    material.append("part_kind", "file");
    const sent = await req(admin + "/intake", { method: "POST", headers: { accept: "application/json" }, body: material });
    const receipt = await sent.json().catch(() => null) as { ok?: boolean; jobId?: string | null; duplicates?: number } | null;
    if (!sent.ok || !receipt?.ok || !receipt.jobId && !receipt.duplicates) throw new Error("架空の当番資料を送れません");
    if (receipt.jobId) {
      const state = (html: string) => { const pos = html.indexOf(filename); return pos < 0 ? "" : html.slice(pos, pos + 900); };
      await waitPage(admin + "/intake/received?project=" + encodeURIComponent(projectId),
        html => state(html).includes("行事に入れました"),
        html => /読めませんでした|読み取りが遅れています/.test(state(html)));
    }
    const path = admin + "/projects/" + projectId + "/draft/duty_roster";
    const page = await get(path);
    const fixture = [...page.html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/gi)].find(form => form[0].includes("/draft/duty-row/") && form[0].includes("架空確認担当"))?.[0];
    if (!page.response.ok || !fixture) throw new Error("架空資料の当番の行が見えません");
    const form = readForm(fixture, "/draft/duty-row/");
    form.fields.task = (form.fields.task ?? "") + "（確認）";
    const saved = await post(form.action, form.fields);
    if (saved.status !== 303) throw new Error("当番表の行を保存できません");
    const after = await get(path);
    if (!after.response.ok || readForm(after.html, form.action).fields.task !== form.fields.task) throw new Error("当番表の編集内容が保存されていません");
    record(7, "当番表の編集", "通過", "架空資料の当番の一行を用意し、編集して保存後の内容を読み返した", saved.status, start);
  } catch (error) { fail(7, "当番表の編集", error, start); }
} else skip(7, "当番表の編集", "行事を開けませんでした");

// 8. 名簿から一世帯を選び、配る内容の確認画面まで進む。配る操作は行わない。
if (!projectId) skip(8, "対象者への配布", "前提の行事を開けませんでした");
else {
  const start = Date.now();
  try {
    const page = await get(admin + "/publish/" + projectId);
    if (!page.response.ok) throw new Error("配布画面を開けません");
    const entry = readForm(page.html, "/publish/" + projectId + "/confirm");
    entry.fields.lineDelivery = "skip";
    entry.fields.recipientScope = "member_households";
    let preview = await post(entry.action, entry.fields);
    if (!preview.ok) throw new Error("配る内容を開けません");
    let previewHtml = await preview.text();
    const firstHousehold = (html: string) => /<input\b[^>]*name="household"[^>]*value="([^"]*)"/i.exec(html)?.[1];
    if (!firstHousehold(previewHtml)) {
      const imported = await req(admin + "/answers/roster", { method: "POST", headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ rows_json: JSON.stringify([["代表者のお名前", "班"], ["架空確認世帯", "架空確認班"]]), household_column: 0, district_column: 1 }) });
      const result = await imported.json().catch(() => null) as { ok?: boolean } | null;
      if (!imported.ok || !result?.ok) throw new Error("架空の名簿を用意できません");
      preview = await post(entry.action, entry.fields);
      if (!preview.ok) throw new Error("名簿を入れたあとに配る内容を開けません");
      previewHtml = await preview.text();
    }
    const household = firstHousehold(previewHtml);
    if (!household) throw new Error("名簿を用意しても選べる世帯がありません");
    const form = readForm(previewHtml, "/publish/" + projectId + "/send");
    form.action = entry.action;
    form.fields.household = unescapeHtml(household);
    form.fields.targetMode = "household";
    form.fields.lineDelivery = "skip";
    const confirm = await post(form.action, form.fields);
    const html = await confirm.text();
    const target = JSON.parse(form.fields.household) as [string, string];
    if (!confirm.ok || !unescapeHtml(html).includes(target.join(" / ")) || !html.includes("今回は公式LINEに送りません")) throw new Error("選んだ世帯への紙の配布先を確認できません");
    record(8, "対象者への配布", "通過", "名簿を用意して一世帯を選び、紙の配布先と公式LINEに送らない選択を確認。配る操作は実行していない", confirm.status, start);
  } catch (error) { fail(8, "対象者への配布", error, start); }
}

// 9. 住民からの問い合わせ入口が提供されているか確認する。LINE 署名が要る経路は使わない。
{
  const start = Date.now();
  try {
    const wardPage = await get(wardPath + "/");
    if (/action="[^"]*(?:inquir|contact|request)/i.test(wardPage.html)) skip(9, "問い合わせ", "住民向けのHTTP問い合わせ入口を画面で確認できません（LINE署名が要る経路は対象外）");
    else skip(9, "問い合わせ", "住民向け問い合わせ画面がありません。役員の記録フォームは住民側の入口ではありません");
  } catch (error) { fail(9, "問い合わせ", error, start); }
}

// 10. 専用の予備経路画面がある場合だけ開く。通常の手入力欄とは区別する。
if (!projectId) skip(10, "予備の列", "前提の行事を開けませんでした");
else skip(10, "予備の列", "役員画面に予備経路の専用画面はなく、通常の手入力画面です");

// 11. 行政依頼・帳簿の入力画面を読み、未提出のまま保存する。
if (!adminLoggedIn) skip(11, "行政の依頼と帳簿", "役員画面に入れず、行政依頼を保存できません");
else {
  const start = Date.now();
  try {
    const opened = await post(admin + "/projects", { kind: "city_request", year: String(new Date().getFullYear()) });
    const cityId = /\/projects\/([^/]+)\/map$/.exec(opened.headers.get("location") ?? "")?.[1];
    if (opened.status !== 303 || !cityId) throw new Error("行政の依頼行事を開けません");
    const cityPath = admin + "/requests/city/" + cityId;
    const cityPage = await get(cityPath);
    if (!cityPage.response.ok) throw new Error("行政の依頼画面を開けません");
    const cityForm = readForm(cityPage.html, "/requests/city/" + cityId);
    cityForm.fields.answerDraft = FIRST_SLICE.reportText;
    cityForm.fields.operation = "save";
    const citySaved = await post(cityForm.action, cityForm.fields);
    if (citySaved.status !== 303) throw new Error("行政の依頼を保存できません");
    const cityResultPath = citySaved.headers.get("location");
    if (!cityResultPath || !(await get(cityResultPath)).html.includes("記録しました")) throw new Error("行政の依頼を保存したあとの案内を開けません");
    const cityReadback = await get(cityPath);
    if (!cityReadback.html.includes(FIRST_SLICE.reportText)) throw new Error("行政の依頼の保存内容を読み返せません");
    const ledgerPage = await get(admin + "/ledger");
    if (!ledgerPage.response.ok || !ledgerPage.html.includes("帳簿")) throw new Error("帳簿を開けません");
    const ledgerForm = readForm(ledgerPage.html, "/ledger");
    ledgerForm.fields.settlementDraft = FIRST_SLICE.reportText;
    const ledgerSaved = await post(ledgerForm.action, ledgerForm.fields);
    if (ledgerSaved.status !== 303) throw new Error("帳簿を保存できません");
    const ledgerResultPath = ledgerSaved.headers.get("location");
    if (!ledgerResultPath || !(await get(ledgerResultPath)).html.includes("保存しました")) throw new Error("帳簿を保存したあとの案内を開けません");
    const ledgerReadback = await get(admin + "/ledger");
    if (!ledgerReadback.html.includes(FIRST_SLICE.reportText)) throw new Error("帳簿の保存内容を読み返せません");
    record(11, "行政の依頼と帳簿", "通過", "架空の行政依頼と帳簿の下書きを保存し、帳簿を読み返した。提出操作なし", ledgerReadback.response.status, start);
  } catch (error) { fail(11, "行政の依頼と帳簿", error, start); }
}

// 12. この通しの回答票の記録を「消す求め」から受け付ける。消去完了は待たない。
if (!projectId) skip(12, "元の資料を消す", "前提の行事を開けませんでした");
else {
  const start = Date.now();
  try {
    if (!sheetOriginal) skip(12, "元の資料を消す", "この通しで受け取った回答票の元の資料がありません");
    else {
      const page = await get(admin + "/settings/deletion");
      if (!page.response.ok) throw new Error("消す求めの画面を開けません");
      const section = [...page.html.matchAll(/<section\b[^>]*>[\s\S]*?<\/section>/gi)]
        .map(match => match[0]).find(html => unescapeHtml(html).includes(projectTitle) && unescapeHtml(html).includes(sheetFilename));
      if (!section) throw new Error("今回の行事の回答票を消す求めで選べません");
      const form = readForm(section, admin + "/settings/deletion/");
      const queued = await post(form.action, form.fields);
      const location = queued.headers.get("location");
      if (queued.status !== 303 || location !== admin + "/settings/deletion?queued=1") throw new Error("元の資料の消去を受け付けられません");
      const accepted = await get(location);
      if (!accepted.response.ok || !accepted.html.includes("消去を受け付けました。処理は続きから進みます。")) throw new Error("元の資料の消去の受付を確認できません");
      record(12, "元の資料を消す", "通過", "今回の回答票の記録を区の設定の消す求めから受け付けた。消去完了は未確認", accepted.response.status, start);
    }
  } catch (error) { fail(12, "元の資料を消す", error, start); }
}

// 13. 架空の役員アカウントを足し、新しい資格でログインする。資格情報は表示・記録しない。
if (!projectId) skip(13, "引渡し", "前提の行事を開けませんでした");
else {
  const start = Date.now();
  try {
    const peoplePage = await get(admin + "/settings/people");
    if (!peoplePage.response.ok) throw new Error("役員の一覧を開けません");
    const testName = FIRST_SLICE.firstOfficer + " " + stamp;
    const created = await post(admin + "/settings/people/accounts", { name: testName, seatId: "" });
    const credentialsHtml = await created.text();
    const loginId = unescapeHtml(/ID:\s*<strong>([^<]+)<\/strong>/.exec(credentialsHtml)?.[1] ?? "");
    const password = unescapeHtml(/<p class="secret">([^<]+)<\/p>/.exec(credentialsHtml)?.[1] ?? "");
    if (created.status !== 201 || !loginId || !password) throw new Error("新しい役員資格を作れません");
    sensitiveValues.add(loginId);
    sensitiveValues.add(password);
    cookies.clear();
    const login = await post(admin + "/login", { loginId, password });
    const newAccountHome = await get(admin + "/");
    if (login.status !== 303 || !cookies.has("device") || !newAccountHome.response.ok || !newAccountHome.html.includes(testName)) throw new Error("新しい資格で役員画面に入れません");
    record(13, "引渡し", "通過", "架空の役員アカウントを足し、新しい資格で入る。資格値は表示・記録していない", newAccountHome.response.status, start);
  } catch (error) { fail(13, "引渡し", error, start); }
}

// 14. 運用資格が渡された場合だけ費用画面を開く。
if (opsCredsArg) {
  const start = Date.now();
  try {
    cookies.clear();
    const { name, password } = credentials(opsCredsArg);
    const login = await post("/ops/login", { id: name, password });
    const home = await get("/ops/");
    if (login.status !== 303 || !home.response.ok) throw new Error("運用の画面に入れません");
    opsLoggedIn = true;
    const costs = await get("/ops/wards/" + encodeURIComponent(ward) + "/costs");
    if (!costs.response.ok || !/費用|\$|円|USD|入力\s*\d/.test(costs.html)) throw new Error("費用の画面または数字を確認できません");
    const numberMatch = /(?:費用|合計)[^<]{0,40}(?:\$|¥)?\s*[0-9][0-9,.]*/.exec(costs.html);
    if (!numberMatch) throw new Error("費用画面に数字が見つかりません");
    record(14, "運用の費用", "通過", "運用画面の区別費用を開き、数値表示を確認", costs.response.status, start);
  } catch (error) { fail(14, "運用の費用", error, start); }
} else skip(14, "運用の費用", "--ops-credsがありません");

if (opsLoggedIn) await post("/ops/logout", {});
console.log("記録: " + evidence);
